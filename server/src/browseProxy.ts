import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/**
 * The page fetcher behind Hearth's built-in browser. A web page cannot simply be shown in a frame (most sites forbid it), so the server fetches
 * it, strips what forbids framing, and hands it to a sandboxed frame. Because it fetches for whoever is signed in, it is careful:
 *  - only http and https, only ordinary ports, no sign-in details in the address;
 *  - every address the name resolves to, at the moment of connecting, is checked: nothing on this machine, this network or a reserved range is
 *    ever contacted (so it cannot be used to poke at the NAS or anything else at home), and the same check is repeated for each redirect;
 *  - small limits on time and size, and a per-person rate limit.
 * It keeps no cookies and sends none of the visitor's.
 */
/** Read each time, so the admin panel can switch the proxy on and off without a restart. */
export const browseEnabled = (): boolean => (process.env.BROWSE_PROXY ?? 'on').toLowerCase() !== 'off';
const MAX_HTML = 6 * 1024 * 1024;
const MAX_FILE = 25 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const PORTS = new Set([80, 443, 8080, 8443]);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 HearthBrowser';

export class BrowseError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function v4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
}

/** Addresses that must never be fetched: this machine, private networks, link-local (including cloud metadata), reserved and multicast ranges. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = v4Parts(ip);
  if (v4) {
    const [a, b, c] = v4 as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (!net.isIPv6(s)) return true; // not an address at all: refuse
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isPrivateAddress(mapped[1]!);
  const hexMapped = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (s === '::' || s === '::1') return true;
  const first = parseInt(s.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 || // multicast
    s.startsWith('2001:db8') // documentation
  );
}

/** An address the browser may be sent to, or a BrowseError saying why not. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BrowseError('That is not a web address.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BrowseError('Only http and https addresses can be opened.');
  if (u.username || u.password) throw new BrowseError('Addresses with a sign-in inside them are not opened.');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!PORTS.has(port)) throw new BrowseError('That port is not opened.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) throw new BrowseError('That address is on a private network.', 403);
  if (net.isIP(host) && isPrivateAddress(host)) throw new BrowseError('That address is on a private network.', 403);
  return u;
}

/** A DNS lookup that refuses private answers, used for the actual connection so a name cannot change its mind between the check and the connect. */
function guardedLookup(hostname: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = (addresses as dns.LookupAddress[]).filter((a) => !isPrivateAddress(a.address));
    if (!list.length) return cb(new BrowseError('That address is on a private network.', 403));
    if (options.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

export interface Fetched {
  status: number;
  /** The address finally reached, after redirects. */
  url: URL;
  contentType: string;
  body: Buffer;
}

function decode(buf: Buffer, encoding: string | undefined): Buffer {
  const e = (encoding ?? '').toLowerCase();
  if (e === 'gzip' || e === 'x-gzip') return zlib.gunzipSync(buf);
  if (e === 'deflate') return zlib.inflateSync(buf);
  if (e === 'br') return zlib.brotliDecompressSync(buf);
  return buf;
}

function once(u: URL, method: string, body: Buffer | null, headers: Record<string, string>): Promise<{ res: http.IncomingMessage; chunks: Buffer[]; size: number }> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method, headers, lookup: guardedLookup as never, timeout: TIMEOUT_MS, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const type = String(res.headers['content-type'] ?? '').toLowerCase();
        const limit = type.startsWith('text/html') || type.includes('xhtml') ? MAX_HTML : MAX_FILE;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > limit) {
            req.destroy(new BrowseError('That page is too big.', 413));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ res, chunks, size }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new BrowseError('The site took too long to answer.', 504)));
    req.on('error', (e) => reject(e instanceof BrowseError ? e : new BrowseError('The site could not be reached.', 502)));
    if (body) req.write(body);
    req.end();
  });
}

/** Fetch a page for the browser, following redirects by hand so each hop is checked. */
export async function fetchPage(raw: string, opts: { post?: Array<[string, string]>; language?: string } = {}): Promise<Fetched> {
  let u = checkUrl(raw);
  let method = opts.post ? 'POST' : 'GET';
  let body: Buffer | null = opts.post ? Buffer.from(new URLSearchParams(opts.post).toString()) : null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8',
      'accept-language': opts.language || 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      host: u.host,
    };
    if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = String(body.length);
    }
    const { res, chunks } = await once(u, method, body, headers);
    const status = res.statusCode ?? 502;
    if (status >= 300 && status < 400 && res.headers.location) {
      u = checkUrl(new URL(String(res.headers.location), u).href);
      if (status !== 307 && status !== 308) { method = 'GET'; body = null; }
      continue;
    }
    let buf: Buffer = Buffer.concat(chunks);
    try {
      buf = decode(buf, res.headers['content-encoding'] as string | undefined);
    } catch {
      throw new BrowseError('The site sent something that could not be read.', 502);
    }
    return { status, url: u, contentType: String(res.headers['content-type'] ?? 'application/octet-stream'), body: buf };
  }
  throw new BrowseError('Too many redirects.', 508);
}

/** The text of a page in the character set it declares. */
export function textOf(f: Fetched): string {
  const fromHeader = /charset=([\w-]+)/i.exec(f.contentType)?.[1];
  const head = f.body.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  const charset = (fromHeader || fromMeta || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(f.body);
  } catch {
    return new TextDecoder('utf-8').decode(f.body);
  }
}

/**
 * What runs inside the page: it keeps links and forms inside the browser (it tells the window where the visitor wants to go instead of leaving),
 * and reports the page's title. It has no access to Hearth: the frame is sandboxed without its origin.
 */
export function helperScript(finalUrl: string): string {
  return `(function(){
var P=window.parent;
function abs(u){try{return new URL(u,document.baseURI).href}catch(e){return null}}
function send(m){m.hearthBrowser=1;P.postMessage(m,'*')}
document.addEventListener('click',function(e){
  if(e.defaultPrevented)return;
  var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;
  var h=a.getAttribute('href');
  if(!h||h.charAt(0)==='#'||/^(javascript|mailto|tel|data|blob):/i.test(h)||a.hasAttribute('download'))return;
  var u=abs(h);if(!u)return;
  e.preventDefault();send({type:'nav',url:u,newTab:!!(e.ctrlKey||e.metaKey||a.target==='_blank')});
},true);
document.addEventListener('submit',function(e){
  var f=e.target;if(e.defaultPrevented||!f||!f.getAttribute)return;e.preventDefault();
  var m=(f.getAttribute('method')||'get').toLowerCase();var act=abs(f.getAttribute('action')||'')||document.baseURI;
  var pairs=[];try{new FormData(f).forEach(function(v,k){if(typeof v==='string')pairs.push([k,v])})}catch(x){}
  if(e.submitter&&e.submitter.name)pairs.push([e.submitter.name,e.submitter.value||'']);
  if(m==='post'){send({type:'post',url:act,fields:pairs})}
  else{var u=new URL(act);pairs.forEach(function(p){u.searchParams.set(p[0],p[1])});send({type:'nav',url:u.href})}
},true);
window.open=function(u){var x=abs(u);if(x)send({type:'nav',url:x,newTab:true});return null};
function title(){send({type:'loaded',url:${JSON.stringify(finalUrl)},title:document.title||''})}
if(document.readyState==='complete')title();else window.addEventListener('load',title);
})();`;
}

/** Turn a fetched page into one that can be shown in the sandboxed frame. */
export function rewriteHtml(html: string, finalUrl: string): string {
  let out = html
    // pages that forbid framing or scripts of ours, or leave the browser by themselves
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?(content-security-policy|x-frame-options|refresh)["']?[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  const safeUrl = finalUrl.replace(/"/g, '%22');
  const inject = `<meta charset="utf-8"><base href="${safeUrl}"><meta name="referrer" content="no-referrer"><script>${helperScript(finalUrl).replace(/<\/script/gi, '<\\/script')}</script>`;
  const head = /<head\b[^>]*>/i.exec(out);
  if (head) out = out.slice(0, head.index + head[0].length) + inject + out.slice(head.index + head[0].length);
  else out = `<!doctype html><html><head>${inject}</head><body>${out}</body></html>`;
  return out;
}

const buckets = new Map<string, { tokens: number; at: number }>();
export const BROWSE_BURST = 40;
export const BROWSE_REFILL_MS = 1000;

/** True when this person may fetch another page now (a burst of 40, then one a second). */
export function allowBrowse(userId: string, now: number = Date.now()): boolean {
  const b = buckets.get(userId) ?? { tokens: BROWSE_BURST, at: now };
  const tokens = Math.min(BROWSE_BURST, b.tokens + Math.max(0, now - b.at) / BROWSE_REFILL_MS);
  if (tokens < 1) {
    buckets.set(userId, { tokens, at: now });
    return false;
  }
  buckets.set(userId, { tokens: tokens - 1, at: now });
  return true;
}
