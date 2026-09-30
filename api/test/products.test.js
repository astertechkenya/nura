import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';

const app = createApp();
afterAll(() => pool.end());

describe('GET /api/health', () => {
  it('reports healthy when the database answers', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /api/products', () => {
  let body;
  const bySku = (sku) => body.products.find((p) => p.sku === sku);

  it('returns all 21 products from the database', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    body = res.body;
    expect(body.count).toBe(21);
    expect(body.products).toHaveLength(21);
  });

  it('prices are whole-shilling integers, never display strings', () => {
    for (const p of body.products) {
      expect(Number.isInteger(p.priceKes), p.sku).toBe(true);
      expect(p.priceKes).toBeGreaterThan(0);
    }
  });

  it('uses the prices you confirmed', () => {
    expect(bySku('nura-003')).toMatchObject({ priceKes: 5700, compareAtKes: 9500, onSale: true });
    expect(bySku('nura-018')).toMatchObject({ priceKes: 9750, compareAtKes: 13000, onSale: true });
  });

  it('on sale = has a "was" price; exactly the 8 products the pages show on sale', () => {
    const sale = body.products.filter((p) => p.onSale).map((p) => p.sku).sort();
    expect(sale).toEqual(['nura-003', 'nura-004', 'nura-010', 'nura-016', 'nura-018', 'nura-019', 'nura-020', 'nura-021']);
  });

  it('New In = the six New In page products; a product can be new AND on sale', () => {
    const fresh = body.products.filter((p) => p.isNew).map((p) => p.sku).sort();
    expect(fresh).toEqual(['nura-001', 'nura-002', 'nura-003', 'nura-004', 'nura-005', 'nura-006']);
    expect(bySku('nura-003')).toMatchObject({ isNew: true, onSale: true });
  });

  it('includes brand, department and sizes in shopping order', () => {
    expect(bySku('nura-002')).toMatchObject({
      brand: { name: 'KikoRomeo', slug: 'kikoromeo' }, department: 'WOMEN', style: 'Casual',
    });
    expect(bySku('nura-002').variants.map((v) => v.size)).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    expect(bySku('nura-018').variants.map((v) => v.size)[0]).toBe('UK 6');
    expect(bySku('nura-021').variants).toEqual([expect.objectContaining({ size: 'ONE SIZE' })]);
  });

  it('totalStock is the sum of its sizes; the blazer has one left in M', () => {
    const blazer = bySku('nura-002');
    expect(blazer.totalStock).toBe(blazer.variants.reduce((s, v) => s + v.stock, 0));
    expect(blazer.variants.find((v) => v.size === 'M').stock).toBe(1);
  });

  it('leaks no internal columns', () => {
    // arrivedAt IS public (Phase 7.5): New In sorts by it, and an arrival date isn't a secret.
    for (const key of ['brandId', 'isActive', 'createdAt', 'updatedAt']) {
      expect(bySku('nura-001'), key).not.toHaveProperty(key);
    }
  });

  it('hidden products disappear from the list', async () => {
    await db.execute(sql`update products set is_active = false where sku = 'nura-021'`);
    const res = await request(app).get('/api/products');
    expect(res.body.count).toBe(20);
    await db.execute(sql`update products set is_active = true where sku = 'nura-021'`);
  });
});

describe('errors', () => {
  it('unknown routes get JSON 404, not an HTML page', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
  it('malformed JSON is a 400 with no stack trace', async () => {
    const res = await request(app).post('/api/products').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js/);
  });
  it('every response carries a request ID for tracing', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('does not advertise Express', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

// The database's own rules. If application code ever has a bug, these still hold.
describe('database constraints', () => {
  const rejects = (q) => expect(db.execute(q)).rejects.toThrow();

  it('stock can never go below zero', () =>
    rejects(sql`update product_variants set stock = -1 where size = 'M'`));
  it('a "was" price must be above the price', () =>
    rejects(sql`update products set compare_at_kes = 100 where sku = 'nura-003'`));
  it('an order total must equal subtotal + shipping', () =>
    rejects(sql`insert into orders (number, email, phone, customer_name, status, payment_method, subtotal_kes, shipping_kes, total_kes, address_line1, address_area, address_city)
                values ('NURA-T1', 'a@b.co', '0712345678', 'A B', 'AWAITING_COD', 'COD', 1000, 300, 999, 'x', 'y', 'Nairobi')`));
  it('emails are unique regardless of case', () =>
    rejects(sql`insert into users (email, password_hash, name) values ('DEMO@nura.test', 'x', 'Dup')`));

  it('an order can have only one PENDING payment at a time', async () => {
    const [o] = (await db.execute(sql`insert into orders (number, email, phone, customer_name, status, payment_method, subtotal_kes, shipping_kes, total_kes, address_line1, address_area, address_city)
      values ('NURA-T2', 'a@b.co', '0712345678', 'A B', 'PENDING_PAYMENT', 'MPESA', 1000, 300, 1300, 'x', 'y', 'Nairobi') returning id`)).rows;
    await db.execute(sql`insert into payments (order_id, provider, amount_kes) values (${o.id}, 'DARAJA', 1300)`);
    await rejects(sql`insert into payments (order_id, provider, amount_kes) values (${o.id}, 'DARAJA', 1300)`);
    // After the first attempt fails, a retry may create a new PENDING payment.
    await db.execute(sql`update payments set status = 'FAILED' where order_id = ${o.id}`);
    await db.execute(sql`insert into payments (order_id, provider, amount_kes) values (${o.id}, 'DARAJA', 1300)`);
    await db.execute(sql`delete from orders where id = ${o.id}`);
  });

  it('order numbers come from a sequence', async () => {
    const a = (await db.execute(sql`select nextval('order_number_seq') as n`)).rows[0].n;
    const b = (await db.execute(sql`select nextval('order_number_seq') as n`)).rows[0].n;
    expect(Number(b)).toBe(Number(a) + 1);
  });
});
