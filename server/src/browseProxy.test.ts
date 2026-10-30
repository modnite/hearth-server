import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROWSE_BURST, BrowseError, allowBrowse, checkUrl, fetchPage, isPrivateAddress, rewriteHtml } from './browseProxy.js';

describe('browser proxy: which addresses are never fetched', () => {
  it('refuses this machine, private networks, link-local, reserved and multicast ranges', () => {
    for (const ip of [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.8.8.8', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.2.9',
      '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:192.168.1.5',
      '::ffff:7f00:1', '64:ff9b::10.0.0.1', '2001:db8::1',
    ]) expect(isPrivateAddress(ip), ip).toBe(true);
  });

  it('lets public addresses through', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses things that are not addresses', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('browser proxy: which web addresses are opened', () => {
  it('opens ordinary http and https addresses', () => {
    expect(checkUrl('https://example.com/a?b=1').hostname).toBe('example.com');
    expect(checkUrl('http://example.com:8080/').port).toBe('8080');
  });

  it('refuses other schemes, sign-ins in the address, odd ports and private places', () => {
    for (const bad of [
      'file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pw@example.com/', 'http://example.com:22/', 'http://example.com:6379/',
      'http://localhost/', 'http://app.localhost/', 'http://nas.local/', 'http://127.0.0.1/', 'http://[::1]/', 'http://192.168.1.10/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1:8080/',
      'http://2130706433/', 'not a url',
    ]) expect(() => checkUrl(bad), bad).toThrow(BrowseError);
  });
});

describe('browser proxy: rewriting a page', () => {
  it('puts the base and the helper first in the head and drops what would fight them', () => {
    const out = rewriteHtml(
      '<html><head><meta http-equiv="Content-Security-Policy" content="script-src none"><meta http-equiv="refresh" content="0;url=/x"><base href="/other/"><title>T</title></head><body><a href="/a">a</a></body></html>',
      'https://example.com/dir/page',
    );
    expect(out).toMatch(/<head><meta charset="utf-8"><base href="https:\/\/example\.com\/dir\/page">/);
    expect(out).not.toMatch(/content-security-policy/i);
    expect(out).not.toMatch(/http-equiv="refresh"/i);
    expect(out).not.toContain('/other/');
    expect(out).toContain('hearthBrowser');
    expect(out.match(/<base /g)).toHaveLength(1);
  });

  it('wraps a fragment that has no head', () => {
    const out = rewriteHtml('<p>hello</p>', 'https://example.com/');
    expect(out).toContain('<head>');
    expect(out).toContain('<p>hello</p>');
  });

  it('cannot be broken out of by a hostile address', () => {
    const out = rewriteHtml('<html><head></head></html>', 'https://example.com/"><script>alert(1)</script>');
    expect(out).not.toContain('"><script>alert(1)</script>');
  });
});

describe('browser proxy: rate limit', () => {
  it('allows a burst and then about one a second', () => {
    let ok = 0;
    for (let i = 0; i < 100; i++) if (allowBrowse('u1', 1_000)) ok++;
    expect(ok).toBe(BROWSE_BURST);
    expect(allowBrowse('u1', 2_100)).toBe(true);
    expect(allowBrowse('u1', 2_150)).toBe(false);
    expect(allowBrowse('u2', 2_150)).toBe(true);
  });
});

describe('browser proxy: fetching', () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redir-private') { res.writeHead(302, { location: 'http://127.0.0.1/' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head></head><body>hi</body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  it('never connects to this machine, even when the address is allowed by port', async () => {
    // the local test server is on a private address, so every route to it is refused
    await expect(fetchPage(`http://127.0.0.1:${port}/`)).rejects.toThrow(BrowseError);
    await expect(fetchPage(`http://localhost:${port}/`)).rejects.toThrow(BrowseError);
  });
});
