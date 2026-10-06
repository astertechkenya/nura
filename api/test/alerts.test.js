// Phase 8: alerts to the shop owner when money needs a human. A payment for the wrong amount
// (FLAGGED) and money that arrived after the order closed (refund due) each email the owner
// once, with what to do and a link to the order, and nothing personal about the shopper.
// Then the owner's decision on a flagged payment: accept it as payment, or reject it (refund).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { sessionStore } from '../src/middleware/session.js';
import { seed } from '../src/db/seed.js';
import { mailSettled, outbox } from '../src/services/mail.js';
import { markPaid } from '../src/services/payments.js';
import { expireOrders } from '../src/services/orders.js';
import { listOrders, markRefunded, resolveFlagged } from '../src/services/admin.js';
import argon2 from 'argon2';
import { codeAt, newSecret } from '../src/lib/totp.js';
import { alertMessage } from '../src/services/alerts.js';
import { loadConfig, config } from '../src/config.js';
import { netlifyToken } from './helpers.js';
import { startFakePaystack } from './fakePaystack.js';

const app = createApp();
let V, paystack, admin, boss, demo;
const PW = 'alerts admin password long enough';

beforeAll(async () => {
  ({ close: paystack } = await startFakePaystack());
  await db.execute(sql`update product_variants set stock = stock + 50`);
  const res = await request(app).get('/api/products');
  V = {};
  for (const p of res.body.products) for (const v of p.variants) V[`${p.sku}/${v.size}`] = v.id;
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const secret = newSecret();
  [admin] = (await db.execute(sql`insert into users (email, name, role, password_hash, totp_secret)
    values ('alertboss@nura.test', 'Alert Boss', 'ADMIN', ${hash}, ${secret}) returning id`)).rows;
  await db.execute(sql`insert into users (email, name, role, password_hash)
    values ('alertdemo@nura.test', 'Alert Demo', 'DEMO_ADMIN', ${hash})`);
  // Signed in once each: the boss with the 6-digit code, the demo admin without.
  boss = request.agent(app);
  expect((await http(boss).post('/api/auth/login').send({ email: 'alertboss@nura.test', password: PW })).status).toBe(200);
  expect((await http(boss).post('/api/admin/totp').send({ code: codeAt(secret, Math.floor(Date.now() / 30000)) })).status).toBe(200);
  demo = request.agent(app);
  expect((await http(demo).post('/api/auth/login').send({ email: 'alertdemo@nura.test', password: PW })).status).toBe(200);
});
afterAll(async () => { await paystack(); await seed({ log: () => {} }); sessionStore.close(); await pool.end(); });
beforeEach(() => { outbox.length = 0; });

let ip = 0;
const http = (agent) => {
  const addr = `10.6.0.${(ip++ % 250) + 1}`;
  const wrap = (m) => (url) => agent[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', addr);
  return { get: wrap('get'), post: wrap('post') };
};
/** A guest card order for the belt (KSh 2,100 + 300 delivery = 2,400). */
async function cardOrder() {
  const agent = request.agent(app);
  const addr = `10.7.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`;
  const post = (url) => agent.post(url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', addr);
  await post('/api/cart/items').send({ variantId: V['nura-021/ONE SIZE'] });
  const res = await post('/api/checkout').send({
    checkoutKey: randomUUID(), email: 'zawadi@example.com', phone: '0722 111 222', name: 'Zawadi Otieno',
    addressLine1: 'Hse 4, Acacia Road', area: 'Kilimani', county: 'Kisumu', paymentMethod: 'CARD',
  });
  expect(res.status, res.body.error).toBe(201);
  const o = res.body.order;
  const [p] = (await db.execute(sql`select id from payments where order_id = ${o.id}`)).rows;
  return { o, paymentId: p.id };
}
const alerts = () => outbox.filter((m) => m.to === config.ALERT_EMAIL);

describe('owner alerts', () => {
  it('wrong amount: one alert (however many signals race), the order unpaid, the admin link', async () => {
    const { o, paymentId } = await cardOrder();
    await mailSettled(); outbox.length = 0;
    const wrong = { amountKes: 240, receipt: 'Card •••• 4081' };
    await Promise.all([1, 2, 3].map(() => markPaid(paymentId, wrong, 'card')));
    await mailSettled();

    const list = alerts();
    expect(list).toHaveLength(1);
    const [m] = list;
    expect(m.subject).toBe(`[NURA] Check payment: ${o.number} paid KSh 240, expected KSh 2,400`);
    expect(m.text).toMatch(/has NOT been marked paid/);
    expect(m.text).toMatch(/expires at \d\d:\d\d/);                       // when the stock goes back
    expect(m.text).toContain('Receipt: Card •••• 4081');
    expect(m.text).toContain(`${config.SITE_URL}/admin/#order/${o.id}`);
    // Nothing about the shopper: that stays behind the admin sign-in.
    for (const secret of ['Zawadi', 'zawadi@example.com', '0722', '722111222', 'Acacia']) {
      expect(m.text + m.html).not.toContain(secret);
    }
    // And no "payment confirmed" to the shopper.
    expect(outbox.filter((x) => x.subject.includes('confirmed'))).toHaveLength(0);
    const [{ status }] = (await db.execute(sql`select status from orders where id = ${o.id}`)).rows;
    expect(status).toBe('PENDING_PAYMENT');
  });

  it('the admin’s “Payments to check” filter lists exactly the orders with a flagged payment', async () => {
    const flagged = await cardOrder();
    const fine = await cardOrder();
    await markPaid(flagged.paymentId, { amountKes: 1 }, 'card');
    await markPaid(fine.paymentId, { amountKes: 2400 }, 'card');
    const ids = (await listOrders({ status: 'FLAGGED', limit: 500 })).map((r) => r.id);
    expect(ids).toContain(flagged.o.id);
    expect(ids).not.toContain(fine.o.id);
  });

  it('another currency: says so, instead of a negative amount', async () => {
    const { o, paymentId } = await cardOrder();
    await mailSettled(); outbox.length = 0;
    await markPaid(paymentId, { amountKes: -1 }, 'card');                  // what cardPayments.js passes
    await mailSettled();
    const [m] = alerts();
    expect(m.subject).toBe(`[NURA] Check payment: ${o.number} paid in another currency, expected KSh 2,400`);
    expect(m.text).not.toMatch(/KSh -1/);
  });

  it('money after the order expired: one "refund due" alert with what to do', async () => {
    const { o, paymentId } = await cardOrder();
    await expireOrders(new Date(Date.now() + 16 * 60 * 1000));
    await mailSettled(); outbox.length = 0;
    await Promise.all([1, 2].map(() => markPaid(paymentId, { receipt: 'Paystack 991' }, 'card')));
    await mailSettled();
    const list = alerts();
    expect(list).toHaveLength(1);
    expect(list[0].subject).toBe(`[NURA] Refund due: ${o.number}, KSh 2,400 by card`);
    expect(list[0].text).toMatch(/after it had expired/);
    expect(list[0].text).toMatch(/press "Refund paid"/);
  });

  it('a correct payment sends no alert', async () => {
    const { paymentId } = await cardOrder();
    await markPaid(paymentId, { amountKes: 2400 }, 'card');
    await mailSettled();
    expect(alerts()).toHaveLength(0);
  });

  it('provider text is text in the HTML, never markup', () => {
    const m = alertMessage('flagged', { orderId: 'x', number: 'NURA-1', method: 'M-Pesa', expectedKes: 10, gotKes: 5,
                                        receipt: '<img src=x onerror=alert(1)>' });
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).toContain('&lt;img src=x');
  });
});

const pay = async (paymentId) => (await db.execute(sql`select status, result_code, received_kes from payments where id = ${paymentId}`)).rows[0];
const ord = async (orderId) => (await db.execute(sql`select status, refund_status from orders where id = ${orderId}`)).rows[0];
const toShopper = () => outbox.filter((m) => m.to === 'zawadi@example.com');
const flaggedOrder = async (amountKes = 240) => {
  const r = await cardOrder();
  await markPaid(r.paymentId, { amountKes, receipt: 'Card •••• 4081' }, 'card');
  await mailSettled(); outbox.length = 0;
  return r;
};

describe('deciding on a flagged payment', () => {
  it('accept (in the admin): the order is paid, the shopper is told the amount that arrived', async () => {
    const { o, paymentId } = await flaggedOrder();
    const r = await http(boss).post(`/api/admin/orders/${o.id}/flagged`).send({ paymentId, decision: 'accept' });
    expect(r.status, r.body.error).toBe(200);
    expect(r.body.order.status).toBe('PAID');
    expect(r.body.order.payments[0]).toMatchObject({ status: 'PAID', receivedKes: 240, amountKes: 2400 });
    expect(r.body.order.events.at(-1).note).toBe('Accepted KSh 240 instead of KSh 2,400');
    await mailSettled();
    const [m] = toShopper();
    expect(m.subject).toBe(`Order ${o.number} confirmed`);
    expect(m.text).toMatch(/We've received KSh 240 \(Card •••• 4081\)/);
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from admin_actions where action = 'payment.accept' and entity_id = ${paymentId}`)).rows;
    expect(n).toBe(1);
    // Decided once: a second decision (a double tap, another admin) is refused.
    const again = await http(boss).post(`/api/admin/orders/${o.id}/flagged`).send({ paymentId, decision: 'reject' });
    expect(again.status).toBe(409);
  });

  it('reject while the order is open: refund due, the shopper can still pay; the refund is what arrived', async () => {
    const { o, paymentId } = await flaggedOrder();
    await resolveFlagged({ id: admin.id }, o.id, paymentId, 'reject');
    expect(await pay(paymentId)).toEqual({ status: 'FAILED', result_code: 'REJECTED', received_kes: 240 });
    expect(await ord(o.id)).toEqual({ status: 'PENDING_PAYMENT', refund_status: 'DUE' });
    await mailSettled();
    const [m] = toShopper();
    expect(m.text).toMatch(/We received KSh 240 for this order, but its total is KSh 2,400, so we couldn't accept it/);
    expect(m.text).toMatch(/still open: you can pay the correct amount of KSh 2,400/);

    // They pay the right amount: the order is paid, and the refund is still only the KSh 240.
    const [p2] = (await db.execute(sql`insert into payments (order_id, provider, amount_kes, provider_ref)
      values (${o.id}, 'PAYSTACK', 2400, ${randomUUID()}) returning id`)).rows;
    await markPaid(p2.id, { amountKes: 2400 }, 'card');
    expect((await ord(o.id)).status).toBe('PAID');
    await mailSettled(); outbox.length = 0;
    await markRefunded({ id: admin.id }, o.id);
    await mailSettled();
    expect(toShopper().find((x) => x.subject.startsWith('Refund sent')).text).toMatch(/We've refunded KSh 240 to the card/);
  });

  it('after the order expired: accepting is refused (the stock is gone); rejecting refunds it', async () => {
    const { o, paymentId } = await flaggedOrder(300);
    await expireOrders(new Date(Date.now() + 16 * 60 * 1000));
    await mailSettled(); outbox.length = 0;
    const r = await http(boss).post(`/api/admin/orders/${o.id}/flagged`).send({ paymentId, decision: 'accept' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Reject it to refund the shopper/);
    expect((await pay(paymentId)).status).toBe('FLAGGED');                   // nothing changed
    await resolveFlagged({ id: admin.id }, o.id, paymentId, 'reject');
    await mailSettled();
    const [m] = toShopper();
    expect(m.text).toMatch(/We received KSh 300 for this order/);
    expect(m.text).not.toMatch(/still open/);
    const detail = await http(boss).get(`/api/admin/orders/${o.id}`);
    expect(detail.body.order).toMatchObject({ status: 'EXPIRED', refundStatus: 'DUE' });
    expect(detail.body.order.payments[0]).toMatchObject({ status: 'FAILED', resultCode: 'REJECTED', receivedKes: 300 });
  });

  it('another currency, rejected: no made-up amount anywhere', async () => {
    const { o, paymentId } = await flaggedOrder(-1);
    await resolveFlagged({ id: admin.id }, o.id, paymentId, 'reject');
    await mailSettled();
    const [m] = toShopper();
    expect(m.text).toMatch(/We received your payment for this order/);
    expect(m.text).not.toMatch(/KSh 0|KSh -1/);
  });

  it('the demo admin can’t decide; a payment from another order is not found; bad input is refused', async () => {
    const { o, paymentId } = await flaggedOrder();
    const other = await flaggedOrder();
    expect((await http(demo).post(`/api/admin/orders/${o.id}/flagged`).send({ paymentId, decision: 'accept' })).status).toBe(403);
    expect((await http(boss).post(`/api/admin/orders/${other.o.id}/flagged`).send({ paymentId, decision: 'accept' })).status).toBe(404);
    expect((await http(boss).post(`/api/admin/orders/${o.id}/flagged`).send({ paymentId, decision: 'maybe' })).status).toBe(400);
    expect((await pay(paymentId)).status).toBe('FLAGGED');
  });
});

describe('ALERT_EMAIL setting', () => {
  const base = { DATABASE_URL: 'postgresql://u@h/db' };
  it('optional; one plain address, lower-cased', () => {
    expect(loadConfig(base).ALERT_EMAIL).toBeUndefined();
    expect(loadConfig({ ...base, ALERT_EMAIL: ' Me@Example.com ' }).ALERT_EMAIL).toBe('me@example.com');
    expect(() => loadConfig({ ...base, ALERT_EMAIL: 'Me <me@example.com>' })).toThrow(/ALERT_EMAIL/);
    expect(() => loadConfig({ ...base, ALERT_EMAIL: 'a@x.com,b@x.com' })).toThrow(/ALERT_EMAIL/);
  });
  it('refuses to start when MAIL_ONLY_TO would hold every alert', () => {
    expect(() => loadConfig({ ...base, MAIL_ONLY_TO: 'me@example.com', ALERT_EMAIL: 'other@example.com' })).toThrow(/ALERT_EMAIL: must also be in MAIL_ONLY_TO/);
    expect(() => loadConfig({ ...base, MAIL_ONLY_TO: 'Me@example.com', ALERT_EMAIL: 'me@example.com' })).not.toThrow();
  });
});
