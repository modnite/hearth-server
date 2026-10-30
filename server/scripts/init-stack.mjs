// Runs once before the server and LiveKit start (the "init" service in compose.yml). It makes the stack configure itself:
//
//   - LiveKit's key and secret, made once and kept in the shared volume, so there is no .env to fill in
//   - LiveKit's configuration, with this machine's public address when it can be found
//
// The server reads the same keys from the shared volume. Safe to run again: nothing that exists is changed except the config, which is
// rendered fresh each time (so a changed public address is picked up by running `docker compose up -d` again).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.SHARED_DIR || '/shared';
fs.mkdirSync(dir, { recursive: true });

const keysFile = path.join(dir, 'livekit.keys');
let secret = '';
try {
  secret = fs.readFileSync(keysFile, 'utf8').split(':').slice(1).join(':').trim();
} catch { /* first run */ }
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keysFile, `hearth: ${secret}\n`, { mode: 0o644 });
  console.log('[init] made the LiveKit key');
}

const udpStart = Number(process.env.LIVEKIT_UDP_RANGE_START || 50100);
const udpEnd = Number(process.env.LIVEKIT_UDP_RANGE_END || 50199);
const tcpPort = Number(process.env.LIVEKIT_TCP_PORT || 7881);

const isIp = (v) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v) || /^[0-9a-fA-F:]+$/.test(v);
let ip = (process.env.PUBLIC_IP || '').trim();
if (!ip) {
  // A plain HTTPS request to learn the address the internet sees this machine at (never STUN).
  try {
    const res = await fetch(process.env.PUBLIC_IP_URL || 'https://api.ipify.org', { signal: AbortSignal.timeout(8000) });
    ip = (await res.text()).trim();
  } catch { /* offline or blocked: calls then work on the local network only */ }
}
if (ip && !isIp(ip)) { console.warn(`[init] "${ip}" does not look like an address, ignoring it`); ip = ''; }

const yaml = `# Written by the init service. Do not edit: it is made again each time the stack starts.
port: 7880
log_level: info
keys:
  hearth: ${secret}
rtc:
  tcp_port: ${tcpPort}
  port_range_start: ${udpStart}
  port_range_end: ${udpEnd}
  use_external_ip: false
${ip ? `  node_ip: ${ip}\n` : ''}  advertise_internal_ip: true
  use_mdns: false
  stun_servers: []
  allow_tcp_fallback: true
turn:
  enabled: false
audio:
  active_level: 50
  min_percentile: 20
  update_interval: 200
  smooth_intervals: 2
room:
  auto_create: true
  empty_timeout: 3600
  departure_timeout: 120
  max_participants: 20
  playout_delay:
    enabled: true
    min: 60
    max: 1000
`;
fs.writeFileSync(path.join(dir, 'livekit.yaml'), yaml, { mode: 0o644 });
console.log(ip ? `[init] LiveKit will advertise ${ip}` : '[init] no public address found: calls work on the local network only (set PUBLIC_IP to change that)');
