// Phase 8: the payment jobs run only while a payment is open, so the database can sleep.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { sessionStore } from '../src/middleware/session.js';
import { startJobs, stopJobs, wakeJobs, jobsAreQuiet, jobsRunning, runJobsOnce, jobStats } from '../src/jobs/index.js';
import { netlifyToken } from './helpers.js';

const app = createApp();
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return fn(); };
let orderId;

beforeAll(async () => {
  // Nothing open from earlier test files.
  await db.execute(sql`update orders set status = 'EXPIRED' where status = 'PENDING_PAYMENT'`);
  await db.execute(sql`update payments set status = 'FAILED' where status = 'PENDING' and provider <> 'COD'`);
});
afterAll(async () => {
  stopJobs();
  if (orderId) await db.execute(sql`update orders set status = 'AWAITING_COD' where id = ${orderId}`);
  sessionStore.close(); await pool.end();
});

describe('payment jobs', () => {
  it('nothing open: after the first run they go quiet (no timer, no queries)', async () => {
    startJobs();
    expect(await until(() => jobsAreQuiet() && jobStats.ticks >= 1)).toBe(true);
    const ticks = jobStats.ticks;
    await new Promise((r) => setTimeout(r, 200));
    expect(jobStats.ticks).toBe(ticks);
  });

  it('a checkout wakes them; with an unpaid order they keep running; once it closes they go quiet again', async () => {
    const wakes = jobStats.wakes;
    const b = request.agent(app);
    const as = (r) => r.set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', '10.44.0.1');
    const { products } = (await request(app).get('/api/products')).body;
    await as(b.post('/api/cart/items')).send({ variantId: products.find((p) => p.sku === 'nura-021').variants[0].id });
    const res = await as(b.post('/api/checkout')).send({
      checkoutKey: randomUUID(), email: 'jobs@example.com', phone: '0722 123 456', name: 'Jobs Test',
      addressLine1: 'Flat 1', area: 'Kilimani', county: 'Nairobi', paymentMethod: 'COD',
    });
    expect(res.status).toBe(201);
    orderId = res.body.order.id;
    expect(await until(() => jobStats.wakes > wakes)).toBe(true);                // the POST woke them
    expect(await until(() => jobsAreQuiet())).toBe(true);                        // COD: nothing to watch

    await db.execute(sql`update orders set status = 'PENDING_PAYMENT', expires_at = now() + interval '10 minutes' where id = ${orderId}`);
    wakeJobs();
    await until(() => !jobsRunning());
    await runJobsOnce();
    expect(jobsAreQuiet()).toBe(false);                                          // an open payment: keep watching
    await db.execute(sql`update orders set status = 'AWAITING_COD' where id = ${orderId}`);
    await until(() => !jobsRunning());
    await runJobsOnce();
    expect(jobsAreQuiet()).toBe(true);
  });

  it('GETs (browsing) never wake them', async () => {
    const wakes = jobStats.wakes;
    await request(app).get('/api/orders');
    await request(app).get('/api/ping');
    await new Promise((r) => setTimeout(r, 50));
    expect(jobStats.wakes).toBe(wakes);
  });
});

describe('ping', () => {
  it('answers without the database', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
