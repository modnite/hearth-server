import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { fetchPreview } from './preview.js';

describe('fetchPreview SSRF guard', () => {
  it.each([
    'http://127.0.0.1/',
    'http://localhost:8080/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/',
    'http://192.168.100.213/',
    'ftp://example.com/',
    'file:///etc/passwd',
  ])('refuses %s', async (url) => {
    expect(await fetchPreview(url)).toBeNull();
  });
});

describe('preview metadata and video links', () => {
  beforeEach(() => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const page = (html: string, type = 'text/html') => new Response(html, { headers: { 'content-type': type } });

  it('handles attribute order, case, whitespace and apostrophes without truncating titles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page(`<META content = "It's a title > something &amp; &#x1F98B;" PROPERTY = 'OG:TITLE'><meta name=description content='A &quot;quoted&quot; description'><meta property=og:image content='/pictures/hero.jpg'>`)));
    expect(await fetchPreview('https://example.com/article')).toMatchObject({
      title: "It's a title > something & 🦋", description: 'A "quoted" description', image: 'https://example.com/pictures/hero.jpg',
    });
  });

  it.each(['application/xhtml+xml; charset=UTF-8', 'Text/HTML; charset=utf-8'])('accepts document type %s', async (type) => {
    vi.stubGlobal('fetch', vi.fn(async () => page('<title>Readable &#8217; title</title>', type)));
    expect((await fetchPreview('https://example.com/'))?.title).toBe('Readable ’ title');
  });

  it('resolves relative images against the final redirected document URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/posts/article' } }))
      .mockResolvedValueOnce(page('<meta property="og:title" content="Article"><meta property="og:image" content="./cover.jpg">')));
    expect(await fetchPreview('https://example.com/old')).toMatchObject({ url: 'https://example.com/posts/article', image: 'https://example.com/posts/cover.jpg' });
  });

  it('resolves protocol-relative Twitter images and rejects executable image schemes', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page('<meta name="twitter:title" content="Post"><meta name="twitter:image:src" content="//cdn.example.com/photo.jpg">'))
      .mockResolvedValueOnce(page('<meta property="og:title" content="Post"><meta property="og:image" content="javascript:alert(1)">'));
    vi.stubGlobal('fetch', fetcher);
    expect((await fetchPreview('https://example.com/one'))?.image).toBe('https://cdn.example.com/photo.jpg');
    expect((await fetchPreview('https://example.com/two'))?.image).toBeUndefined();
  });

  it.each(['https://youtu.be/dQw4w9WgXcQ?t=4', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ'])('uses bounded public oEmbed for %s', async (url) => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ title: 'A video title', thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchPreview(url)).toMatchObject({ url, title: 'A video title', siteName: 'YouTube', image: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(request.origin + request.pathname).toBe('https://www.youtube.com/oembed');
    expect(request.searchParams.get('url')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('falls back to normal page metadata when oEmbed is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('not available')).mockResolvedValueOnce(page('<meta property="og:title" content="Page fallback">')));
    expect((await fetchPreview('https://youtu.be/dQw4w9WgXcQ'))?.title).toBe('Page fallback');
  });

  it('retains private-host protection on redirects', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchPreview('https://example.com/')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('caps a large response by bytes even when the server sends one oversized chunk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page('a'.repeat(200_000) + '<meta property="og:title" content="Outside cap">')));
    expect((await fetchPreview('https://example.com/'))?.title).toBeUndefined();
  });
});
