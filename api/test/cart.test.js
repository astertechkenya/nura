import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { sessionStore } from '../src/middleware/session.js';
import { netlifyToken } from './helpers.js';

const app = createApp();
afterAll(async () => { sessionStore.close(); await pool.end(); });

// Every request looks like it came through Netlify from its own IP, so rate limits from one
// test never affect another. An agent keeps cookies between requests, like one browser.
let ipCounter = 0;
function as(agentOrApp) {
  const ip = `10.3.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  const target = typeof agentOrApp === 'function' ? request(agentOrApp) : agentOrApp;
  const wrap = (m) => (url) => target[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
}
const browser = () => request.agent(app);
const uniq = () => `cart${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
const cookieNamed = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));

// variant(sku, size) → { id, stock }, read once from the public catalogue.
let V;
beforeAll(async () => {
  const res = await request(app).get('/api/products');
  V = {};
  for (const p of res.body.products) for (const v of p.variants) V[`${p.sku}/${v.size}`] = v;
});
const variant = (sku, size) => V[`${sku}/${size}`].id;

const add = (agent, sku, size, qty = 1) => as(agent).post('/api/cart/items').send({ variantId: variant(sku, size), qty });

describe('guest cart', () => {
  it('starts empty and sets no cookie just for looking', async () => {
    const res = await as(app).get('/api/cart');
    expect(res.status).toBe(200);
    expect(res.body.cart).toMatchObject({ items: [], count: 0, subtotalKes: 0, totalKes: 0 });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('first add creates the cart and a safe guest cookie; prices come from the database', async () => {
    const b = browser();
    const res = await add(b, 'nura-003', 'M', 2);                      // Printed Wrap Dress, KSh 5,700
    expect(res.status).toBe(201);
    const cookie = cookieNamed(res, 'nura.guest');
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const { cart } = res.body;
    expect(cart.count).toBe(2);
    expect(cart.items[0]).toMatchObject({ qty: 2, variant: { size: 'M' }, product: { sku: 'nura-003', priceKes: 5700 }, lineTotalKes: 11400, problem: null });
    expect(cart.subtotalKes).toBe(11400);
    expect(cart.shipping).toMatchObject({ feeKes: 0, awayKes: 0 });   // over the 5,000 threshold
    // The same browser sees the same cart on the next visit.
    const again = await as(b).get('/api/cart');
    expect(again.body.cart.count).toBe(2);
  });

  it('only a hash of the guest token is stored', async () => {
    const b = browser();
    const res = await add(b, 'nura-021', 'ONE SIZE');
    const token = cookieNamed(res, 'nura.guest').split(';')[0].split('=')[1];
    const rows = (await db.execute(sql`select guest_token from carts where guest_token is not null`)).rows;
    expect(rows.some((r) => r.guest_token === token)).toBe(false);
    expect(rows.some((r) => /^[0-9a-f]{64}$/.test(r.guest_token))).toBe(true);
  });

  it('adding the same size again adds to the line', async () => {
    const b = browser();
    await add(b, 'nura-019', 'S');
    const res = await add(b, 'nura-019', 'S', 2);
    expect(res.status).toBe(200);
    expect(res.body.cart.items).toHaveLength(1);
    expect(res.body.cart.items[0].qty).toBe(3);
  });

  it('shows how far the shopper is from free shipping, and charges the fee below it', async () => {
    const b = browser();
    const res = await add(b, 'nura-021', 'ONE SIZE');                // Belt, KSh 2,100
    expect(res.body.cart.shipping).toEqual({ feeKes: 300, thresholdKes: 5000, awayKes: 2900 });
    expect(res.body.cart.totalKes).toBe(2400);
  });

  it("two guests' carts never mix", async () => {
    const a = browser(), b = browser();
    await add(a, 'nura-004', 'ONE SIZE');
    await add(b, 'nura-006', 'ONE SIZE');
    const ca = (await as(a).get('/api/cart')).body.cart, cb = (await as(b).get('/api/cart')).body.cart;
    expect(ca.items.map((i) => i.product.sku)).toEqual(['nura-004']);
    expect(cb.items.map((i) => i.product.sku)).toEqual(['nura-006']);
  });

  it("a guest can't change or delete a line in someone else's cart, even knowing its id", async () => {
    const owner = browser(), attacker = browser();
    const line = (await add(owner, 'nura-008', 'L')).body.cart.items[0];
    await add(attacker, 'nura-001', 'ONE SIZE');
    const patch = await as(attacker).patch(`/api/cart/items/${line.id}`).send({ qty: 3 });
    expect(patch.status).toBe(404);
    await as(attacker).delete(`/api/cart/items/${line.id}`);
    const mine = (await as(owner).get('/api/cart')).body.cart;
    expect(mine.items[0]).toMatchObject({ id: line.id, qty: 1 });
  });

  it('a made-up or tampered guest cookie just means an empty cart', async () => {
    const res = await as(app).get('/api/cart').set('Cookie', 'nura.guest=not-a-real-token');
    expect(res.status).toBe(200);
    expect(res.body.cart.count).toBe(0);
  });
});

describe('the body never sets a price', () => {
  it('rejects a price field', async () => {
    const res = await as(app).post('/api/cart/items').send({ variantId: variant('nura-003', 'S'), qty: 1, price: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown field: price/);
  });
  it('rejects priceKes on a quantity change too', async () => {
    const b = browser();
    const line = (await add(b, 'nura-003', 'S')).body.cart.items[0];
    const res = await as(b).patch(`/api/cart/items/${line.id}`).send({ qty: 1, priceKes: 1 });
    expect(res.status).toBe(400);
  });
});

describe('stock and limits', () => {
  it('refuses more than is in stock with 409', async () => {
    const b = browser();
    const res = await add(b, 'nura-002', 'M', 2);                       // only 1 in stock
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Only 1 left in size M/);
  });

  it('counts what is already in the cart', async () => {
    const b = browser();
    expect((await add(b, 'nura-002', 'M')).status).toBe(201);
    const res = await add(b, 'nura-002', 'M');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/1 is already in your cart/);
  });

  it('refuses a quantity change above stock', async () => {
    const b = browser();
    const line = (await add(b, 'nura-009', 'L')).body.cart.items[0];   // 3 in stock
    expect((await as(b).patch(`/api/cart/items/${line.id}`).send({ qty: 3 })).status).toBe(200);
    expect((await as(b).patch(`/api/cart/items/${line.id}`).send({ qty: 4 })).status).toBe(409);
  });

  it('caps a line at 10 and refuses 0, negatives, decimals and nonsense', async () => {
    for (const qty of [0, -1, 1.5, 11, 'lots']) {
      const res = await as(app).post('/api/cart/items').send({ variantId: variant('nura-011', 'S'), qty });
      expect(res.status, `qty ${qty}`).toBe(400);
    }
  });

  it('404s for an unknown variant and 400s for a malformed one', async () => {
    expect((await as(app).post('/api/cart/items').send({ variantId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await as(app).post('/api/cart/items').send({ variantId: 'nura-003' })).status).toBe(400);
  });

  it('a line whose size sells out stays visible, flagged, and out of the subtotal', async () => {
    const b = browser();
    await add(b, 'nura-013', 'XS');
    await add(b, 'nura-012', 'S');
    const id = variant('nura-013', 'XS');
    await db.execute(sql`update product_variants set stock = 0 where id = ${id}`);
    try {
      const { cart } = (await as(b).get('/api/cart')).body;
      const gone = cart.items.find((i) => i.product.sku === 'nura-013');
      expect(gone).toMatchObject({ problem: 'Sold out in this size.', lineTotalKes: 0 });
      expect(cart.subtotalKes).toBe(8200);                             // only the shirt
      expect(cart.count).toBe(2);
    } finally {
      await db.execute(sql`update product_variants set stock = 5 where id = ${id}`);
    }
  });

  it('a hidden product can no longer be added', async () => {
    await db.execute(sql`update products set is_active = false where sku = 'nura-016'`);
    try {
      expect((await add(app, 'nura-016', 'M')).status).toBe(404);
    } finally {
      await db.execute(sql`update products set is_active = true where sku = 'nura-016'`);
    }
  });
});

describe('changing and emptying', () => {
  it('updates, removes (twice is fine) and clears', async () => {
    const b = browser();
    await add(b, 'nura-014', 'S');
    const line = (await add(b, 'nura-015', 'M')).body.cart.items.find((i) => i.product.sku === 'nura-015');
    const changed = await as(b).patch(`/api/cart/items/${line.id}`).send({ qty: 2 });
    expect(changed.body.cart.count).toBe(3);
    expect((await as(b).delete(`/api/cart/items/${line.id}`)).body.cart.count).toBe(1);
    expect((await as(b).delete(`/api/cart/items/${line.id}`)).status).toBe(200);
    const cleared = await as(b).delete('/api/cart');
    expect(cleared.body.cart).toMatchObject({ items: [], count: 0 });
  });

  it('refuses writes from another website', async () => {
    const res = await request(app).post('/api/cart/items').set('Origin', 'https://evil.example')
      .send({ variantId: variant('nura-003', 'S') });
    expect(res.status).toBe(403);
  });
});

describe('merging on sign-in', () => {
  async function register(agent) {
    const body = { name: 'Achieng Otieno', email: uniq(), password: 'correct horse battery' };
    const res = await as(agent).post('/api/auth/register').send(body);
    expect(res.status).toBe(201);
    return { ...body, res };
  }

  it('guest adds an item, registers, and the cart is kept', async () => {
    const b = browser();
    await add(b, 'nura-007', 'S', 2);
    const { res } = await register(b);
    // The guest cookie is cleared: this browser now uses the account's cart.
    expect(cookieNamed(res, 'nura.guest')).toMatch(/Expires=Thu, 01 Jan 1970/);
    const { cart } = (await as(b).get('/api/cart')).body;
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({ qty: 2, product: { sku: 'nura-007' }, variant: { size: 'S' } });
    const guestCarts = (await db.execute(sql`select count(*)::int as n from carts c join cart_items i on i.cart_id = c.id where c.guest_token is not null and i.variant_id = ${variant('nura-007', 'S')}`)).rows[0].n;
    expect(guestCarts).toBe(0);                                         // the guest cart is gone
  });

  it('signing in on a second device adds that guest cart to the account, capped at stock', async () => {
    const laptop = browser();
    await add(laptop, 'nura-010', 'L', 2);                             // 3 in stock
    const { email, password } = await register(laptop);

    const phone = browser();
    await add(phone, 'nura-010', 'L', 2);                              // 2 + 2 = 4 > 3
    await add(phone, 'nura-005', 'ONE SIZE');
    const login = await as(phone).post('/api/auth/login').send({ email, password });
    expect(login.status).toBe(200);

    const { cart } = (await as(phone).get('/api/cart')).body;
    const skirt = cart.items.find((i) => i.product.sku === 'nura-010');
    expect(skirt.qty).toBe(3);
    expect(cart.items.map((i) => i.product.sku).sort()).toEqual(['nura-005', 'nura-010']);
    // And the laptop, still signed in, sees the same account cart.
    expect((await as(laptop).get('/api/cart')).body.cart.count).toBe(4);
  });

  it('signing out leaves the cart with the account, and the browser starts a new, empty one', async () => {
    const b = browser();
    const { email, password } = await register(b);
    await add(b, 'nura-017', 'L');
    await as(b).post('/api/auth/logout');
    expect((await as(b).get('/api/cart')).body.cart.count).toBe(0);
    await as(b).post('/api/auth/login').send({ email, password });
    expect((await as(b).get('/api/cart')).body.cart.count).toBe(1);
  });

  it('a sign-in with no guest cart changes nothing', async () => {
    const b = browser();
    const { email, password } = await register(b);
    await add(b, 'nura-018', 'UK 8');
    await as(b).post('/api/auth/logout');
    const res = await as(b).post('/api/auth/login').send({ email, password });
    expect(cookieNamed(res, 'nura.guest')).toBeUndefined();
    expect((await as(b).get('/api/cart')).body.cart.count).toBe(1);
  });
});
