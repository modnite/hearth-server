// Opens this server's ports on the router by itself (UPnP), for people whose router offers it and who would rather not do it by hand.
// Off unless you start it: `docker compose --profile upnp up -d`. It must run on the host network to see the router, which compose.yml arranges.
//
//   UPNP_PORTS="7882/udp,7881/tcp,443/tcp"   what to open (the default is what calls need)
//
// Mappings last an hour and are renewed every half hour, so they go away by themselves if this stops. Plain Node, no packages.
import dgram from 'node:dgram';
import http from 'node:http';
import { URL } from 'node:url';

const PORTS = (process.env.UPNP_PORTS || '7882/udp,7881/tcp').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
  const [port, proto] = p.split('/');
  return { port: Number(port), proto: (proto || 'tcp').toUpperCase() };
});
const SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];

/** The SOAP envelope for one call to the router. */
export function soap(service, action, args) {
  const body = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${body}</u:${action}></s:Body></s:Envelope>`;
}

/** The control address of a connection service in the router's description file, or null. */
export function controlUrl(xml, service) {
  const at = xml.indexOf(`<serviceType>${service}</serviceType>`);
  if (at < 0) return null;
  const m = /<controlURL>([^<]+)<\/controlURL>/.exec(xml.slice(at));
  return m ? m[1].trim() : null;
}

function discover() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const found = [];
    const done = () => { try { sock.close(); } catch { /* closed */ } resolve(found[0] ?? null); };
    sock.on('message', (msg) => {
      const m = /^location:\s*(\S+)/im.exec(msg.toString());
      if (m && !found.includes(m[1])) found.push(m[1]);
    });
    sock.on('error', done);
    sock.bind(0, () => {
      for (const st of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2']) {
        const q = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        sock.send(q, 1900, '239.255.255.250');
      }
    });
    setTimeout(done, 3000);
  });
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data, local: req.socket.localAddress }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function openPorts() {
  const location = await discover();
  if (!location) return console.log('[upnp] no router answered; UPnP may be off on it');
  const desc = await request(location);
  const base = new URL(location);
  for (const service of SERVICES) {
    const path = controlUrl(desc.text, service);
    if (!path) continue;
    const control = new URL(path, base).toString();
    for (const { port, proto } of PORTS) {
      const res = await request(control, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${service}#AddPortMapping"` },
        body: soap(service, 'AddPortMapping', {
          NewRemoteHost: '', NewExternalPort: port, NewProtocol: proto, NewInternalPort: port, NewInternalClient: desc.local,
          NewEnabled: 1, NewPortMappingDescription: 'Hearth', NewLeaseDuration: 3600,
        }),
      }).catch((e) => ({ status: 0, text: String(e) }));
      console.log(`[upnp] ${port}/${proto} -> ${desc.local}: ${res.status === 200 ? 'open' : `refused (${res.status})`}`);
    }
    return;
  }
  console.log('[upnp] the router has no port mapping service');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  for (;;) {
    await openPorts().catch((e) => console.log(`[upnp] ${e.message}`));
    await new Promise((r) => setTimeout(r, 30 * 60_000));
  }
}
