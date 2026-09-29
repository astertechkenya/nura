import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { sessionStore } from '../src/middleware/session.js';
import { seed } from '../src/db/seed.js';
import { reconcileCards } from '../src/services/cardPayments.js';
import { expireOrders } from '../src/services/orders.js';
import { netlifyToken } from './helpers.js';
import { startFakePaystack, signedEvent } from './fakePaystack.js';

const app = createApp();
let paystack, fake, V;

beforeAll(async () => {
  ({ fake, close: paystack } = await startFakePaystack());
  await db.execute(sql`update product_variants set stock = stock + 50`);
  const res = await request(app).get('/api/products');
  V = {};
  for (const p of res.body.products) for (const v of p.variants) V[`${p.sku}/${v.size}`] = v.id;
});
afterAll(async () => { await paystack(); await seed({ log: () => {} }); sessionStore.close(); await pool.end(); });

let ipCounter = 0;
function as(agentOrApp) {
  const ip = `10.7.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  const target = typeof agentOrApp === 'function' ? request(agentOrApp) : agentOrApp;
  const wrap = (m) => (url) => target[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip);
  return { get: wrap('get'), post: wrap('post') };
}

/** A guest who puts the Printed Wrap Dress (KSh 5,700, free delivery) in the cart and pays by card. */
async function cardOrder() {
  const b = request.agent(app);
  await as(b).post('/api/cart/items').send({ variantId: V['nura-003/M'] });
  const res = await as(b).post('/api/checkout').send({
    checkoutKey: randomUUID(), email: 'zawadi@example.com', phone: '0712 345 678', name: 'Zawadi K',
    addressLine1: 'Hse 3, Milimani Rd', area: 'Milimani', county: 'Kisumu', paymentMethod: 'CARD',
  });
  return { b, res, order: res.body.order };
}
const payRows = async (orderId) => (await db.execute(sql`
  select id, status, provider_ref, receipt, result_code, failure_reason from payments where order_id = ${orderId} order by created_at`)).rows;
const orderRow = async (id) => (await db.execute(sql`select status, refund_status from orders where id = ${id}`)).rows[0];
const refOf = async (orderId) => (await payRows(orderId)).at(-1).provider_ref;
const webhook = (event, { signature, raw } = signedEvent(event)) =>
  request(app).post('/api/payments/paystack/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(raw);
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)); }
}

describe('checkout by card', () => {
  it('saves the order, opens a Paystack page for the exact total, and sends the shopper there', async () => {
    const before = fake.inits.length;
    const { res, order } = await cardOrder();
    expect(res.status).toBe(201);
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', paymentMethod: 'CARD', totalKes: 5700 });
    const ref = await refOf(order.id);
    expect(res.body.redirectUrl).toBe(`https://checkout.paystack.test/${ref}`);
    expect(fake.inits[before]).toMatchObject({
      email: 'zawadi@example.com', amount: 570000, currency: 'KES',   // Paystack counts cents
      reference: ref, channels: ['card', 'apple_pay'],
      callback_url: `http://localhost:8000/order-confirmed.html?order=${order.id}`,
      metadata: { order_id: order.id, order_number: order.number,
                  cancel_action: `http://localhost:8000/order-confirmed.html?order=${order.id}` },
    });
  });

  it('if Paystack can’t be reached, the order still exists and "pay again" opens the page', async () => {
    fake.failNextInit = true;
    const { b, res, order } = await cardOrder();
    expect(res.body.redirectUrl).toBeNull();
    expect(order.payment).toMatchObject({ status: 'FAILED', message: 'We couldn’t open the card payment page. Please try again.' });
    const again = await as(b).post(`/api/orders/${order.id}/pay`).send({});
    expect(again.status).toBe(200);
    expect(again.body.redirectUrl).toMatch(/^https:\/\/checkout\.paystack\.test\//);
  });
});

describe('coming back from Paystack', () => {
  it('paid: the order is PAID with the card’s last four digits', async () => {
    const { b, order } = await cardOrder();
    fake.result.set(await refOf(order.id), { status: 'success', amount: 570000, last4: '4081' });
    const res = await as(b).post(`/api/orders/${order.id}/check`);
    expect(res.body.order).toMatchObject({ status: 'PAID', payment: { status: 'PAID', receipt: 'Card •••• 4081' } });
  });

  it('declined: FAILED with Paystack’s reason, then "try again" opens a new attempt that can succeed', async () => {
    const { b, order } = await cardOrder();
    const first = await refOf(order.id);
    fake.result.set(first, { status: 'failed', message: 'Insufficient Funds' });
    const checked = (await as(b).post(`/api/orders/${order.id}/check`)).body.order;
    expect(checked.payment).toMatchObject({ status: 'FAILED', message: 'The card payment didn’t go through: Insufficient Funds.' });

    const again = (await as(b).post(`/api/orders/${order.id}/pay`).send({})).body;
    const second = await refOf(order.id);
    expect(second).not.toBe(first);
    expect(again.redirectUrl).toBe(`https://checkout.paystack.test/${second}`);
    fake.result.set(second, { status: 'success', amount: 570000 });
    expect((await as(b).post(`/api/orders/${order.id}/check`)).body.order.status).toBe('PAID');
  });

  it('closed the tab: "pay again" reuses the same Paystack page instead of opening another', async () => {
    const { b, res, order } = await cardOrder();
    const again = (await as(b).post(`/api/orders/${order.id}/pay`).send({})).body;
    expect(again.redirectUrl).toBe(res.body.redirectUrl);
    expect(await payRows(order.id)).toHaveLength(1);
  });

  it('another browser can neither check nor pay someone else’s order', async () => {
    const { order } = await cardOrder();
    const stranger = request.agent(app);
    expect((await as(stranger).post(`/api/orders/${order.id}/check`)).status).toBe(404);
    expect((await as(stranger).post(`/api/orders/${order.id}/pay`).send({})).status).toBe(404);
  });
});

describe('the webhook', () => {
  it('signed charge.success → Paystack confirms → PAID; a repeat changes nothing', async () => {
    const { order } = await cardOrder();
    const ref = await refOf(order.id);
    fake.result.set(ref, { status: 'success', amount: 570000 });
    const ev = { event: 'charge.success', data: { reference: ref } };
    expect((await webhook(ev)).status).toBe(200);
    expect(await until(async () => (await orderRow(order.id)).status === 'PAID')).toBe(true);
    await webhook(ev);
    await new Promise((r) => setTimeout(r, 300));
    const paid = (await db.execute(sql`select count(*)::int as n from order_events where order_id = ${order.id} and to_status = 'PAID'`)).rows[0].n;
    expect(paid).toBe(1);
  });

  it('a wrong or missing signature is refused and changes nothing', async () => {
    const { order } = await cardOrder();
    const ref = await refOf(order.id);
    fake.result.set(ref, { status: 'success', amount: 570000 });
    const ev = { event: 'charge.success', data: { reference: ref } };
    expect((await webhook(ev, signedEvent(ev, 'sk_test_someoneElsesKey'))).status).toBe(401);
    expect((await request(app).post('/api/payments/paystack/webhook').send(ev)).status).toBe(401);
    await new Promise((r) => setTimeout(r, 300));
    expect((await orderRow(order.id)).status).toBe('PENDING_PAYMENT');
  });

  it('a correctly signed "success" that Paystack’s own records contradict changes nothing', async () => {
    const { order } = await cardOrder();
    const ref = await refOf(order.id);                               // verify still says "abandoned"
    await webhook({ event: 'charge.success', data: { reference: ref } });
    await new Promise((r) => setTimeout(r, 300));
    expect((await orderRow(order.id)).status).toBe('PENDING_PAYMENT');
  });

  it('paid the wrong amount or in another currency → FLAGGED, order not paid', async () => {
    for (const r of [{ amount: 100 }, { amount: 570000, currency: 'USD' }]) {
      const { order } = await cardOrder();
      const ref = await refOf(order.id);
      fake.result.set(ref, { status: 'success', ...r });
      await webhook({ event: 'charge.success', data: { reference: ref } });
      expect(await until(async () => (await payRows(order.id))[0].status === 'FLAGGED'), JSON.stringify(r)).toBe(true);
      expect((await orderRow(order.id)).status).toBe('PENDING_PAYMENT');
    }
  });

  it('other events and unknown references are acknowledged and ignored', async () => {
    expect((await webhook({ event: 'transfer.success', data: { reference: 'x' } })).status).toBe(200);
    expect((await webhook({ event: 'charge.success', data: { reference: randomUUID() } })).status).toBe(200);
  });
});

describe('when nobody tells us', () => {
  it('the job asks Paystack after two minutes and settles the payment', async () => {
    const { order } = await cardOrder();
    fake.result.set(await refOf(order.id), { status: 'success', amount: 570000 });
    await reconcileCards(new Date(Date.now() + 2 * 60 * 1000 + 1000));
    expect((await orderRow(order.id)).status).toBe('PAID');
  });

  it('a page left open past the order’s expiry is closed as not completed', async () => {
    const { order } = await cardOrder();
    await expireOrders(new Date(Date.now() + 16 * 60 * 1000));
    expect((await payRows(order.id))[0].status).toBe('PENDING');    // the page was opened: Paystack decides
    await reconcileCards(new Date(Date.now() + 17 * 60 * 1000));
    expect((await payRows(order.id))[0]).toMatchObject({ status: 'FAILED', result_code: 'ABANDONED' });
  });

  it('paid at the last second after expiry: the money is recorded and a refund marked due', async () => {
    const { order } = await cardOrder();
    await expireOrders(new Date(Date.now() + 16 * 60 * 1000));
    fake.result.set(await refOf(order.id), { status: 'success', amount: 570000 });
    await reconcileCards(new Date(Date.now() + 17 * 60 * 1000));
    expect(await orderRow(order.id)).toEqual({ status: 'EXPIRED', refund_status: 'DUE' });
    expect((await payRows(order.id))[0].status).toBe('PAID');
  });
});
