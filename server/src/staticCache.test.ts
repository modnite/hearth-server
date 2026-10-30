import { describe, expect, it } from 'vitest';
import { staticCacheHeaders } from './staticCache.js';

describe('static response cache policy', () => {
  it.each(['index.html', 'sw.js', 'registerSW.js', 'push-sw.js', 'manifest.webmanifest'])(
    '%s cannot be held by the browser or CDN after a release', (entry) => {
      expect(staticCacheHeaders(`/app/server/dist/public/${entry}`)).toEqual({
        'cache-control': 'no-store, max-age=0',
        'cdn-cache-control': 'no-store',
        'cloudflare-cdn-cache-control': 'no-store',
      });
    },
  );

  it('applies the entry-point policy on Windows too', () => {
    expect(staticCacheHeaders('C:\\hearth\\server\\dist\\public\\sw.js')['cache-control']).toContain('no-store');
  });

  it.each(['index-co1wZEYY.js', 'index-Cmo-B3nz.css'])(
    'keeps immutable caching for versioned bundle %s', (bundle) => {
      expect(staticCacheHeaders(`/app/public/assets/${bundle}`)).toEqual({
        'cache-control': 'public, max-age=31536000, immutable',
      });
    },
  );

  it.each(['emoji/1f600.png', 'buddies/clippy.png', 'fonts/ui.woff2'])(
    'retains a week of caching for %s', (asset) => {
      expect(staticCacheHeaders(`/app/public/${asset}`)['cache-control']).toBe('public, max-age=604800');
    },
  );

  it('requires revalidation of other unversioned files', () => {
    expect(staticCacheHeaders('/app/public/icon.svg')['cache-control']).toBe('no-cache');
  });
});
