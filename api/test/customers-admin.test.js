// Phase 7: the admin's Customers screen and the newsletter export.
// The rules: only shopper accounts are listed, with orders that were really placed and money that
// really came in; the demo admin sees masked details, can't search by email and can't export;
// the export holds confirmed subscribers only, can't carry a spreadsheet formula, and is audited.
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
import { codeAt, newSecret } from '../src/lib/totp.js';
import { csvCell } from '../src/services/admin.js';
import { netlifyToken } from './helpers.js';

const app = createApp();
const PW = 'admin password long enough';
const SHOPPER = `wairimu${Date.now()}@example.com`;
let SECRET, admin, looker;

let ip = 0;
const as = (agent) => {
  const addr = `10.14.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`;
  const wrap = (m) => (url) => agent[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', addr);
  return { get: wrap('get'), post: wrap('post') };
};
async function signIn(email, withCode) {
  const b = request.agent(app);
  expect((await as(b).post('/api/auth/login').send({ email, password: PW })).status).toBe(200);
  if (withCode) expect((await as(b).post('/api/admin/totp').send({ code: codeAt(SECRET, Math.floor(Date.now() / 30000)) })).status).toBe(200);
  return b;
}

beforeAll(async () => {
  SECRET = newSecret();
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  await db.insert(users).values([
    { email: 'counter@nura.test', name: 'Counter Admin', role: 'ADMIN', passwordHash: hash, totpSecret: SECRET },
    { email: 'glancer@nura.test', name: 'Demo Glancer', role: 'DEMO_ADMIN', passwordHash: hash },
  ]).onConflictDoNothing();
  admin = await signIn('counter@nura.test', true);
  looker = await signIn('glancer@nura.test', false);

  // A shopper with three orders: one delivered (KSh counted), one awaiting cash (placed, no money
  // yet), one M-Pesa attempt that expired (not placed at all).
  const shopper = request.agent(app);
  expect((await as(shopper).post('/api/auth/register').send({ name: 'Wairimu Njeri Kamau', email: SHOPPER, password: 'shopper password 1' })).status).toBe(201);
  const { products } = (await request(app).get('/api/products')).body;
  const variantId = products.find((p) => p.sku === 'nura-021').variants[0].id;
  await db.execute(sql`update product_variants set stock = stock + 10 where id = ${variantId}`);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    await as(shopper).post('/api/cart/items').send({ variantId });
    const res = await as(shopper).post('/api/checkout').send({
      checkoutKey: randomUUID(), email: SHOPPER, phone: '0722 123 456', name: 'Wairimu Njeri Kamau',
      addressLine1: 'Flat 2, Argwings Kodhek Rd', area: 'Kilimani', county: 'Nairobi', paymentMethod: 'COD',
    });
    expect(res.status).toBe(201);
    ids.push(res.body.order.id);
  }
  await db.execute(sql`update orders set status = 'DELIVERED' where id = ${ids[0]}`);
  await db.execute(sql`update orders set status = 'EXPIRED', payment_method = 'MPESA' where id = ${ids[2]}`);
  await db.execute(sql`insert into newsletter_subscribers (email, status, confirmed_at) values (${SHOPPER}, 'confirmed', now())`);
});
afterAll(async () => {
  await db.execute(sql`delete from newsletter_subscribers where email like '%@csv.test' or email = ${SHOPPER}`);
  await seed({ log: () => {} }); sessionStore.close(); await pool.end();
});

describe('the customers list', () => {
  it('a shopper with placed orders, money in, and newsletter status; admins aren’t customers', async () => {
    const res = await as(admin).get('/api/admin/customers?q=wairimu');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const [c] = res.body.customers;
    const { rows: [{ total }] } = await db.execute(sql`select total_kes as total from orders where email = ${SHOPPER} and status = 'DELIVERED'`);
    expect(c).toMatchObject({ name: 'Wairimu Njeri Kamau', email: SHOPPER, orderCount: 2, spentKes: total, newsletter: 'confirmed' });
    expect(c.lastOrderAt).toBeTruthy();
    const all = (await as(admin).get('/api/admin/customers')).body;
    expect(all.customers.map((x) => x.email)).not.toContain('counter@nura.test');
    expect(all.newsletter.confirmed).toBeGreaterThanOrEqual(1);
  });

  it('the demo admin sees masked details and can’t search by email', async () => {
    const [c] = (await as(looker).get('/api/admin/customers?q=wairimu')).body.customers;
    expect(c.name).toBe('Wairimu N. K.');
    expect(c.email).toMatch(/^w•••@example\.com$/);
    expect((await as(looker).get(`/api/admin/customers?q=${encodeURIComponent(SHOPPER)}`)).body.customers).toHaveLength(0);
    expect((await as(admin).get(`/api/admin/customers?q=${encodeURIComponent(SHOPPER)}`)).body.customers).toHaveLength(1);
  });

  it('search wildcards are taken literally', async () => {
    expect((await as(admin).get('/api/admin/customers?q=%25')).body.customers).toHaveLength(0);
  });

  it('a shopper can’t see it', async () => {
    const b = request.agent(app);
    await as(b).post('/api/auth/login').send({ email: SHOPPER, password: 'shopper password 1' });
    expect((await as(b).get('/api/admin/customers')).status).toBe(403);
  });
});

describe('the newsletter export', () => {
  it('confirmed only, safe to open in Excel, audited', async () => {
    await db.execute(sql`insert into newsletter_subscribers (email, status, confirmed_at) values
      ('-2+3@csv.test', 'confirmed', now()), ('waiting@csv.test', 'pending', null), ('left@csv.test', 'unsubscribed', now())`);
    const res = await as(admin).get('/api/admin/newsletter.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="nura-newsletter-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.startsWith('﻿"email","confirmed_at"\r\n')).toBe(true);
    expect(res.text).toContain(`"${SHOPPER}"`);
    expect(res.text).toContain(`"'-2+3@csv.test"`);              // can't run as a formula
    expect(res.text).not.toContain('waiting@csv.test');
    expect(res.text).not.toContain('left@csv.test');
    const [log] = (await db.execute(sql`select after from admin_actions where action = 'newsletter.export' order by created_at desc limit 1`)).rows;
    expect(log.after.rows).toBe(res.text.trim().split('\r\n').length - 1);
  });

  it('the demo admin can’t download it', async () => {
    expect((await as(looker).get('/api/admin/newsletter.csv')).status).toBe(403);
  });

  it('every formula start is neutralised; quotes are doubled', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(s)).toBe(`"'${s}"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('plain@x.co')).toBe('"plain@x.co"');
  });
});
