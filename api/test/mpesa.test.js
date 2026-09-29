import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { sessionStore } from '../src/middleware/session.js';
import { seed } from '../src/db/seed.js';
import { nairobiTimestamp, resetTokenCache } from '../src/services/daraja.js';
import { reconcilePayments } from '../src/services/payments.js';
import { expireOrders } from '../src/services/orders.js';
import { netlifyToken } from './helpers.js';
import { startFakeDaraja, callbackBody } from './fakeDaraja.js';

const SECRET = 'test-only-callback-secret-0123456789abcdef';
const app = createApp();
let daraja, fake, V;

beforeAll(async () => {
  ({ fake, close: daraja } = await startFakeDaraja());
  resetTokenCache();
  await db.execute(sql`update product_variants set stock = stock + 50`);
  const res = await request(app).get('/api/products');
  V = {};
  for (const p of res.body.products) for (const v of p.variants) V[`${p.sku}/${v.size}`] = v.id;
});
afterAll(async () => { await daraja(); await seed({ log: () => {} }); sessionStore.close(); await pool.end(); });

let ipCounter = 0;
function as(agentOrApp) {
  const ip = `10.6.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  const target = typeof agentOrApp === 'function' ? request(agentOrApp) : agentOrApp;
  const wrap = (m) => (url) => target[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip);
  return { get: wrap('get'), post: wrap('post') };
}
let phoneN = 0;
const freshPhone = () => `07${String(10000000 + (phoneN++ * 7919) % 89999999).padStart(8, '0')}`;

/** A guest who has put the belt (KSh 2,100 + 300) in the cart and chosen M-Pesa. */
async function mpesaOrder(overrides = {}) {
  const b = request.agent(app);
  await as(b).post('/api/cart/items').send({ variantId: V['nura-021/ONE SIZE'] });
  const res = await as(b).post('/api/checkout').send({
    checkoutKey: randomUUID(), email: 'baraka@example.com', phone: overrides.phone ?? freshPhone(), name: 'Baraka O',
    addressLine1: 'Plot 7, Nyali Rd', area: 'Nyali', county: 'Mombasa', paymentMethod: 'MPESA',
  });
  return { b, res, order: res.body.order };
}
const ref = async (orderId) => (await db.execute(sql`select provider_ref from payments where order_id = ${orderId} order by created_at desc limit 1`)).rows[0].provider_ref;
const orderRow = async (id) => (await db.execute(sql`select status, refund_status, stk_attempts from orders where id = ${id}`)).rows[0];
const payRows = async (id) => (await db.execute(sql`select status, receipt, result_code, amount_kes, phone from payments where order_id = ${id} order by created_at`)).rows;
const postCallback = (body, secret = SECRET) => request(app).post(`/api/payments/mpesa/callback/${secret}`).send(body);
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)); }
}

describe('checkout with M-Pesa', () => {
  it('saves the order, then sends the prompt: sandbox amount, Nairobi timestamp, secret callback', async () => {
    const before = fake.pushes.length;
    const { res, order } = await mpesaOrder({ phone: '0712 000 111' });
    expect(res.status).toBe(201);
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', paymentMethod: 'MPESA', totalKes: 2400, promptsLeft: 2 });
    expect(order.payment).toMatchObject({ status: 'PENDING', sent: true, phone: '254712000111' });
    expect(new Date(order.payBy).getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    const push = fake.pushes[before];
    expect(push).toMatchObject({
      BusinessShortCode: '174379', PartyB: '174379', TransactionType: 'CustomerPayBillOnline',
      Amount: 1,                                                   // sandbox: never the real 2,400
      PhoneNumber: '254712000111', PartyA: '254712000111', AccountReference: order.number,
      CallBackURL: `https://api.example.test/api/payments/mpesa/callback/${SECRET}`,
    });
    expect(push.Timestamp).toMatch(/^\d{14}$/);
    expect(Buffer.from(push.Password, 'base64').toString()).toBe(`174379test-passkey${push.Timestamp}`);
  });

  it('a Nairobi timestamp is three hours ahead of UTC', () => {
    expect(nairobiTimestamp(new Date('2026-09-29T21:30:05Z'))).toBe('20260930003005');
  });

  it('if Safaricom can’t be reached, the order still exists and the shopper can resend', async () => {
    fake.failNextPush = true;
    const { b, order } = await mpesaOrder();
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.payment).toMatchObject({ status: 'FAILED', message: 'We couldn’t reach M-Pesa. Please try again.' });
    const again = await as(b).post(`/api/orders/${order.id}/pay`).send({});
    expect(again.status).toBe(200);
    expect(again.body.order.payment).toMatchObject({ status: 'PENDING', sent: true });
    expect(again.body.order.promptsLeft).toBe(1);
  });
});

describe('the callback', () => {
  it('success → Safaricom confirms → order PAID with the receipt; a repeat changes nothing', async () => {
    const { b, order } = await mpesaOrder();
    const id = await ref(order.id);
    fake.outcome.set(id, { state: 'paid' });
    const res = await postCallback(callbackBody(id, { receipt: 'QK99PAID01' }));
    expect(res.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(await until(async () => (await orderRow(order.id)).status === 'PAID')).toBe(true);
    expect(await payRows(order.id)).toEqual([expect.objectContaining({ status: 'PAID', receipt: 'QK99PAID01', result_code: '0' })]);
    await postCallback(callbackBody(id, { receipt: 'QK99PAID01' }));
    await new Promise((r) => setTimeout(r, 300));
    const events = (await db.execute(sql`select to_status from order_events where order_id = ${order.id} order by created_at`)).rows.map((r) => r.to_status);
    expect(events).toEqual(['PENDING_PAYMENT', 'PAID']);             // paid once
    const seen = (await as(b).get(`/api/orders/${order.id}`)).body.order;
    expect(seen).toMatchObject({ status: 'PAID', payment: { status: 'PAID', receipt: 'QK99PAID01' } });
  });

  it('the same result arriving three ways at once (two callbacks and the job) pays the order once', async () => {
    const { order } = await mpesaOrder();
    const id = await ref(order.id);
    fake.outcome.set(id, { state: 'paid' });
    await Promise.all([
      postCallback(callbackBody(id)), postCallback(callbackBody(id)),
      reconcilePayments(new Date(Date.now() + 61 * 1000)),
    ]);
    await until(async () => (await orderRow(order.id)).status === 'PAID');
    await new Promise((r) => setTimeout(r, 300));
    const events = (await db.execute(sql`select to_status from order_events where order_id = ${order.id}`)).rows;
    expect(events.filter((e) => e.to_status === 'PAID')).toHaveLength(1);
  });

  it('a forged "paid" callback changes nothing while Safaricom says otherwise', async () => {
    const { order } = await mpesaOrder();
    const id = await ref(order.id);                                 // outcome stays 'pending'
    await postCallback(callbackBody(id));
    await new Promise((r) => setTimeout(r, 300));
    expect((await orderRow(order.id)).status).toBe('PENDING_PAYMENT');
    expect((await payRows(order.id))[0].status).toBe('PENDING');
  });

  it('wrong secret: 404 and ignored', async () => {
    const { order } = await mpesaOrder();
    const id = await ref(order.id);
    fake.outcome.set(id, { state: 'paid' });
    const res = await postCallback(callbackBody(id), 'x'.repeat(SECRET.length));
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 300));
    expect((await orderRow(order.id)).status).toBe('PENDING_PAYMENT');
  });

  it('an unknown CheckoutRequestID is acknowledged and ignored', async () => {
    const res = await postCallback(callbackBody('ws_CO_NOT_OURS'));
    expect(res.status).toBe(200);
  });

  it('paid a different amount → FLAGGED, and the order is not marked paid', async () => {
    const { order } = await mpesaOrder();
    const id = await ref(order.id);
    fake.outcome.set(id, { state: 'paid' });
    await postCallback(callbackBody(id, { amount: 5 }));            // we asked for 1
    expect(await until(async () => (await payRows(order.id))[0].status === 'FLAGGED')).toBe(true);
    expect((await orderRow(order.id)).status).toBe('PENDING_PAYMENT');
  });

  it('cancelled on the phone → FAILED with a message, then a resend is paid', async () => {
    const { b, order } = await mpesaOrder();
    const id = await ref(order.id);
    fake.outcome.set(id, { state: 'failed', code: '1032' });
    await postCallback(callbackBody(id, { code: 1032 }));
    expect(await until(async () => (await payRows(order.id))[0].status === 'FAILED')).toBe(true);
    const seen = (await as(b).get(`/api/orders/${order.id}`)).body.order;
    expect(seen.payment).toMatchObject({ status: 'FAILED', resultCode: '1032', message: 'The M-Pesa prompt was cancelled.' });

    const again = (await as(b).post(`/api/orders/${order.id}/pay`).send({ phone: '0711 222 333' })).body.order;
    expect(again.payment).toMatchObject({ status: 'PENDING', phone: '254711222333' });
    const id2 = await ref(order.id);
    fake.outcome.set(id2, { state: 'paid' });
    await postCallback(callbackBody(id2));
    expect(await until(async () => (await orderRow(order.id)).status === 'PAID')).toBe(true);
  });
});

// These tests place six orders each. Against a database in another country (Neon, Frankfurt)
// that's ~7 s per order, so they get two minutes instead of the usual 30 s.
describe('resending', { timeout: 120_000 }, () => {
  it('not while a prompt is still open, only 3 per order, only by the owner', async () => {
    const { b, order } = await mpesaOrder();
    const busy = await as(b).post(`/api/orders/${order.id}/pay`).send({});
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/already on its way/);

    expect((await as(request.agent(app)).post(`/api/orders/${order.id}/pay`).send({})).status).toBe(404);

    for (let i = 0; i < 2; i++) {
      const id = await ref(order.id);
      fake.outcome.set(id, { state: 'failed', code: '1032' });
      await postCallback(callbackBody(id, { code: 1032 }));
      await until(async () => (await payRows(order.id)).at(-1).status === 'FAILED');
      expect((await as(b).post(`/api/orders/${order.id}/pay`).send({})).status).toBe(200);
    }
    const id = await ref(order.id);
    fake.outcome.set(id, { state: 'failed', code: '1032' });
    await postCallback(callbackBody(id, { code: 1032 }));
    await until(async () => (await payRows(order.id)).at(-1).status === 'FAILED');
    const fourth = await as(b).post(`/api/orders/${order.id}/pay`).send({});
    expect(fourth.status).toBe(409);
    expect(fourth.body.error).toMatch(/last of 3/);
    expect((await orderRow(order.id)).stk_attempts).toBe(3);
  });

  it('at most 5 prompts an hour to one phone number', async () => {
    const phone = '0722 555 000';
    for (let i = 0; i < 5; i++) expect((await mpesaOrder({ phone })).res.status).toBe(201);
    const sixth = await mpesaOrder({ phone });
    expect(sixth.res.status).toBe(429);
  });

  it('resending to a number that has had 5 prompts this hour is refused too', async () => {
    const busy = '0733 555 000';
    for (let i = 0; i < 5; i++) await mpesaOrder({ phone: busy });
    const { b, order } = await mpesaOrder();
    const id = await ref(order.id);
    fake.outcome.set(id, { state: 'failed', code: '1032' });
    await postCallback(callbackBody(id, { code: 1032 }));
    await until(async () => (await payRows(order.id))[0].status === 'FAILED');
    const res = await as(b).post(`/api/orders/${order.id}/pay`).send({ phone: busy });
    expect(res.status).toBe(429);
  });
});

describe('when no callback ever comes', () => {
  it('the job asks Safaricom after a minute and settles the payment', async () => {
    const { order } = await mpesaOrder();
    const id = await ref(order.id);
    fake.outcome.set(id, { state: 'paid' });
    await reconcilePayments(new Date(Date.now() + 61 * 1000));
    expect((await orderRow(order.id)).status).toBe('PAID');
    expect((await payRows(order.id))[0]).toMatchObject({ status: 'PAID', receipt: null });   // no callback, no receipt
  });

  it('money arriving after the order expired marks a refund as due', async () => {
    const { order } = await mpesaOrder();
    const id = await ref(order.id);
    await expireOrders(new Date(Date.now() + 16 * 60 * 1000));       // payment window over; stock returned
    expect((await orderRow(order.id)).status).toBe('EXPIRED');
    expect((await payRows(order.id))[0].status).toBe('PENDING');   // the sent prompt is left for Safaricom to settle
    fake.outcome.set(id, { state: 'paid' });                        // ...and the shopper did pay, at the last second
    await postCallback(callbackBody(id));
    expect(await until(async () => (await orderRow(order.id)).refund_status === 'DUE')).toBe(true);
    expect((await orderRow(order.id)).status).toBe('EXPIRED');       // the stock is gone; the money goes back
    expect((await payRows(order.id))[0].status).toBe('PAID');
  });
});
