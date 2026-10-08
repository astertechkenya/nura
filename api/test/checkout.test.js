import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { sessionStore } from '../src/middleware/session.js';
import { codAvailable, expireOrders, placeOrder } from '../src/services/orders.js';
import { normalisePhone } from '../src/lib/kenya.js';
import { netlifyToken } from './helpers.js';

import { seed } from '../src/db/seed.js';

const app = createApp();
// Checkouts really take stock. Give every size plenty for this file, then put the seeded
// numbers back so the other test files see the catalogue they expect.
beforeAll(() => db.execute(sql`update product_variants set stock = stock + 50`));
afterAll(async () => { await seed({ log: () => {} }); sessionStore.close(); await pool.end(); });

let ipCounter = 0;
function as(agentOrApp) {
  const ip = `10.5.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  const target = typeof agentOrApp === 'function' ? request(agentOrApp) : agentOrApp;
  const wrap = (m) => (url) => target[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
}
const browser = () => request.agent(app);

let V;
beforeAll(async () => {
  const res = await request(app).get('/api/products');
  V = {};
  for (const p of res.body.products) for (const v of p.variants) V[`${p.sku}/${v.size}`] = v.id;
});
const add = (agent, sku, size, qty = 1) => as(agent).post('/api/cart/items').send({ variantId: V[`${sku}/${size}`], qty });
const stockOf = async (sku, size) => (await db.execute(sql`
  select v.stock from product_variants v join products p on p.id = v.product_id where p.sku = ${sku} and v.size = ${size}`)).rows[0].stock;
const setStock = (sku, size, n) => db.execute(sql`
  update product_variants v set stock = ${n} from products p where p.id = v.product_id and p.sku = ${sku} and v.size = ${size}`);

const form = (over = {}) => ({
  checkoutKey: randomUUID(),
  email: 'wambui@example.com',
  phone: '0712 345 678',
  name: 'Wambui Kariuki',
  addressLine1: 'Apt 4B, Kilimani Heights, Argwings Kodhek Rd',
  area: 'Kilimani',
  county: 'Nairobi',
  notes: 'Call when at the gate',
  paymentMethod: 'COD',
  ...over,
});
const checkout = (agent, over) => as(agent).post('/api/checkout').send(form(over));

describe('checkout options', () => {
  it('lists counties, what is payable today and the COD rules', async () => {
    const res = await as(app).get('/api/checkout/options');
    expect(res.status).toBe(200);
    expect(res.body.counties).toHaveLength(47);
    expect(res.body.methods).toEqual({ COD: true, MPESA: true, CARD: true });
    expect(res.body.cod).toEqual({ counties: ['Nairobi'], maxKes: null });
    expect(res.body.shipping).toEqual({ feeKes: 300, freeFromKes: 5000 });
  });
});

describe('placing a COD order as a guest', () => {
  it('creates the order from the cart, prices it on the server, takes stock and empties the cart', async () => {
    const b = browser();
    await add(b, 'nura-021', 'ONE SIZE', 2);                     // belt 2 × 2,100 = 4,200 → + 300 delivery
    const before = await stockOf('nura-021', 'ONE SIZE');
    const res = await checkout(b);
    expect(res.status).toBe(201);
    const o = res.body.order;
    expect(o.number).toMatch(/^NURA-\d{6}$/);
    expect(o).toMatchObject({ status: 'AWAITING_COD', paymentMethod: 'COD', subtotalKes: 4200, shippingKes: 300, totalKes: 4500, guest: true });
    expect(o.contact).toEqual({ name: 'Wambui Kariuki', email: 'wambui@example.com', phone: '254712345678' });
    expect(o.delivery).toMatchObject({ county: 'Nairobi', area: 'Kilimani', notes: 'Call when at the gate' });
    expect(o.items).toEqual([expect.objectContaining({ sku: 'nura-021', name: 'Woven Leather Belt', size: 'ONE SIZE', qty: 2, unitPriceKes: 2100, lineTotalKes: 4200 })]);
    expect(await stockOf('nura-021', 'ONE SIZE')).toBe(before - 2);
    expect((await as(b).get('/api/cart')).body.cart.count).toBe(0);

    const [pay] = (await db.execute(sql`select provider, status, amount_kes from payments where order_id = ${o.id}`)).rows;
    expect(pay).toEqual({ provider: 'COD', status: 'PENDING', amount_kes: 4500 });
    const [ev] = (await db.execute(sql`select from_status, to_status from order_events where order_id = ${o.id}`)).rows;
    expect(ev).toEqual({ from_status: null, to_status: 'AWAITING_COD' });
    const [row] = (await db.execute(sql`select expires_at from orders where id = ${o.id}`)).rows;
    expect(row.expires_at).toBeNull();                              // COD never expires
  });

  it('free delivery from KSh 5,000', async () => {
    const b = browser();
    await add(b, 'nura-003', 'M');                                 // 5,700
    const res = await checkout(b);
    expect(res.body.order).toMatchObject({ subtotalKes: 5700, shippingKes: 0, totalKes: 5700 });
  });

  it('order numbers go up one at a time', async () => {
    const a = browser(), b = browser();
    await add(a, 'nura-004', 'ONE SIZE'); await add(b, 'nura-004', 'ONE SIZE');
    const n1 = Number((await checkout(a)).body.order.number.slice(5));
    const n2 = Number((await checkout(b)).body.order.number.slice(5));
    expect(n2).toBe(n1 + 1);
  });

  it('keeps a snapshot: a later price change does not rewrite the order', async () => {
    const b = browser();
    await add(b, 'nura-006', 'ONE SIZE');
    const { order } = (await checkout(b)).body;
    await db.execute(sql`update products set price_kes = 99999 where sku = 'nura-006'`);
    try {
      const again = (await as(b).get(`/api/orders/${order.id}`)).body.order;
      expect(again.items[0].unitPriceKes).toBe(4800);
      expect(again.totalKes).toBe(order.totalKes);
    } finally {
      await db.execute(sql`update products set price_kes = 4800 where sku = 'nura-006'`);
    }
  });
});

describe('what the request may and may not say', () => {
  it('rejects any price or total in the body', async () => {
    const b = browser();
    await add(b, 'nura-021', 'ONE SIZE');
    for (const extra of [{ totalKes: 1 }, { price: 1 }, { items: [] }, { status: 'PAID' }]) {
      const res = await as(b).post('/api/checkout').send({ ...form(), ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.body.error).toMatch(/Unknown field/);
    }
  });

  it('refuses an empty cart', async () => {
    const res = await checkout(browser());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Your cart is empty.');
  });

  it('validates contact and address, with messages a shopper can act on', async () => {
    const b = browser();
    await add(b, 'nura-021', 'ONE SIZE');
    const cases = [
      [{ phone: '12345' }, /Kenyan mobile number/],
      [{ email: 'not-an-email' }, /valid email/],
      [{ county: 'Atlantis' }, /choose a county/],
      [{ name: '   ' }, /your name/],
      [{ area: '' }, /area or estate/],
      [{ notes: 'x'.repeat(301) }, /300 characters/],
      [{ paymentMethod: 'BITCOIN' }, /how to pay/],
      [{ checkoutKey: 'abc' }, /checkoutKey/],
    ];
    for (const [over, msg] of cases) {
      const res = await checkout(b, over);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.body.error).toMatch(msg);
    }
    expect((await as(b).get('/api/cart')).body.cart.count).toBe(1);   // nothing happened
  });

});

describe('cash on delivery rules', () => {
  it('only in Nairobi: elsewhere the order is refused and nothing changes', async () => {
    const b = browser();
    await add(b, 'nura-005', 'ONE SIZE');
    const before = await stockOf('nura-005', 'ONE SIZE');
    const res = await checkout(b, { county: 'Mombasa' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only available in Nairobi/);
    expect(await stockOf('nura-005', 'ONE SIZE')).toBe(before);
    expect((await as(b).get('/api/cart')).body.cart.count).toBe(1);
  });

  it('a value limit, when one is configured, is enforced', () => {
    const rules = { COD_COUNTIES: ['Nairobi'], COD_MAX_KES: 20000 };
    expect(codAvailable('Nairobi', 20000, rules)).toBe(true);
    expect(codAvailable('Nairobi', 20001, rules)).toBe(false);
    expect(codAvailable('Kiambu', 100, rules)).toBe(false);
    expect(codAvailable('Nairobi', 10_000_000, { COD_COUNTIES: ['Nairobi'] })).toBe(true);  // no limit
  });

  it('phone numbers are stored the way M-Pesa wants them', () => {
    expect(normalisePhone('0712 345 678')).toBe('254712345678');
    expect(normalisePhone('+254 712-345-678')).toBe('254712345678');
    expect(normalisePhone('0110 123 456')).toBe('254110123456');
    expect(normalisePhone('0812345678')).toBeNull();
    expect(normalisePhone('07123456789')).toBeNull();
  });
});

describe('stock', () => {
  it('two shoppers, one last blazer, the same instant: exactly one order', async () => {
    await setStock('nura-002', 'M', 1);
    const a = browser(), b = browser();
    expect((await add(a, 'nura-002', 'M')).status).toBe(201);
    expect((await add(b, 'nura-002', 'M')).status).toBe(201);      // both carts hold it; only one can buy it
    const results = await Promise.all([checkout(a), checkout(b)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409).body.error).toMatch(/just sold out/);
    expect(await stockOf('nura-002', 'M')).toBe(0);
    await setStock('nura-002', 'M', 51);
  });

  it('a failed checkout changes no stock at all, even for lines that had enough', async () => {
    const b = browser();
    await add(b, 'nura-007', 'XS');
    await add(b, 'nura-008', 'L', 2);
    await setStock('nura-008', 'L', 1);                           // sells down after it was added
    const xs = await stockOf('nura-007', 'XS');
    const res = await checkout(b);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only 1 Wide Leg Cargo Pants in size L left/);
    expect(await stockOf('nura-007', 'XS')).toBe(xs);              // rolled back
    await setStock('nura-008', 'L', 58);
  });

  it('a hidden product blocks checkout until removed', async () => {
    const b = browser();
    await add(b, 'nura-016', 'L');
    await db.execute(sql`update products set is_active = false where sku = 'nura-016'`);
    try {
      const res = await checkout(b);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/Cargo Shorts is no longer available/);
    } finally {
      await db.execute(sql`update products set is_active = true where sku = 'nura-016'`);
    }
  });
});

describe('sending the same checkout twice', () => {
  it('returns the same order instead of making a second one', async () => {
    const b = browser();
    await add(b, 'nura-019', 'M');
    const f = form();
    const [r1, r2] = await Promise.all([as(b).post('/api/checkout').send(f), as(b).post('/api/checkout').send(f)]);
    const ok = [r1, r2].filter((r) => r.status === 201);
    // One created it; the other either found it (201, same id) or found the cart already empty.
    expect(ok.length).toBeGreaterThanOrEqual(1);
    if (ok.length === 2) expect(ok[0].body.order.id).toBe(ok[1].body.order.id);
    const n = (await db.execute(sql`select count(*)::int as n from orders where checkout_key = ${f.checkoutKey}`)).rows[0].n;
    expect(n).toBe(1);
  });

  // Oct 2026: both requests now get the order (the second waits on the cart lock, then finds it).
  it('both answers carry the same order when sent at once', async () => {
    const b = browser();
    await add(b, 'nura-019', 'M');
    const f = form();
    const [r1, r2] = await Promise.all([as(b).post('/api/checkout').send(f), as(b).post('/api/checkout').send(f)]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r1.body.order.id).toBe(r2.body.order.id);
  });

  it('a retry after the first one finished (a timeout on the way back) gets the order, not "cart is empty"', async () => {
    const b = browser();
    await add(b, 'nura-019', 'M');
    const f = form();
    const first = await as(b).post('/api/checkout').send(f);
    expect(first.status).toBe(201);
    const retry = await as(b).post('/api/checkout').send(f);
    expect(retry.status).toBe(201);
    expect(retry.body.order.id).toBe(first.body.order.id);
  });

  it('two checkouts of one cart with different keys (two tabs) make one order, not two', async () => {
    const b = browser();
    await add(b, 'nura-019', 'M');
    const [r1, r2] = await Promise.all([checkout(b), checkout(b)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 400]);
    expect([r1, r2].find((r) => r.status === 400).body.error).toMatch(/cart is empty/);
  });
});

describe('who can see an order', () => {
  it('the guest who placed it can; another browser gets 404; nonsense ids get 400', async () => {
    const owner = browser(), other = browser();
    await add(owner, 'nura-021', 'ONE SIZE');
    const { order } = (await checkout(owner)).body;
    expect((await as(owner).get(`/api/orders/${order.id}`)).status).toBe(200);
    expect((await as(other).get(`/api/orders/${order.id}`)).status).toBe(404);
    expect((await as(app).get(`/api/orders/${order.id}`)).status).toBe(404);
    expect((await as(owner).get('/api/orders/NURA-000001')).status).toBe(400);
    expect((await as(owner).get(`/api/orders/${randomUUID()}`)).status).toBe(404);
    expect((await as(owner).get(`/api/orders/${order.id}`)).headers['cache-control']).toBe('no-store');
  });

  it('a signed-in shopper sees their history; nobody else sees their orders', async () => {
    const me = browser(), stranger = browser();
    const email = `hist${Date.now()}@example.com`;
    await as(me).post('/api/auth/register').send({ name: 'Otieno O', email, password: 'correct horse battery' });
    await as(stranger).post('/api/auth/register').send({ name: 'S S', email: `s${email}`, password: 'correct horse battery' });
    await add(me, 'nura-020', 'S');
    const { order } = (await checkout(me, { email })).body;
    expect(order.guest).toBe(false);
    const hist = (await as(me).get('/api/orders')).body.orders;
    expect(hist[0]).toMatchObject({ id: order.id, number: order.number, itemCount: 1, totalKes: 3900 });
    expect((await as(stranger).get(`/api/orders/${order.id}`)).status).toBe(404);
    expect((await as(stranger).get('/api/orders')).body.orders).toEqual([]);
    expect((await as(app).get('/api/orders')).status).toBe(401);
  });

  it('guest orders join the account on sign-up, only for the same email and browser', async () => {
    const b = browser();
    const email = `claim${Date.now()}@example.com`;
    await add(b, 'nura-021', 'ONE SIZE');
    const mine = (await checkout(b, { email })).body.order;
    await add(b, 'nura-004', 'ONE SIZE');
    const forSomeoneElse = (await checkout(b, { email: 'gift.recipient@example.com' })).body.order;
    await as(b).post('/api/auth/register').send({ name: 'Njeri W', email, password: 'correct horse battery' });
    const ids = (await as(b).get('/api/orders')).body.orders.map((o) => o.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(forSomeoneElse.id);
  });
});

describe('unpaid orders expire (for M-Pesa and cards, Phases 5-6)', () => {
  it('returns the stock, closes the payment and records why', async () => {
    const b = browser();
    await add(b, 'nura-014', 'L', 2);
    // placeOrder is called directly here, because the checkout route refuses M-Pesa until Phase 5.
    const cartId = (await db.execute(sql`select c.id from carts c join cart_items ci on ci.cart_id = c.id
      where ci.variant_id = ${V['nura-014/L']} order by c.updated_at desc limit 1`)).rows[0].id;
    const before = await stockOf('nura-014', 'L');
    const { id } = await placeOrder({ cartId, userId: null, details: { ...form(), phone: '254712345678', paymentMethod: 'MPESA' } });
    expect(await stockOf('nura-014', 'L')).toBe(before - 2);
    expect(await expireOrders(new Date())).toBe(0);               // still inside its window
    const expired = await expireOrders(new Date(Date.now() + 16 * 60 * 1000));
    expect(expired).toBeGreaterThanOrEqual(1);
    const [o] = (await db.execute(sql`select status from orders where id = ${id}`)).rows;
    expect(o.status).toBe('EXPIRED');
    expect(await stockOf('nura-014', 'L')).toBe(before);
    const [p] = (await db.execute(sql`select status, failure_reason from payments where order_id = ${id}`)).rows;
    expect(p).toEqual({ status: 'FAILED', failure_reason: 'Payment window expired' });
    expect(await expireOrders(new Date(Date.now() + 60 * 60 * 1000))).toBe(0);   // never twice
  });

  it('COD orders never expire', async () => {
    const b = browser();
    await add(b, 'nura-021', 'ONE SIZE');
    const { order } = (await checkout(b)).body;
    await expireOrders(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
    const [o] = (await db.execute(sql`select status from orders where id = ${order.id}`)).rows;
    expect(o.status).toBe('AWAITING_COD');
  });
});
