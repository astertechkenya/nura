import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { sessionStore } from '../src/middleware/session.js';
import { netlifyToken } from './helpers.js';

const app = createApp();
afterAll(async () => { sessionStore.close(); await pool.end(); });

let ipCounter = 0;
function as(agentOrApp) {
  const ip = `10.4.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  const target = typeof agentOrApp === 'function' ? request(agentOrApp) : agentOrApp;
  const wrap = (m) => (url) => target[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip);
  return { get: wrap('get'), post: wrap('post'), delete: wrap('delete') };
}
async function signedIn() {
  const b = request.agent(app);
  const res = await as(b).post('/api/auth/register')
    .send({ name: 'Kamau N', email: `wl${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`, password: 'correct horse battery' });
  expect(res.status).toBe(201);
  return b;
}
const skus = (res) => res.body.items.map((p) => p.sku);

describe('wishlist', () => {
  it('is for signed-in shoppers only', async () => {
    expect((await as(app).get('/api/wishlist')).status).toBe(401);
    expect((await as(app).post('/api/wishlist').send({ skus: ['nura-001'] })).status).toBe(401);
  });

  it('saves, lists newest first with live product data, and removes', async () => {
    const b = await signedIn();
    expect(skus(await as(b).get('/api/wishlist'))).toEqual([]);
    await as(b).post('/api/wishlist').send({ skus: ['nura-003'] });
    await new Promise((r) => setTimeout(r, 10));                       // distinct timestamps
    const res = await as(b).post('/api/wishlist').send({ skus: ['nura-011'] });
    expect(skus(res)).toEqual(['nura-011', 'nura-003']);
    expect(res.body.items[1]).toMatchObject({ name: 'Printed Wrap Dress', priceKes: 5700, onSale: true });
    expect(res.body.items[1].variants.length).toBe(5);                 // sizes, for "add to cart"
    expect(skus(await as(b).delete('/api/wishlist/nura-011'))).toEqual(['nura-003']);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('merges a guest list in one call, ignoring duplicates and unknown codes', async () => {
    const b = await signedIn();
    await as(b).post('/api/wishlist').send({ skus: ['nura-001'] });
    const res = await as(b).post('/api/wishlist').send({ skus: ['nura-001', 'nura-002', 'nura-999'] });
    expect(res.status).toBe(200);
    expect(skus(res).sort()).toEqual(['nura-001', 'nura-002']);
  });

  it('rejects malformed codes and oversized batches', async () => {
    const b = await signedIn();
    expect((await as(b).post('/api/wishlist').send({ skus: ['<script>'] })).status).toBe(400);
    expect((await as(b).post('/api/wishlist').send({ skus: [] })).status).toBe(400);
    expect((await as(b).post('/api/wishlist').send({ skus: Array(51).fill('nura-001') })).status).toBe(400);
    expect((await as(b).post('/api/wishlist').send({ skus: ['nura-001'], userId: 'x' })).status).toBe(400);
  });

  it("each account sees only its own list", async () => {
    const a = await signedIn(), b = await signedIn();
    await as(a).post('/api/wishlist').send({ skus: ['nura-020'] });
    expect(skus(await as(b).get('/api/wishlist'))).toEqual([]);
  });

  it('hidden products drop out of the list', async () => {
    const b = await signedIn();
    await as(b).post('/api/wishlist').send({ skus: ['nura-016', 'nura-004'] });
    await db.execute(sql`update products set is_active = false where sku = 'nura-016'`);
    try {
      expect(skus(await as(b).get('/api/wishlist'))).toEqual(['nura-004']);
    } finally {
      await db.execute(sql`update products set is_active = true where sku = 'nura-016'`);
    }
  });

  it('clears', async () => {
    const b = await signedIn();
    await as(b).post('/api/wishlist').send({ skus: ['nura-001', 'nura-002'] });
    expect((await as(b).delete('/api/wishlist')).body.count).toBe(0);
  });
});
