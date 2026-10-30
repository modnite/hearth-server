/** Entry points must revalidate at the origin; hashed assets can stay cached. */
export function staticCacheHeaders(filePath: string): Record<string, string> {
  const p = filePath.split('\\').join('/');
  if (/\/(index\.html|sw\.js|registerSW\.js|push-sw\.js|manifest\.webmanifest)$/.test(p)) {
    return {
      'cache-control': 'no-store, max-age=0',
      'cdn-cache-control': 'no-store',
      'cloudflare-cdn-cache-control': 'no-store',
    };
  }
  if (/\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(p)) {
    return { 'cache-control': 'public, max-age=31536000, immutable' };
  }
  if (/\/(emoji|buddies|fonts)\//.test(p)) {
    return { 'cache-control': 'public, max-age=604800' };
  }
  return { 'cache-control': 'no-cache' };
}
