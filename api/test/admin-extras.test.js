// Oct 2026: sale windows, the Insights page and bulk stock.
//   - A sale can have dates. Outside them the product sells at its "was" price everywhere:
//     catalogue, Sale filter, product page data, cart and checkout (one rule: lib/salePrice.js).
//   - Insights is read-only and safe for the demo admin.
//   - Restock (bulk stock) checks first and applies only on request, all or nothing, audited,
//     and refuses a size that sold while the admin was editing.
//   - Delete removes a product but never an open order's stock, and old orders keep their lines.
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
import { livePrice, saleIsOn } from '../src/lib/salePrice.js';
import { netlifyToken } from './helpers.js';

const app = createApp();
const PW = 'admin password long enough';
let SECRET, admin, looker;

let ip = 0;
const as = (agent) => {
  const addr = `10.31.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`;
  const wrap = (m) => (url) => agent[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', addr);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
};
async function signIn(email, withCode) {
  const b = request.agent(app);
  expect((await as(b).post('/api/auth/login').send({ email, password: PW })).status).toBe(200);
  if (withCode) expect((await as(b).post('/api/admin/totp').send({ code: codeAt(SECRET, Math.floor(Date.now() / 30000)) })).status).toBe(200);
  return b;
}
const productId = async (sku) => (await db.execute(sql`select id from products where sku = ${sku}`)).rows[0].id;
const publicProduct = async (sku) => (await as(request(app)).get('/api/products')).body.products.find((p) => p.sku === sku);
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;

beforeAll(async () => {
  SECRET = newSecret();
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  await db.insert(users).values([
    { email: 'extras-admin@nura.test', name: 'Extras Admin', role: 'ADMIN', passwordHash: hash, totpSecret: SECRET },
    { email: 'extras-demo@nura.test', name: 'Extras Demo', role: 'DEMO_ADMIN', passwordHash: hash },
  ]).onConflictDoNothing();
  admin = await signIn('extras-admin@nura.test', true);
  looker = await signIn('extras-demo@nura.test', false);
});
afterAll(async () => { await seed({ log: () => {} }); sessionStore.close(); await pool.end(); });

describe('the live price rule', () => {
  const p = { priceKes: 2100, compareAtKes: 3200 };
  const now = new Date('2026-11-28T12:00:00+03:00');
  it('no dates: on sale', () => expect(livePrice(p, now)).toEqual({ priceKes: 2100, compareAtKes: 3200, onSale: true }));
  it('before the start: the regular price, no "was"', () =>
    expect(livePrice({ ...p, saleStartsAt: new Date('2026-11-29T00:00:00+03:00') }, now)).toEqual({ priceKes: 3200, compareAtKes: null, onSale: false }));
  it('inside the window: on sale', () =>
    expect(saleIsOn({ ...p, saleStartsAt: new Date('2026-11-28T00:00:00+03:00'), saleEndsAt: new Date('2026-11-29T00:00:00+03:00') }, now)).toBe(true));
  it('at the end, exactly: over', () =>
    expect(saleIsOn({ ...p, saleEndsAt: new Date('2026-11-28T12:00:00+03:00') }, now)).toBe(false));
  it('no "was" price: never on sale, dates or not', () =>
    expect(livePrice({ priceKes: 5000, compareAtKes: null }, now)).toEqual({ priceKes: 5000, compareAtKes: null, onSale: false }));
});

describe('sale dates in the admin', () => {
  it('a sale that starts tomorrow: regular price on the shop, in the cart and at checkout', async () => {
    const id = await productId('nura-021');                               // belt: 2,100, was 3,200
    expect((await as(admin).patch(`/api/admin/products/${id}`).send({ saleStartsAt: iso(DAY) })).status).toBe(200);

    const p = await publicProduct('nura-021');
    expect(p).toMatchObject({ priceKes: 3200, compareAtKes: null, onSale: false });
    const sale = (await as(request(app)).get('/api/products?sale=true')).body.products.map((x) => x.sku);
    expect(sale).not.toContain('nura-021');                               // not on the Sale page yet

    const b = request.agent(app);
    expect((await as(b).post('/api/cart/items').send({ variantId: p.variants[0].id, qty: 1 })).status).toBe(201);
    const cart = (await as(b).get('/api/cart')).body.cart;
    expect(cart.items[0].lineTotalKes).toBe(3200);
    const order = await as(b).post('/api/checkout').send({
      checkoutKey: randomUUID(), email: 'dates@example.com', phone: '0712 345 678', name: 'Achieng Otieno',
      addressLine1: 'House 12, Lavington Green', area: 'Lavington', county: 'Nairobi', paymentMethod: 'COD',
    });
    expect(order.status).toBe(201);
    expect(order.body.order.subtotalKes).toBe(3200);                      // charged what was shown
  });

  it('a sale running now (started yesterday, ends next week) is on everywhere', async () => {
    const id = await productId('nura-021');
    expect((await as(admin).patch(`/api/admin/products/${id}`).send({ saleStartsAt: iso(-DAY), saleEndsAt: iso(7 * DAY) })).status).toBe(200);
    expect(await publicProduct('nura-021')).toMatchObject({ priceKes: 2100, compareAtKes: 3200, onSale: true });
    const listed = (await as(admin).get('/api/admin/products')).body.products.find((x) => x.sku === 'nura-021');
    expect(listed.saleOn).toBe(true);
    expect(new Date(listed.saleEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses an end before the start, and dates without a "was" price', async () => {
    const belt = await productId('nura-021');
    const r1 = await as(admin).patch(`/api/admin/products/${belt}`).send({ saleStartsAt: iso(2 * DAY), saleEndsAt: iso(DAY) });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/end after it starts/);
    const plain = (await db.execute(sql`select id from products where compare_at_kes is null limit 1`)).rows[0].id;
    const r2 = await as(admin).patch(`/api/admin/products/${plain}`).send({ saleEndsAt: iso(DAY) });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toMatch(/“was” price first/);
  });

  it('removing the sale clears its dates', async () => {
    const id = await productId('nura-021');
    expect((await as(admin).patch(`/api/admin/products/${id}`).send({ compareAtKes: null })).status).toBe(200);
    const row = (await db.execute(sql`select sale_starts_at, sale_ends_at from products where id = ${id}`)).rows[0];
    expect(row).toEqual({ sale_starts_at: null, sale_ends_at: null });
  });

  it('the demo admin can’t set dates', async () => {
    const id = await productId('nura-003');
    expect((await as(looker).patch(`/api/admin/products/${id}`).send({ saleEndsAt: iso(DAY) })).status).toBe(403);
  });
});

describe('insights', () => {
  it('30 Nairobi days of takings, best sellers, most wanted and carts left behind', async () => {
    // Someone wants a product that's sold out: it belongs on the restock list.
    const [u] = (await db.execute(sql`select id from users where email = 'extras-admin@nura.test'`)).rows;
    const p = await productId('nura-005');
    await db.execute(sql`update product_variants set stock = 0 where product_id = ${p}`);
    await db.execute(sql`insert into wishlist_items (user_id, product_id) values (${u.id}, ${p}) on conflict do nothing`);

    const res = await as(admin).get('/api/admin/insights');
    expect(res.status).toBe(200);
    const s = res.body;
    expect(s.daily).toHaveLength(30);
    expect(Object.keys(s.daily[0])).toEqual(['day', 'MPESA', 'CARD', 'COD']);
    expect(s.daily[29].day).toBe(new Date().toLocaleString('en-CA', { timeZone: 'Africa/Nairobi' }).slice(0, 10));
    expect(s.wantedSoldOut.map((x) => x.sku)).toContain('nura-005');
    expect(s.bestSellers.map((x) => x.sku)).toContain('nura-021');     // the order placed above
    expect(s.abandoned).toEqual({ carts: expect.any(Number), valueKes: expect.any(Number) });
  });

  it('is open to the demo admin: no names or contact details in it', async () => {
    const res = await as(looker).get('/api/admin/insights');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/@|07\d{8}|\+254/);
  });

  it('needs an admin', async () => {
    expect((await as(request(app)).get('/api/admin/insights')).status).toBe(401);
  });
});

describe('bulk stock', () => {
  const stock = async (sku, size) => (await db.execute(sql`
    select v.stock from product_variants v join products p on p.id = v.product_id where p.sku = ${sku} and v.size = ${size}`)).rows[0].stock;

  it('the spreadsheet download is gone (the Restock tab replaced it)', async () => {
    expect((await as(admin).get('/api/admin/stock.csv')).status).toBe(404);
  });

  it('checks first: shows the changes and writes nothing', async () => {
    const before = await stock('nura-003', 'M');
    const res = await as(admin).post('/api/admin/stock/bulk').send({ apply: false, rows: [
      { sku: 'nura-003', size: 'M', stock: before + 5 },
      { sku: 'nura-021', size: 'ONE SIZE', stock: await stock('nura-021', 'ONE SIZE') },
    ] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: false, unchanged: 1, errors: [] });
    expect(res.body.changes).toEqual([expect.objectContaining({ sku: 'nura-003', size: 'M', from: before, to: before + 5 })]);
    expect(await stock('nura-003', 'M')).toBe(before);
  });

  it('a sheet with a mistake changes nothing at all', async () => {
    const before = await stock('nura-003', 'M');
    const res = await as(admin).post('/api/admin/stock/bulk').send({ apply: true, rows: [
      { sku: 'nura-003', size: 'M', stock: 40 },
      { sku: 'nura-003', size: 'XXXL', stock: 1 },
      { sku: 'nura-003', size: 'M', stock: 41 },
    ] });
    expect(res.body.applied).toBe(false);
    expect(res.body.errors).toEqual(['nura-003 XXXL: no such size. It may have been deleted.', 'nura-003 M appears twice.']);
    expect(await stock('nura-003', 'M')).toBe(before);
  });

  it('applies, and audits each size it changed', async () => {
    const res = await as(admin).post('/api/admin/stock/bulk').send({ apply: true, rows: [{ sku: 'nura-003', size: 'M', stock: 17 }] });
    expect(res.body).toMatchObject({ applied: true, errors: [] });
    expect(await stock('nura-003', 'M')).toBe(17);
    const [log] = (await db.execute(sql`select action, after from admin_actions order by created_at desc limit 1`)).rows;
    expect(log).toMatchObject({ action: 'stock.set', after: { stock: 17, bulk: true } });
  });

  it('refuses a size that sold while the admin was editing, and saves nothing', async () => {
    const m = await stock('nura-003', 'M'), l = await stock('nura-003', 'L');
    const res = await as(admin).post('/api/admin/stock/bulk').send({ apply: true, rows: [
      { sku: 'nura-003', size: 'M', stock: m + 10, expect: m + 1 },   // the admin saw one more: one sold since
      { sku: 'nura-003', size: 'L', stock: l + 10, expect: l },
    ] });
    expect(res.body.applied).toBe(false);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatch(new RegExp(`M: changed while you were editing \\(was ${m + 1}, now ${m}\\)`));
    expect([await stock('nura-003', 'M'), await stock('nura-003', 'L')]).toEqual([m, l]);
    // Seen fresh, it saves.
    const ok = await as(admin).post('/api/admin/stock/bulk').send({ apply: true, rows: [{ sku: 'nura-003', size: 'M', stock: m + 10, expect: m }] });
    expect(ok.body.applied).toBe(true);
    expect(await stock('nura-003', 'M')).toBe(m + 10);
  });

  it('refuses negative stock, and the demo admin', async () => {
    expect((await as(admin).post('/api/admin/stock/bulk').send({ apply: false, rows: [{ sku: 'nura-003', size: 'M', stock: -1 }] })).status).toBe(400);
    expect((await as(looker).post('/api/admin/stock/bulk').send({ apply: false, rows: [{ sku: 'nura-003', size: 'M', stock: 1 }] })).status).toBe(403);
  });
});

describe('deleting a product', () => {
  // A throwaway copy of nura-001, so the seeded catalogue isn't touched.
  async function scratch(sku) {
    const id = randomUUID();
    await db.execute(sql`insert into products (id, sku, slug, name, brand_id, department, price_kes, image_url, arrived_at)
      select ${id}, ${sku}, ${sku}, ${'Scratch ' + sku}, brand_id, department, price_kes, image_url, now() from products where sku = 'nura-001'`);
    await db.execute(sql`insert into product_variants (product_id, size, stock) values (${id}, 'M', 4), (${id}, 'L', 2)`);
    return id;
  }
  // An order with one line of the product, in the given status.
  async function orderFor(productId, status) {
    const [v] = (await db.execute(sql`select id from product_variants where product_id = ${productId} and size = 'M'`)).rows;
    const oid = randomUUID(), no = `NURA-T${Math.floor(Math.random() * 1e6)}`;
    await db.execute(sql`insert into orders (id, number, email, phone, customer_name, status, payment_method, subtotal_kes, shipping_kes, total_kes, address_line1, address_area, address_city)
      values (${oid}, ${no}, 'del@nura.test', '254700000000', 'Del Test', ${status}, 'COD', 1000, 0, 1000, '1 Road', 'Area', 'Nairobi')`);
    await db.execute(sql`insert into order_items (order_id, product_id, variant_id, sku, name, size, unit_price_kes, qty)
      values (${oid}, ${productId}, ${v.id}, 'scratch', 'Scratch line', 'M', 1000, 1)`);
    return oid;
  }

  it('deletes it with its sizes, keeps old orders’ lines, and audits what it was', async () => {
    const id = await scratch('nura-del-1');
    const oid = await orderFor(id, 'DELIVERED');
    const res = await as(admin).delete(`/api/admin/products/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.products.find((p) => p.id === id)).toBeUndefined();
    expect((await db.execute(sql`select count(*)::int as n from product_variants where product_id = ${id}`)).rows[0].n).toBe(0);
    const [line] = (await db.execute(sql`select product_id, variant_id, name from order_items where order_id = ${oid}`)).rows;
    expect(line).toEqual({ product_id: null, variant_id: null, name: 'Scratch line' });
    const [log] = (await db.execute(sql`select action, before, after from admin_actions order by created_at desc limit 1`)).rows;
    expect(log).toMatchObject({ action: 'product.delete', after: null,
      before: { sku: 'nura-del-1', sizes: [{ size: 'M', stock: 4 }, { size: 'L', stock: 2 }] } });
    expect((await as(admin).delete(`/api/admin/products/${id}`)).status).toBe(404);
    await db.execute(sql`delete from orders where id = ${oid}`);
  });

  it('refuses while the product is in an open order, so a cancel can still return its stock', async () => {
    const id = await scratch('nura-del-2');
    const oid = await orderFor(id, 'AWAITING_COD');
    const res = await as(admin).delete(`/api/admin/products/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/1 open order\. Untick “Shown in shop”/);
    expect((await db.execute(sql`select count(*)::int as n from products where id = ${id}`)).rows[0].n).toBe(1);
    await db.execute(sql`delete from orders where id = ${oid}`);
    expect((await as(admin).delete(`/api/admin/products/${id}`)).status).toBe(200);
  });

  it('the demo admin can’t delete', async () => {
    const id = await scratch('nura-del-3');
    expect((await as(looker).delete(`/api/admin/products/${id}`)).status).toBe(403);
    await db.execute(sql`delete from products where id = ${id}`);
  });
});

describe('the demo admin can’t uncover hidden details (Oct 2026)', () => {
  it('order search: by number only, never by the masked email, phone or name', async () => {
    const no = `NURA-S${Math.floor(Math.random() * 1e6)}`;
    await db.execute(sql`insert into orders (number,email,phone,customer_name,status,payment_method,subtotal_kes,shipping_kes,total_kes,address_line1,address_area,address_city)
      values (${no},'hidden.person@nura.test','254711222333','Hidden Person','AWAITING_COD','COD',1000,0,1000,'1','A','Nairobi')`);
    const hits = async (who, q) => (await as(who).get(`/api/admin/orders?q=${encodeURIComponent(q)}`)).body.orders.map((o) => o.number);
    expect(await hits(admin, 'hidden.person@nura.test')).toContain(no);
    expect(await hits(looker, 'hidden.person@nura.test')).not.toContain(no);
    expect(await hits(looker, '0711222')).not.toContain(no);
    expect(await hits(looker, '2547112')).not.toContain(no);
    expect(await hits(looker, 'Person')).not.toContain(no);
    expect(await hits(looker, no)).toContain(no);
    await db.execute(sql`delete from orders where number = ${no}`);
  });

  it('phone numbers and emails typed into an order’s history are hidden', async () => {
    const no = `NURA-S${Math.floor(Math.random() * 1e6)}`;
    const [{ id }] = (await db.execute(sql`insert into orders (number,email,phone,customer_name,status,payment_method,subtotal_kes,shipping_kes,total_kes,address_line1,address_area,address_city)
      values (${no},'x@nura.test','254700000000','X','AWAITING_COD','COD',1000,0,1000,'1','A','Nairobi') returning id`)).rows;
    await db.execute(sql`insert into order_events (order_id, from_status, to_status, note) values (${id}, null, 'AWAITING_COD', 'Called her on 0712 345 678, also jane@x.com')`);
    const note = async (who) => (await as(who).get(`/api/admin/orders/${id}`)).body.order.events.at(-1).note;
    expect(await note(admin)).toContain('0712 345 678');
    expect(await note(looker)).toBe('Called her on •••, also •••');
    await db.execute(sql`delete from orders where id = ${id}`);
  });
});
