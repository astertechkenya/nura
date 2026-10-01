import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { sessionStore } from '../src/middleware/session.js';
import { seed } from '../src/db/seed.js';
import { codeAt, newSecret, verifyCode, base32Encode } from '../src/lib/totp.js';
import { netlifyToken } from './helpers.js';

const app = createApp();
const PW = 'admin password long enough';
let V, SECRET;

beforeAll(async () => {
  await db.execute(sql`update product_variants set stock = stock + 50`);
  const res = await request(app).get('/api/products');
  V = {};
  for (const p of res.body.products) for (const v of p.variants) V[`${p.sku}/${v.size}`] = v.id;
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  SECRET = newSecret();
  await db.insert(users).values([
    { email: 'boss@nura.test', name: 'Boss Admin', role: 'ADMIN', passwordHash: hash, totpSecret: SECRET },
    { email: 'looker@nura.test', name: 'Demo Looker', role: 'DEMO_ADMIN', passwordHash: hash },
    { email: 'shopper@nura.test', name: 'Just Shopping', role: 'CUSTOMER', passwordHash: hash },
    // Its own account, so locking it out doesn't lock out the other tests' admin.
    { email: 'guessed@nura.test', name: 'Guessed Admin', role: 'ADMIN', passwordHash: hash, totpSecret: SECRET },
  ]).onConflictDoNothing();
});
afterAll(async () => { await seed({ log: () => {} }); sessionStore.close(); await pool.end(); });

let ipCounter = 0;
function as(agentOrApp) {
  const ip = `10.8.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  const target = typeof agentOrApp === 'function' ? request(agentOrApp) : agentOrApp;
  const wrap = (m) => (url) => target[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch') };
}
async function signIn(email, { code = true } = {}) {
  const b = request.agent(app);
  expect((await as(b).post('/api/auth/login').send({ email, password: PW })).status).toBe(200);
  if (code && email === 'boss@nura.test') {
    const r = await as(b).post('/api/admin/totp').send({ code: codeAt(SECRET, Math.floor(Date.now() / 30000)) });
    expect(r.status).toBe(200);
  }
  return b;
}
async function codOrder(extra = {}) {
  const b = request.agent(app);
  await as(b).post('/api/cart/items').send({ variantId: V['nura-021/ONE SIZE'], qty: 2 });
  const res = await as(b).post('/api/checkout').send({
    checkoutKey: randomUUID(), email: 'kamau.w@example.com', phone: '0722 123 456', name: 'Kamau Wanjiru',
    addressLine1: 'Flat 9, Ngong Rd', area: 'Kilimani', county: 'Nairobi', paymentMethod: 'COD', ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.order;
}
const stock = async (key) => (await db.execute(sql`select stock from product_variants where id = ${V[key]}`)).rows[0].stock;

describe('two-factor codes', () => {
  it('match the official test values (RFC 6238)', () => {
    const s = base32Encode(Buffer.from('12345678901234567890'));
    expect(codeAt(s, Math.floor(59 / 30))).toBe('287082');
    expect(codeAt(s, Math.floor(1111111109 / 30))).toBe('081804');
  });
  it('accept the current code and one step either side, nothing else', () => {
    const now = Date.now(), step = Math.floor(now / 30000);
    expect(verifyCode(SECRET, codeAt(SECRET, step), now)).toBe(true);
    expect(verifyCode(SECRET, codeAt(SECRET, step - 1), now)).toBe(true);
    expect(verifyCode(SECRET, codeAt(SECRET, step - 3), now)).toBe(false);
    expect(verifyCode(SECRET, '12345', now)).toBe(false);
  });
});

describe('who gets in', () => {
  it('nobody signed in: 401; a customer: 403', async () => {
    expect((await as(app).get('/api/admin/summary')).status).toBe(401);
    const shopper = await signIn('shopper@nura.test');
    expect((await as(shopper).get('/api/admin/summary')).status).toBe(403);
  });

  it('an admin must enter the current code first; wrong codes are refused and limited', async () => {
    const b = await signIn('boss@nura.test', { code: false });
    const me = await as(b).get('/api/admin/me');
    expect(me.body).toMatchObject({ role: 'ADMIN', needsTotp: true });
    const blocked = await as(b).get('/api/admin/orders');
    expect(blocked.status).toBe(401);
    expect(blocked.body.needsTotp).toBe(true);
    expect((await as(b).post('/api/admin/totp').send({ code: '000000' })).status).toBe(401);
    expect((await as(b).post('/api/admin/totp').send({ code: codeAt(SECRET, Math.floor(Date.now() / 30000)) })).status).toBe(200);
    expect((await as(b).get('/api/admin/orders')).status).toBe(200);
    expect((await as(b).get('/api/admin/me')).body.needsTotp).toBe(false);
  });

  it('someone with the password can’t spread code guesses over many IP addresses, or sign in again for more', async () => {
    // as() gives every request a different client IP: exactly what a botnet would do.
    const b = await signIn('guessed@nura.test', { code: false });
    const wrong = (agent) => as(agent).post('/api/admin/totp').send({ code: '000000' });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await wrong(b)).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    const right = () => ({ code: codeAt(SECRET, Math.floor(Date.now() / 30000)) });
    expect((await as(b).post('/api/admin/totp').send(right())).status).toBe(429);       // even the right code waits
    const again = await signIn('guessed@nura.test', { code: false });                   // a fresh session doesn't reset it
    expect((await as(again).post('/api/admin/totp').send(right())).status).toBe(429);
  });

  it('right codes never count against the limit: signing in on many devices is fine', async () => {
    await db.execute(sql`insert into users (email, name, role, password_hash, totp_secret)
      select 'busy@nura.test', 'Busy Admin', 'ADMIN', password_hash, ${SECRET} from users where email = 'boss@nura.test'
      on conflict do nothing`);
    for (let i = 0; i < 7; i++) {
      const b = await signIn('busy@nura.test', { code: false });
      expect((await as(b).post('/api/admin/totp').send({ code: codeAt(SECRET, Math.floor(Date.now() / 30000)) })).status, `sign-in ${i + 1}`).toBe(200);
    }
  });

  it('demoting an admin takes effect on the very next request', async () => {
    const hash = await argon2.hash(PW, { type: argon2.argon2id });
    await db.insert(users).values({ email: 'temp@nura.test', name: 'Temp', role: 'DEMO_ADMIN', passwordHash: hash });
    const b = await signIn('temp@nura.test');
    expect((await as(b).get('/api/admin/summary')).status).toBe(200);
    await db.execute(sql`update users set role = 'CUSTOMER' where email = 'temp@nura.test'`);
    expect((await as(b).get('/api/admin/summary')).status).toBe(403);
  });

  it('an admin session ends after 8 hours idle', async () => {
    const b = await signIn('boss@nura.test');
    expect((await as(b).get('/api/admin/summary')).status).toBe(200);
    await db.execute(sql`update sessions set sess = jsonb_set(sess, '{adminSeenAt}', to_jsonb((extract(epoch from now()) * 1000 - 9 * 3600 * 1000)::bigint))
                         where sess->>'userId' = (select id::text from users where email = 'boss@nura.test')`);
    const res = await as(b).get('/api/admin/summary');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/8 hours/);
  });
});

describe('the demo admin', () => {
  it('sees everything, with personal details masked', async () => {
    const order = await codOrder();
    const b = await signIn('looker@nura.test');
    const list = (await as(b).get('/api/admin/orders?q=' + order.number)).body.orders[0];
    expect(list).toMatchObject({ number: order.number, customerName: 'Kamau W.', phone: '2547••••56' });
    const d = (await as(b).get(`/api/admin/orders/${order.id}`)).body.order;
    expect(d.customer).toEqual({ name: 'Kamau W.', email: 'k•••@example.com', phone: '2547••••56' });
    expect(d.delivery.addressLine1).toBe('•••');
    expect(JSON.stringify(d)).not.toMatch(/kamau\.w@|722123456|Ngong/);
  });

  it('every change is refused with 403, and nothing changes', async () => {
    const order = await codOrder();
    const b = await signIn('looker@nura.test');
    const products = (await as(b).get('/api/admin/products')).body.products;
    const tries = [
      as(b).post(`/api/admin/orders/${order.id}/transition`).send({ to: 'PROCESSING' }),
      as(b).post(`/api/admin/orders/${order.id}/cod-collected`).send({}),
      as(b).patch(`/api/admin/products/${products[0].id}`).send({ priceKes: 1 }),
      as(b).patch(`/api/admin/variants/${products[0].variants[0].id}`).send({ stock: 0 }),
    ];
    for (const res of await Promise.all(tries)) expect(res.status).toBe(403);
    expect((await db.execute(sql`select status from orders where id = ${order.id}`)).rows[0].status).toBe('AWAITING_COD');
  });
});

describe('running an order, the COD way', () => {
  it('confirm → ship → cash collected: DELIVERED and PAID, every step recorded and audited', async () => {
    const order = await codOrder();
    const b = await signIn('boss@nura.test');
    let d = (await as(b).get(`/api/admin/orders/${order.id}`)).body.order;
    expect(d.customer.phone).toBe('254722123456');                          // the real admin sees it all
    expect(d.actions).toEqual([{ action: 'transition', to: 'PROCESSING' }, { action: 'transition', to: 'CANCELLED' }]);

    d = (await as(b).post(`/api/admin/orders/${order.id}/transition`).send({ to: 'PROCESSING', note: 'Confirmed by phone' })).body.order;
    d = (await as(b).post(`/api/admin/orders/${order.id}/transition`).send({ to: 'SHIPPED' })).body.order;
    expect(d.actions).toEqual([{ action: 'cod-collected', to: 'DELIVERED' }]);   // not a plain "delivered"
    const plain = await as(b).post(`/api/admin/orders/${order.id}/transition`).send({ to: 'DELIVERED' });
    expect(plain.status).toBe(409);
    expect(plain.body.error).toMatch(/Cash collected/);

    d = (await as(b).post(`/api/admin/orders/${order.id}/cod-collected`).send({})).body.order;
    expect(d.status).toBe('DELIVERED');
    expect(d.payments.at(-1)).toMatchObject({ provider: 'COD', status: 'PAID', receipt: 'Cash' });
    expect(d.events.map((e) => e.to)).toEqual(['AWAITING_COD', 'PROCESSING', 'SHIPPED', 'DELIVERED']);
    expect(d.events[1]).toMatchObject({ note: 'Confirmed by phone', by: 'Boss Admin' });
    expect(d.actions).toEqual([]);                                          // DELIVERED is final

    const log = (await as(b).get('/api/admin/activity')).body.activity.filter((a) => a.entityId === order.id);
    expect(log.map((a) => a.action).sort()).toEqual(['order.cod-collected', 'order.transition', 'order.transition']);
  });

  it('moves that aren’t allowed are refused, whatever the admin asks', async () => {
    const order = await codOrder();
    const b = await signIn('boss@nura.test');
    for (const to of ['SHIPPED', 'PAID', 'EXPIRED', 'PENDING_PAYMENT']) {
      expect((await as(b).post(`/api/admin/orders/${order.id}/transition`).send({ to })).status, to).toBe(409);
    }
    expect((await as(b).post(`/api/admin/orders/${order.id}/transition`).send({ to: 'NONSENSE' })).status).toBe(400);
  });

  it('cancelling gives the stock back and closes the cash payment', async () => {
    const before = await stock('nura-021/ONE SIZE');
    const order = await codOrder();
    expect(await stock('nura-021/ONE SIZE')).toBe(before - 2);
    const b = await signIn('boss@nura.test');
    const d = (await as(b).post(`/api/admin/orders/${order.id}/transition`).send({ to: 'CANCELLED', note: 'Customer changed their mind' })).body.order;
    expect(d).toMatchObject({ status: 'CANCELLED', refundStatus: 'NONE' });
    expect(d.payments[0].status).toBe('FAILED');
    expect(await stock('nura-021/ONE SIZE')).toBe(before);
  });

  it('cancelling an order that was paid marks a refund due; "refunded" closes it', async () => {
    const order = await codOrder();
    await db.execute(sql`update orders set status = 'PAID', payment_method = 'MPESA' where id = ${order.id}`);
    await db.execute(sql`update payments set status = 'PAID', provider = 'DARAJA' where order_id = ${order.id}`);
    const b = await signIn('boss@nura.test');
    let d = (await as(b).post(`/api/admin/orders/${order.id}/transition`).send({ to: 'CANCELLED' })).body.order;
    expect(d.refundStatus).toBe('DUE');
    expect((await as(b).get('/api/admin/orders?status=REFUND_DUE')).body.orders.map((o) => o.id)).toContain(order.id);
    d = (await as(b).post(`/api/admin/orders/${order.id}/refunded`).send({ note: 'M-Pesa reversal QK12' })).body.order;
    expect(d.refundStatus).toBe('DONE');
    expect((await as(b).post(`/api/admin/orders/${order.id}/refunded`).send({})).status).toBe(409);
  });
});

describe('lists and the dashboard', () => {
  it('"to do" holds what needs action; search finds by number, name or phone', async () => {
    const order = await codOrder({ name: 'Findable Otieno' });
    const b = await signIn('boss@nura.test');
    const todo = (await as(b).get('/api/admin/orders?status=TODO')).body.orders;
    expect(todo.every((o) => ['AWAITING_COD', 'PAID', 'PROCESSING'].includes(o.status))).toBe(true);
    for (const q of [order.number, 'findable', '722123456']) {
      const found = (await as(b).get(`/api/admin/orders?q=${encodeURIComponent(q)}`)).body.orders;
      expect(found.map((o) => o.id), q).toContain(order.id);
    }
    const s = (await as(b).get('/api/admin/summary')).body;
    expect(s.toDo).toBeGreaterThan(0);
    expect(s).toHaveProperty('lowStock');
  });
});

describe('products', () => {
  it('change price and sale, hide and show, set stock: all audited', async () => {
    const b = await signIn('boss@nura.test');
    const p = (await as(b).get('/api/admin/products')).body.products.find((x) => x.sku === 'nura-012');
    let res = await as(b).patch(`/api/admin/products/${p.id}`).send({ priceKes: 7900, compareAtKes: 9900 });
    expect(res.status).toBe(200);
    const pub = (await request(app).get('/api/products/relaxed-linen-shirt')).body.product;
    expect(pub).toMatchObject({ priceKes: 7900, compareAtKes: 9900, onSale: true });

    expect((await as(b).patch(`/api/admin/products/${p.id}`).send({ compareAtKes: 7000 })).status).toBe(400);
    expect((await as(b).patch(`/api/admin/products/${p.id}`).send({ priceKes: 7900, name: 'x' })).status).toBe(400);
    expect((await as(b).patch(`/api/admin/products/${p.id}`).send({})).status).toBe(400);

    await as(b).patch(`/api/admin/products/${p.id}`).send({ isActive: false });
    expect((await request(app).get('/api/products/relaxed-linen-shirt')).status).toBe(404);
    await as(b).patch(`/api/admin/products/${p.id}`).send({ isActive: true, compareAtKes: null });

    res = await as(b).patch(`/api/admin/variants/${p.variants[0].id}`).send({ stock: 12 });
    expect(res.status).toBe(200);
    expect((await as(b).patch(`/api/admin/variants/${p.variants[0].id}`).send({ stock: -1 })).status).toBe(400);

    const log = (await as(b).get('/api/admin/activity')).body.activity;
    const mine = log.filter((a) => a.entityId === p.id || a.entityId === p.variants[0].id);
    expect(mine.map((a) => a.action)).toEqual(expect.arrayContaining(['product.update', 'stock.set']));
    expect(mine.find((a) => a.action === 'stock.set')).toMatchObject({ after: { stock: 12 }, by: 'Boss Admin' });
  });
});
