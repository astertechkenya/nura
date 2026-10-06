// Right-sized photos: the addresses the server (lib/photo.js) and the storefront
// (frontend/js/api.js) produce must agree, and every size the pages ask for must exist.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { photoAt, photoSrcset, PHOTO_WIDTHS } from '../src/lib/photo.js';
import { readCatalogue } from '../src/db/seed.js';

const CLOUD = 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,c_limit,w_1200/v17/nura/abc123';

// The storefront's api.js, run in a sandbox with just the `window` it expects.
const browser = (() => {
  const window = { NURA: {} };
  vm.runInNewContext(readFileSync(new URL('../../frontend/js/api.js', import.meta.url), 'utf8'), { window });
  return window.NURA;
})();

describe('photo sizes', () => {
  it('Cloudinary: only the width changes; the whole picture is kept (c_limit), never cropped', () => {
    expect(photoAt(CLOUD, 400)).toBe(CLOUD.replace('w_1200', 'w_400'));
    expect(photoSrcset(CLOUD)).toBe(`${CLOUD.replace('w_1200', 'w_400')} 400w, ${CLOUD.replace('w_1200', 'w_800')} 800w, ${CLOUD} 1200w`);
  });

  it('our own photos: the copies in images/sized/', () => {
    expect(photoAt('images/cottonwrap.webp', 800)).toBe('images/sized/cottonwrap-800.webp');
    expect(photoAt('images/airmax.avif', 400)).toBe('images/sized/airmax-400.webp');
  });

  it('anything unexpected is left alone: no srcset, never a made-up address', () => {
    for (const u of ['https://example.com/x.jpg', 'images/../secret.webp', '', null, 'javascript:alert(1)']) {
      expect(photoAt(u, 400)).toBeNull();
      expect(photoSrcset(u)).toBe('');
    }
    expect(browser.photo('https://example.com/x.jpg')).toBe('https://example.com/x.jpg');
  });

  it('the storefront gives exactly the same addresses as the server', () => {
    for (const u of [CLOUD, 'images/cottonwrap.webp', 'images/airmax.avif', 'https://example.com/x.jpg']) {
      expect(browser.photoSrcset(u)).toBe(photoSrcset(u));
      for (const w of PHOTO_WIDTHS) expect(browser.photo(u, w)).toBe(photoAt(u, w) ?? u);
    }
    expect(browser.photo('images/cottonwrap.webp')).toBe('images/sized/cottonwrap-400.webp');   // thumbnails
  });

  it('every seeded product has all three sizes on disk (made by tools/photo-sizes.py)', () => {
    let n = 0;
    for (const p of readCatalogue()) {
      if (!p.imageUrl?.startsWith('images/')) continue;
      n += 1;
      for (const w of PHOTO_WIDTHS) {
        expect(existsSync(new URL(`../../frontend/${photoAt(p.imageUrl, w)}`, import.meta.url)), `${p.imageUrl} at ${w}`).toBe(true);
      }
    }
    expect(n).toBe(21);
  });
});
