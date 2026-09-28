import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseKsh, slugify, readStorefrontProducts, buildCatalogue } from '../src/db/seed.js';

const overrides = JSON.parse(readFileSync(new URL('../src/db/seed-overrides.json', import.meta.url), 'utf8'));

describe('seed helpers', () => {
  it('parses display prices into whole shillings', () => {
    expect(parseKsh('KSh 14,200')).toBe(14200);
    expect(() => parseKsh('free')).toThrow();
  });
  it('makes URL-safe slugs', () => {
    expect(slugify('Double-Breasted Suit')).toBe('double-breasted-suit');
    expect(slugify('Air Max 270 Sneakers')).toBe('air-max-270-sneakers');
  });
});

describe('catalogue sources', () => {
  const storefront = readStorefrontProducts();

  it('reads all 21 products from the storefront script', () => {
    expect(storefront).toHaveLength(21);
  });
  it('has an override for every product (nothing silently skipped)', () => {
    for (const p of storefront) expect(overrides.products[p.id], p.id).toBeDefined();
  });
  it('fails loudly when a product has no override', () => {
    expect(() => buildCatalogue([{ id: 'nura-999', name: 'Ghost', price: 'KSh 1' }], overrides)).toThrow(/nura-999/);
  });
  it('every sale price is below its "was" price', () => {
    for (const { product } of buildCatalogue(storefront, overrides)) {
      if (product.compareAtKes !== null) expect(product.compareAtKes, product.sku).toBeGreaterThan(product.priceKes);
    }
  });
  it('slugs are unique', () => {
    const slugs = buildCatalogue(storefront, overrides).map((c) => c.product.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
