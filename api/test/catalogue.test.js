import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';

const app = createApp();
afterAll(() => pool.end());
const skus = (res) => res.body.products.map((p) => p.sku).sort();

describe('GET /api/products filters', () => {
  it('department=MEN returns only men', async () => {
    const res = await request(app).get('/api/products?department=MEN');
    expect(res.status).toBe(200);
    expect(res.body.products.every((p) => p.department === 'MEN')).toBe(true);
    expect(skus(res)).toEqual(['nura-012', 'nura-013', 'nura-014', 'nura-015', 'nura-016', 'nura-017', 'nura-019']);
  });

  it('sale=true returns exactly the 8 sale products', async () => {
    const res = await request(app).get('/api/products?sale=true');
    expect(res.body.count).toBe(8);
    expect(res.body.products.every((p) => p.onSale)).toBe(true);
  });

  it('new=true returns the 6 New In products, newest first', async () => {
    const res = await request(app).get('/api/products?new=true');
    expect(res.body.products.map((p) => p.sku)).toEqual(['nura-001', 'nura-002', 'nura-003', 'nura-004', 'nura-005', 'nura-006']);
  });

  it('filters combine: women AND on sale', async () => {
    const res = await request(app).get('/api/products?department=WOMEN&sale=true');
    expect(skus(res)).toEqual(['nura-003', 'nura-010', 'nura-020']);
  });

  it('brand filter uses the slug', async () => {
    const res = await request(app).get('/api/products?brand=louis-vuitton');
    expect(skus(res)).toEqual(['nura-005', 'nura-009', 'nura-015']);
  });

  it('q searches names and brands, case-insensitively', async () => {
    expect(skus(await request(app).get('/api/products?q=BLAZER'))).toEqual(['nura-002', 'nura-011', 'nura-015']);
    expect(skus(await request(app).get('/api/products?q=nike'))).toEqual(['nura-014', 'nura-018', 'nura-019']);
  });

  it('q treats % and _ as plain characters, not wildcards', async () => {
    const res = await request(app).get('/api/products?q=%25%25');   // "%%"
    expect(res.body.count).toBe(0);
  });

  it('limit caps the list', async () => {
    const res = await request(app).get('/api/products?new=true&limit=4');
    expect(res.body.count).toBe(4);
  });

  it('only the shopper\'s own browser may cache it, for 30 seconds; Netlify\'s CDN never', async () => {
    for (const url of ['/api/products?limit=1', '/api/products/relaxed-linen-shirt']) {
      const res = await request(app).get(url);
      expect(res.headers['cache-control'], url).toBe('private, max-age=30');
      expect(res.headers['netlify-cdn-cache-control'], url).toBe('no-store');
    }
  });
});

describe('bad filters are refused, not guessed at', () => {
  const bad = [
    ['department=KIDS', /department/],
    ['sale=yes', /sale/],
    ['limit=0', /limit/],
    ['limit=500', /limit/],
    ['q=a', /at least 2/],
    ['brand=Louis%20Vuitton', /brand slug/],
    ['price=1', /Unknown field: price/],
  ];
  for (const [qs, msg] of bad) {
    it(`?${qs} → 400`, async () => {
      const res = await request(app).get(`/api/products?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(msg);
    });
  }
});

describe('GET /api/products/:slug', () => {
  it('returns one product with its sizes', async () => {
    const res = await request(app).get('/api/products/linen-oversized-blazer');
    expect(res.status).toBe(200);
    expect(res.body.product).toMatchObject({ sku: 'nura-002', priceKes: 14200 });
    expect(res.body.product.variants).toHaveLength(5);
  });
  it('unknown slug → 404', async () => {
    const res = await request(app).get('/api/products/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Product not found');
  });
  it('hidden product → 404, as if it never existed', async () => {
    await db.execute(sql`update products set is_active = false where sku = 'nura-021'`);
    const res = await request(app).get('/api/products/woven-leather-belt');
    await db.execute(sql`update products set is_active = true where sku = 'nura-021'`);
    expect(res.status).toBe(404);
  });
  it('rejects slugs with odd characters before touching the database', async () => {
    const res = await request(app).get("/api/products/x'%20or%201=1");
    expect(res.status).toBe(400);
  });
});
