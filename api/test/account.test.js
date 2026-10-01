// Phase 7.6: the account page's API. Profile and last delivery details, changing the password,
// deleting the account. Each is tested from three sides: the owner, a stranger, and someone
// with the owner's signed-in laptop but not their password.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { sessionStore } from '../src/middleware/session.js';
import { seed } from '../src/db/seed.js';
import { mailSettled, outbox } from '../src/services/mail.js';
import { netlifyToken } from './helpers.js';

const app = createApp();
let V;
const PW = 'correct horse battery';

beforeAll(async () => {
  await db.execute(sql`update product_variants set stock = stock + 50`);
  const res = await request(app).get('/api/products');
  V = {};
  for (const p of res.body.products) for (const v of p.variants) V[`${p.sku}/${v.size}`] = v.id;
});
afterAll(async () => { await seed({ log: () => {} }); sessionStore.close(); await pool.end(); });
beforeEach(() => { outbox.length = 0; });

let ip = 0;
const as = (agent) => {
  const addr = `10.11.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`;
  const wrap = (m) => (url) => agent[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', addr);
  return { get: wrap('get'), post: wrap('post') };
};
const uniq = () => `acct${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
async function customer() {
  const agent = request.agent(app);
  const email = uniq();
  await as(agent).post('/api/auth/register').send({ name: 'Wanjiku Mwangi', email, password: PW });
  return { agent, email };
}
async function codOrder(agent, { area = 'Westlands', line = 'Hse 12, Riverside Lane' } = {}) {
  await as(agent).post('/api/cart/items').send({ variantId: V['nura-021/ONE SIZE'] });
  const res = await as(agent).post('/api/checkout').send({
    checkoutKey: randomUUID(), email: 'whatever@example.com', phone: '0712 345 678', name: 'Wanjiku M',
    addressLine1: line, area, county: 'Nairobi', paymentMethod: 'COD',
  });
  return res.body.order;
}
const login = (email, password) => as(request.agent(app)).post('/api/auth/login').send({ email, password });

describe('GET /api/account', () => {
  it('signed out: 401 for every account route', async () => {
    const b = request.agent(app);
    expect((await as(b).get('/api/account')).status).toBe(401);
    expect((await as(b).post('/api/account/password').send({ currentPassword: 'x', newPassword: 'yyyyyyyy' })).status).toBe(401);
    expect((await as(b).post('/api/account/delete').send({ password: 'x' })).status).toBe(401);
  });

  it('profile, and delivery details from the latest order (none before the first)', async () => {
    const { agent, email } = await customer();
    let res = await as(agent).get('/api/account');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ user: { name: 'Wanjiku Mwangi', email }, lastDelivery: null });
    await codOrder(agent, { area: 'Kilimani', line: 'Apt 4, Argwings Kodhek Rd' });
    await codOrder(agent, { area: 'Westlands', line: 'Hse 12, Riverside Lane' });
    res = await as(agent).get('/api/account');
    expect(res.body.lastDelivery).toEqual({ name: 'Wanjiku M', phone: '254712345678',
      addressLine1: 'Hse 12, Riverside Lane', area: 'Westlands', county: 'Nairobi' });
  });
});

describe('changing the password', () => {
  it('needs the current password; refuses the same one again, or a short one', async () => {
    const { agent } = await customer();
    const change = (body) => as(agent).post('/api/account/password').send(body);
    expect((await change({ currentPassword: 'wrong password', newPassword: 'a brand new one' })).body.error).toMatch(/current password isn’t right/);
    expect((await change({ currentPassword: PW, newPassword: PW })).body.error).toMatch(/different/);
    expect((await change({ currentPassword: PW, newPassword: 'short' })).status).toBe(400);
  });

  it('works: old password dead, new one works, this browser stays in, other devices are out, and an email says so', async () => {
    const { agent: laptop, email } = await customer();
    const phone = request.agent(app);
    await as(phone).post('/api/auth/login').send({ email, password: PW });
    expect((await as(phone).get('/api/auth/me')).body.user).not.toBeNull();

    const res = await as(laptop).post('/api/account/password').send({ currentPassword: PW, newPassword: 'a brand new passphrase' });
    expect(res.status).toBe(200);
    expect((await as(laptop).get('/api/auth/me')).body.user.email).toBe(email);   // still signed in here
    expect((await as(phone).get('/api/auth/me')).body.user).toBeNull();          // signed out there
    expect((await login(email, PW)).status).toBe(401);
    expect((await login(email, 'a brand new passphrase')).status).toBe(200);
    await mailSettled();
    expect(outbox.filter((m) => m.to === email && m.subject === 'Your NURA password was changed')).toHaveLength(1);
  });

  it('someone at a signed-in laptop can’t guess the password at speed: 6th try refused', async () => {
    const { agent } = await customer();
    const codes = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await as(agent).post('/api/account/password').send({ currentPassword: `guess ${i}`, newPassword: 'whatever long' })).status);
    }
    expect(codes).toEqual([400, 400, 400, 400, 400, 429]);
  });
});

describe('deleting the account', () => {
  it('needs the password', async () => {
    const { agent, email } = await customer();
    expect((await as(agent).post('/api/account/delete').send({ password: 'nope nope' })).status).toBe(400);
    expect((await login(email, PW)).status).toBe(200);                            // nothing happened
  });

  it('erases the account, cart, wishlist, sessions and newsletter; keeps the orders, unlinked', async () => {
    const { agent, email } = await customer();
    const order = await codOrder(agent);
    await as(agent).post('/api/cart/items').send({ variantId: V['nura-002/M'] });
    await as(agent).post('/api/wishlist').send({ skus: ['nura-007'] });
    await as(request.agent(app)).post('/api/newsletter').send({ email });
    const other = request.agent(app);
    await as(other).post('/api/auth/login').send({ email, password: PW });
    const [{ id: userId }] = (await db.execute(sql`select id from users where email = ${email}`)).rows;

    const res = await as(agent).post('/api/account/delete').send({ password: PW });
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie'].join(';')).toMatch(/nura\.sid=;/);         // cookie cleared
    expect((await as(agent).get('/api/auth/me')).body.user).toBeNull();
    expect((await as(other).get('/api/auth/me')).body.user).toBeNull();
    expect((await login(email, PW)).status).toBe(401);

    const count = async (q) => (await db.execute(q)).rows[0].n;
    expect(await count(sql`select count(*)::int as n from users where id = ${userId}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from carts where user_id = ${userId}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from wishlist_items where user_id = ${userId}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from sessions where sess->>'userId' = ${userId}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from newsletter_subscribers where email = ${email}`)).toBe(0);
    const [kept] = (await db.execute(sql`select user_id, number from orders where id = ${order.id}`)).rows;
    expect(kept).toEqual({ user_id: null, number: order.number });               // the record stays

    await mailSettled();
    expect(outbox.filter((m) => m.to === email && m.subject === 'Your NURA account has been deleted')).toHaveLength(1);
  });

  it('admin accounts can’t be deleted this way (they sign the audit log)', async () => {
    const { agent, email } = await customer();
    await db.execute(sql`update users set role = 'ADMIN' where email = ${email}`);
    const res = await as(agent).post('/api/account/delete').send({ password: PW });
    expect(res.status).toBe(403);
    expect(await (await db.execute(sql`select count(*)::int as n from users where email = ${email}`)).rows[0].n).toBe(1);
  });
});

describe('the order page knows about refunds', () => {
  it('a refund due shows with the amount actually paid', async () => {
    const { agent } = await customer();
    const order = await codOrder(agent);
    expect((await as(agent).get(`/api/orders/${order.id}`)).body.order.refund).toBeNull();
    await db.execute(sql`update payments set status = 'PAID' where order_id = ${order.id}`);
    await db.execute(sql`update orders set status = 'CANCELLED', refund_status = 'DUE' where id = ${order.id}`);
    expect((await as(agent).get(`/api/orders/${order.id}`)).body.order.refund).toEqual({ status: 'DUE', kes: 2400 });
  });
});
