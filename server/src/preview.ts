import dns from 'node:dns/promises';
import net from 'node:net';

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^192\.0\.0\./,
  /^198\.1[89]\./,
  /^2(2[4-9]|[3-5]\d)\./, // multicast, reserved, broadcast
];

async function isPrivateHost(rawHost: string, signal?: AbortSignal): Promise<boolean> {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  try {
    const lookup = dns.lookup(host, { all: true });
    const addrs = signal ? await new Promise<Awaited<typeof lookup>>((resolve, reject) => {
      const aborted = () => reject(new Error('preview lookup timed out'));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      void lookup.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    }) : await lookup;
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return true; // can't resolve → don't fetch
  }
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return (
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80') ||
      lower === '::'
    );
  }
  return PRIVATE_V4.some((re) => re.test(ip));
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
    const n = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : whole;
  });
}

function metadata(html: string): Map<string, string> {
  const values = new Map<string, string>();
  // Quotes may contain apostrophes, > signs and newlines; attribute order,
  // whitespace around '=' and unquoted HTML attributes are all legal.
  for (const tag of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of tag[0].slice(5, -1).matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
      attrs.set(a[1]!.toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? '').trim());
    }
    const key = attrs.get('property') ?? attrs.get('name');
    const value = attrs.get('content');
    if (key && value && !values.has(key.toLowerCase())) values.set(key.toLowerCase(), value);
  }
  return values;
}

function imageUrl(raw: string | undefined, base: URL): string | undefined {
  if (!raw) return undefined;
  try {
    const image = new URL(raw, base);
    return ['http:', 'https:'].includes(image.protocol) ? image.href : undefined;
  } catch { return undefined; }
}

function youtubeVideo(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be', 'www.youtu.be'].includes(host)) return null;
  const id = host.endsWith('youtu.be') ? url.pathname.split('/')[1] :
    url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[1];
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

async function boundedText(res: Response, maxBytes = 200_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = ''; let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, maxBytes - bytes);
      text += decoder.decode(part, { stream: true }); bytes += part.byteLength;
    }
    return text + decoder.decode();
  } finally { void reader.cancel().catch(() => {}); }
}

async function youtubePreview(video: string, original: URL, signal: AbortSignal): Promise<LinkPreview | null> {
  // The video service's public oEmbed metadata avoids consent/JavaScript-only
  // watch pages. The destination is fixed, not supplied by the caller.
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('url', `https://www.youtube.com/watch?v=${video}`);
  endpoint.searchParams.set('format', 'json');
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
    if (await isPrivateHost(endpoint.hostname, deadline)) return null;
    const response = await fetch(endpoint, { signal: deadline, redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'Hearth/0.1 (+link preview)' } });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return null; }
    const data = JSON.parse(await boundedText(response, 32_000)) as { title?: unknown; thumbnail_url?: unknown; provider_name?: unknown };
    if (typeof data.title !== 'string' || !data.title.trim()) return null;
    return { url: original.href, title: data.title.trim().slice(0, 300), siteName: 'YouTube', image: imageUrl(typeof data.thumbnail_url === 'string' ? data.thumbnail_url : undefined, endpoint) };
  } catch { return null; }
}

/**
 * Fetch Open Graph tags for a link dropped into chat. Refuses private hosts
 * (SSRF guard) and caps the response size.
 */
export async function fetchPreview(rawUrl: string): Promise<LinkPreview | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    if (await isPrivateHost(url.hostname, controller.signal)) return null;
    const video = youtubeVideo(url);
    if (video) {
      const preview = await youtubePreview(video, url, controller.signal);
      if (preview) return preview;
    }
    // Follow redirects by hand so every hop is checked against the private-host guard.
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop += 1) {
      res = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'Hearth/0.1 (+link preview)', accept: 'text/html,*/*' },
      });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get('location');
      res.body?.cancel().catch(() => {});
      if (!loc) return null;
      try {
        url = new URL(loc, url);
      } catch {
        return null;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (await isPrivateHost(url.hostname, controller.signal)) return null;
      res = null;
    }
    if (!res || !res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) { void res.body?.cancel().catch(() => {}); return null; }
    const html = await boundedText(res);
    const tags = metadata(html);

    const title =
      tags.get('og:title') ??
      tags.get('twitter:title') ??
      decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '');
    return {
      url: url.toString(),
      title: title ? title.trim().slice(0, 300) : undefined,
      description:
        (tags.get('og:description') ?? tags.get('twitter:description') ?? tags.get('description'))?.slice(0, 500),
      image: imageUrl(tags.get('og:image:secure_url') ?? tags.get('og:image') ?? tags.get('twitter:image') ?? tags.get('twitter:image:src'), url),
      siteName: tags.get('og:site_name') ?? url.hostname,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
