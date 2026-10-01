// Phase 7: emails. What each one says, that each goes out exactly once, that sending never
// blocks or breaks the thing that caused it, and the signed "view your order" link.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { sessionStore } from '../src/middleware/session.js';
import { seed } from '../src/db/seed.js';
import { deliver, hint, mailSettled, outbox } from '../src/services/mail.js';
import { markPaid } from '../src/services/payments.js';
import { codCollected, markRefunded, transitionOrder } from '../src/services/admin.js';
import { expireOrders } from '../src/services/orders.js';
import { orderMessage, queueOrderEmail } from '../src/services/emails.js';
import { orderToken, orderTokenValid } from '../src/lib/orderLink.js';
import { config } from '../src/config.js';
import { netlifyToken } from './helpers.js';
import { startFakePaystack } from './fakePaystack.js';

const app = createApp();
let V, paystack, admin;

beforeAll(async () => {
  ({ close: paystack } = await startFakePaystack());
  await db.execute(sql`update product_variants set stock = stock + 50`);
  const res = await request(app).get('/api/products');
  V = {};
  for (const p of res.body.products) for (const v of p.variants) V[`${p.sku}/${v.size}`] = v.id;
  [admin] = (await db.execute(sql`insert into users (email, name, role, password_hash)
    values (${`mailadmin${Date.now()}@nura.test`}, 'Mail Admin', 'ADMIN', 'x') returning id`)).rows;
});
afterAll(async () => { await paystack(); await seed({ log: () => {} }); sessionStore.close(); await pool.end(); });
beforeEach(() => { outbox.length = 0; });

let ip = 0;
const as = (agent) => {
  const addr = `10.9.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`;
  const wrap = (m) => (url) => agent[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', addr);
  return { get: wrap('get'), post: wrap('post') };
};

/** A guest order. `name` and `method` vary per test; the same checkoutKey can be sent twice. */
async function order({ method = 'COD', name = 'Amina Hassan', county = 'Nairobi', key = randomUUID(), agent = request.agent(app), taps = 1 } = {}) {
  await as(agent).post('/api/cart/items').send({ variantId: V['nura-021/ONE SIZE'] });   // belt, KSh 2,100
  const send = () => as(agent).post('/api/checkout').send({
    checkoutKey: key, email: 'amina@example.com', phone: '0712 345 678', name,
    addressLine1: 'Hse 12, Riverside Lane', area: 'Westlands', county, paymentMethod: method,
  });
  // taps > 1: the same checkout sent several times AT ONCE, as a double tap does. (Sent one
  // after another, the second would just find an empty cart and never reach the order code.)
  const all = await Promise.all(Array.from({ length: taps }, send));
  return { agent, res: all[0], all, order: all[0].body.order };
}
const emailsFor = async (orderId) => (await db.execute(sql`
  select kind, status from order_emails where order_id = ${orderId} order by kind`)).rows;
const sent = (subjectStart) => outbox.filter((m) => m.subject.startsWith(subjectStart));

it('tests never send real email, even with a Resend key in api/.env', () => {
  expect(config.mailEnabled).toBe(false);          // so every message goes to the outbox
});

describe('order emails', () => {
  it('cash on delivery: "received", with the items, the total and how to pay', async () => {
    const { order: o } = await order();
    await mailSettled();
    const [m] = sent(`Order ${o.number} received`);
    expect(m.to).toBe('amina@example.com');
    expect(m.text).toMatch(/0712 345 678/);                       // the number we'll call
    expect(m.text).toMatch(/Pay KSh 2,400 in cash/);               // 2,100 + 300 delivery
    expect(m.html).toContain('Woven Leather Belt');
    expect(await emailsFor(o.id)).toEqual([{ kind: 'received', status: 'sent' }]);
  });

  it('the same checkout sent three times at once (a double tap) is one order and one email', async () => {
    const { all } = await order({ taps: 3 });
    // Each tap either created the order, found it (same key → same order), or arrived after it
    // was placed and found the cart already empty (400). Which mix you get depends on timing:
    // on a slow connection all three overlap; on a fast one the last may come after the first.
    const ok = all.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.order.id)).size).toBe(1);   // never two different orders
    for (const r of all.filter((x) => x.status !== 201)) expect(r.status, r.body.error).toBe(400);
    const o = ok[0].body.order;
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from orders where checkout_key =
      (select checkout_key from orders where id = ${o.id})`)).rows;
    expect(n).toBe(1);
    await mailSettled();
    expect(sent(`Order ${o.number}`)).toHaveLength(1);
  });

  it('the email step itself, called three times at once for one order, sends once', async () => {
    // The timing-free version of the test above: whatever reaches this step, only one gets through.
    const { order: o } = await order();
    await mailSettled(); outbox.length = 0;
    await db.execute(sql`delete from order_emails where order_id = ${o.id}`);
    const results = await Promise.all([1, 2, 3].map(() => queueOrderEmail(o.id, 'received')));
    expect(results.sort()).toEqual(['duplicate', 'duplicate', 'sent']);
    expect(sent(`Order ${o.number}`)).toHaveLength(1);
  });

  it('card: nothing while unpaid; "confirmed" once when paid, however many signals race', async () => {
    const { order: o } = await order({ method: 'CARD', county: 'Kisumu' });
    await mailSettled();
    expect(sent(`Order ${o.number}`)).toHaveLength(0);             // unpaid orders may still expire
    const [p] = (await db.execute(sql`select id from payments where order_id = ${o.id}`)).rows;
    // The webhook, the return from Paystack and the job, all at once:
    await Promise.all([markPaid(p.id, {}, 'card'), markPaid(p.id, {}, 'card'), markPaid(p.id, {}, 'card')]);
    await mailSettled();
    expect(sent(`Order ${o.number} confirmed`)).toHaveLength(1);
  });

  it('shipped: sent when the admin ships it; a COD order is told to have the cash ready', async () => {
    const { order: o } = await order();
    await transitionOrder(admin, o.id, 'PROCESSING');
    await transitionOrder(admin, o.id, 'SHIPPED');
    await mailSettled();
    const [m] = sent(`Order ${o.number} is on its way`);
    expect(m.text).toMatch(/headed to Westlands/);
    expect(m.text).toMatch(/have KSh 2,400 ready in cash/);
    expect((await emailsFor(o.id)).map((e) => e.kind)).toEqual(['received', 'shipped']);
  });

  it('a refused change sends nothing', async () => {
    const { order: o } = await order();
    await expect(transitionOrder(admin, o.id, 'SHIPPED')).rejects.toThrow();   // must be confirmed first
    await mailSettled();
    expect(sent(`Order ${o.number} is on its way`)).toHaveLength(0);
  });

  it('names are text in the HTML, never markup', async () => {
    const { order: o } = await order({ name: '<img src=x onerror=alert(1)> Evil' });
    await mailSettled();
    const [m] = sent(`Order ${o.number}`);
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('after the order: delivered, cancelled, not completed, refunds', () => {
  const payIdOf = async (orderId) => (await db.execute(sql`select id from payments where order_id = ${orderId}`)).rows[0].id;
  const kinds = async (orderId) => (await emailsFor(orderId)).map((e) => e.kind).sort();

  it('cash on delivery: "delivered" when the cash is collected, confirming the payment', async () => {
    const { order: o } = await order();
    await transitionOrder(admin, o.id, 'PROCESSING');
    await transitionOrder(admin, o.id, 'SHIPPED');
    await codCollected(admin, o.id);
    await mailSettled();
    const [m] = sent(`Order ${o.number} delivered`);
    expect(m.text).toMatch(/received your cash payment of KSh 2,400/);
    expect(await kinds(o.id)).toEqual(['delivered', 'received', 'shipped']);
  });

  it('card: "delivered" when marked delivered; no cash line', async () => {
    const { order: o } = await order({ method: 'CARD', county: 'Kisumu' });
    await markPaid(await payIdOf(o.id), {}, 'card');
    for (const to of ['PROCESSING', 'SHIPPED', 'DELIVERED']) await transitionOrder(admin, o.id, to);
    await mailSettled();
    const [m] = sent(`Order ${o.number} delivered`);
    expect(m.text).not.toMatch(/cash/);
  });

  it('cancelled before any payment: says no payment was taken (no refund promised)', async () => {
    const { order: o } = await order();
    await transitionOrder(admin, o.id, 'CANCELLED');
    await mailSettled();
    const [m] = sent(`Order ${o.number} cancelled`);
    expect(m.text).toMatch(/No payment was taken/);
    expect(m.text).not.toMatch(/refund/i);
  });

  it('cancelled after paying by card: the amount and where it goes; "refund sent" when marked refunded', async () => {
    const { order: o } = await order({ method: 'CARD', county: 'Kisumu' });
    await markPaid(await payIdOf(o.id), {}, 'card');
    await transitionOrder(admin, o.id, 'CANCELLED');
    await mailSettled();
    expect(sent(`Order ${o.number} cancelled`)[0].text).toMatch(/You paid KSh 2,400\. We'll refund it to the card you paid with/);
    await markRefunded(admin, o.id);
    await mailSettled();
    const [r] = sent(`Refund sent for order ${o.number}`);
    expect(r.text).toMatch(/refunded KSh 2,400 to the card you paid with\. Card refunds can take a few working days/);
  });

  it('unpaid and expired: "not completed"; money arriving afterwards: "refund due", then "refund sent"', async () => {
    const { order: o } = await order({ method: 'CARD', county: 'Kisumu' });
    await expireOrders(new Date(Date.now() + 16 * 60 * 1000));
    await mailSettled();
    const [x] = sent(`Order ${o.number} wasn’t completed`);
    expect(x.text).toMatch(/If money did leave your account, it will be refunded/);   // never "you weren't charged"

    await markPaid(await payIdOf(o.id), {}, 'card');                                    // paid at the last second
    await mailSettled();
    expect(sent(`About your payment for order ${o.number}`)[0].text).toMatch(/We received KSh 2,400, but by then the order had closed/);
    await markRefunded(admin, o.id);
    await mailSettled();
    expect(sent(`Refund sent for order ${o.number}`)).toHaveLength(1);
    expect(await kinds(o.id)).toEqual(['expired', 'refund_due', 'refunded']);
  });

  it('M-Pesa refunds go back to the paying number, named by its last digits only', () => {
    const o = { id: randomUUID(), number: 'NURA-000099', paymentMethod: 'MPESA', guest: false, totalKes: 2400,
      contact: { name: 'Amina Hassan', email: 'a@example.com', phone: '254712345678' },
      delivery: { addressLine1: 'x', area: 'Westlands', county: 'Nairobi' }, items: [], subtotalKes: 2100, shippingKes: 300,
      paid: { kes: 1, provider: 'DARAJA', phone: '254712345678' } };
    const m = orderMessage('refunded', o);
    expect(m.text).toMatch(/refunded KSh 1 to the M-Pesa number you paid from \(ending 678\)\./);   // the sandbox's KSh 1, honestly
    expect(m.text).not.toMatch(/712 345/);
  });
});

describe('the signed "view your order" link', () => {
  const linkIn = (m) => m.text.match(/order-confirmed\.html#([0-9a-f-]{36})\.(\S+)/);

  it('a guest opens their order on another device with the link from the email', async () => {
    const { order: o } = await order();
    await mailSettled();
    const [, id, token] = linkIn(sent(`Order ${o.number}`)[0]);
    expect(id).toBe(o.id);

    const phone = request.agent(app);
    expect((await as(phone).get(`/api/orders/${o.id}`)).status).toBe(404);    // a stranger's browser
    expect((await as(phone).post(`/api/orders/${o.id}/open`).send({ token })).status).toBe(200);
    const res = await as(phone).get(`/api/orders/${o.id}`);
    expect(res.status).toBe(200);
    expect(res.body.order.number).toBe(o.number);
  });

  it('a changed, expired or borrowed token opens nothing', async () => {
    const { order: o } = await order();
    const { order: other } = await order();
    const good = orderToken(o.id);
    const [exp, sig] = good.split('.');
    const expired = orderToken(o.id, { now: Date.now() - 31 * 24 * 60 * 60 * 1000 });
    for (const token of [`${exp}.${sig.slice(0, -1)}${sig.at(-1) === 'A' ? 'B' : 'A'}`,   // one character changed
                         `${Number(exp) + 999}.${sig}`,                                    // later expiry, same signature
                         expired,
                         orderToken(other.id)]) {                                          // valid, but for another order
      const b = request.agent(app);
      expect((await as(b).post(`/api/orders/${o.id}/open`).send({ token })).status, token).toBe(404);
      expect((await as(b).get(`/api/orders/${o.id}`)).status).toBe(404);
    }
    expect(orderTokenValid(o.id, good)).toBe(true);
  });

  it('an account’s order: the email link has no token, and a token would not open it', async () => {
    const agent = request.agent(app);
    const email = `mailacct${Date.now()}@example.com`;
    await as(agent).post('/api/auth/register').send({ name: 'Kamau N', email, password: 'correct horse battery' });
    const { order: o } = await order({ agent });
    await mailSettled();
    expect(sent(`Order ${o.number}`)[0].text).toMatch(new RegExp(`order-confirmed\\.html#${o.id}\\n`));
    expect((await as(request.agent(app)).post(`/api/orders/${o.id}/open`).send({ token: orderToken(o.id) })).status).toBe(404);
  });
});

describe('delivery through Resend', () => {
  let fake, server, base;
  beforeAll(async () => {
    fake = { calls: [], replies: [] };
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        fake.calls.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(raw) });
        const [status, body] = fake.replies.shift() ?? [200, { id: 'email_1' }];
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
      });
    });
    await new Promise((r) => server.listen(4596, r));
    base = 'http://127.0.0.1:4596';
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => { fake.calls.length = 0; fake.replies.length = 0; });

  const cfg = (extra = {}) => ({ RESEND_API_KEY: 're_testkey_1234567890', RESEND_BASE_URL: base,
                                MAIL_FROM: 'NURA <onboarding@resend.dev>', MAIL_ONLY_TO: null, ...extra });
  const msg = { to: 'amina@example.com', subject: 'Hello', text: 'plain', html: '<p>html</p>' };

  it('posts the message with the key, the sender and both parts', async () => {
    expect(await deliver(msg, cfg())).toBe('sent');
    expect(fake.calls[0]).toEqual({ auth: 'Bearer re_testkey_1234567890', url: '/emails',
      body: { from: 'NURA <onboarding@resend.dev>', to: ['amina@example.com'], subject: 'Hello', text: 'plain', html: '<p>html</p>' } });
  });

  it('held emails are logged with both addresses partly masked, enough to spot a mismatch', () => {
    expect(hint('Ethan.Kamau@Gmail.com')).toBe('et•••u@gmail.com');
    expect(hint('abc@x.co.ke')).toBe('a•••@x.co.ke');                 // short names give away less
  });

  it('MAIL_ONLY_TO: anyone else is held, not sent', async () => {
    expect(await deliver(msg, cfg({ MAIL_ONLY_TO: ['ethan@example.com'] }))).toBe('held');
    expect(fake.calls).toHaveLength(0);
    expect(await deliver({ ...msg, to: 'Ethan@Example.com' }, cfg({ MAIL_ONLY_TO: ['ethan@example.com'] }))).toBe('sent');
  });

  it('a busy Resend (429/5xx) is tried once more; a refusal (403) is not', async () => {
    fake.replies.push([503, { message: 'down' }]);
    expect(await deliver(msg, cfg(), { retryDelayMs: 10 })).toBe('sent');
    expect(fake.calls).toHaveLength(2);
    fake.calls.length = 0;
    fake.replies.push([403, { message: 'You can only send testing emails to your own email address' }]);
    expect(await deliver(msg, cfg(), { retryDelayMs: 10 })).toBe('failed');
    expect(fake.calls).toHaveLength(1);
  });

  it('Resend unreachable: "failed", never an exception', async () => {
    expect(await deliver(msg, cfg({ RESEND_BASE_URL: 'http://127.0.0.1:1' }), { retryDelayMs: 10 })).toBe('failed');
  });
});
