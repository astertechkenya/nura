// SECURITY.md items 1, 10 and 11: quantities, unexpected fields and SQL injection, tried as
// an attacker would. (The other items are proven in the test files SECURITY.md names.)
//
// Item 11, SQL injection: Every query is built by Drizzle with $1, $2… parameters,
// so typed text is only ever data. These try the classic attacks on each place where shoppers
// or admins type free text that reaches SQL, and check nothing breaks or leaks.
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { netlifyToken } from './helpers.js';
import { db, pool } from '../src/db/client.js';
import { sessionStore } from '../src/middleware/session.js';
import { listCustomers, listOrders } from '../src/services/admin.js';

const app = createApp();
afterAll(async () => { sessionStore.close(); await pool.end(); });

const ATTACKS = [
  "' OR '1'='1",
  "'; DROP TABLE products; --",
  "x' UNION SELECT email, password_hash FROM users --",
  '%',                         // a LIKE wildcard: must match a literal %, not everything
  '_',
  '\\',
  "') OR 1=1 --",
];

describe('SQL injection', () => {
  it('shop search: each attack is plain text (no error, no extra rows, tables intact)', async () => {
    for (const q of ATTACKS.filter((a) => a.length >= 2)) {
      const res = await request(app).get('/api/products').query({ q });
      expect(res.status, q).toBe(200);
      expect(res.body.products, q).toEqual([]);              // no product's name contains these
      expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/);
    }
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from products`)).rows;
    expect(n).toBeGreaterThanOrEqual(21);                     // DROP TABLE did nothing
  });

  it('admin search (orders and customers): the same attacks match nothing', async () => {
    for (const q of ATTACKS) {
      expect(await listOrders({ q, limit: 500 }), q).toEqual([]);
      expect(await listCustomers({ q, limit: 500 }), q).toMatchObject({ total: 0 });
    }
  });
});

describe('quantities and unexpected fields', () => {
  const as = (agent, ip) => ({ post: (u) => agent.post(u).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip) });

  it('a cart line of 0, -1, 1.5, 11 or "lots" is refused, and nothing is added', async () => {
    const { body } = await request(app).get('/api/products');
    const variantId = body.products[0].variants[0].id;
    const agent = request.agent(app);
    for (const qty of [0, -1, 1.5, 11, 'lots']) {
      const res = await as(agent, '10.5.0.1').post('/api/cart/items').send({ variantId, qty });
      expect(res.status, String(qty)).toBe(400);
    }
    const cart = await agent.get('/api/cart').set('x-nf-sign', netlifyToken());
    expect(cart.body.cart?.items ?? cart.body.items ?? []).toEqual([]);
  });

  it('unknown fields or parameters are refused, not ignored', async () => {
    const { body } = await request(app).get('/api/products');
    const variantId = body.products[0].variants[0].id;
    const add = await as(request.agent(app), '10.5.0.2').post('/api/cart/items').send({ variantId, qty: 1, userId: 'someone-else' });
    expect(add.status).toBe(400);
    expect((await request(app).get('/api/products').query({ admin: 'true' })).status).toBe(400);
  });
});
