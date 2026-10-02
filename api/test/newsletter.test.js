import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { verifyNetlifySignature } from '../src/lib/clientIp.js';
import { netlifyToken, TEST_SECRET } from './helpers.js';
import { outbox } from '../src/services/mail.js';
import { confirmToken, readConfirmToken, readUnsubscribeToken, unsubscribeToken } from '../src/lib/newsletterLink.js';

const app = createApp();
afterAll(() => pool.end());

// Each test group signs as a different shopper IP, so their rate-limit counters don't overlap.
const asShopper = (ip) => (r) => r.set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip);
const subscribe = (payload, ip) => asShopper(ip)(request(app).post('/api/newsletter').send(payload));
const countFor = async (email) =>
  Number((await db.execute(sql`select count(*) as n from newsletter_subscribers where email = ${email}`)).rows[0].n);

describe('POST /api/newsletter', () => {
  it('saves a new address, normalised to lower case', async () => {
    const res = await subscribe({ email: '  Wanjiru@Example.COM ' }, '10.0.0.1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await countFor('wanjiru@example.com')).toBe(1);
  });

  it('subscribing twice answers the same and stores one row', async () => {
    const res = await subscribe({ email: 'wanjiru@example.com' }, '10.0.0.1');
    expect(res.body).toEqual({ ok: true });
    expect(await countFor('wanjiru@example.com')).toBe(1);
  });

  it('a filled-in honeypot looks like success but saves nothing', async () => {
    const res = await subscribe({ email: 'bot@spam.test', botField: 'http://spam' }, '10.0.0.2');
    expect(res.status).toBe(200);
    expect(await countFor('bot@spam.test')).toBe(0);
  });

  it('rejects an invalid email with a readable message', async () => {
    const res = await subscribe({ email: 'not-an-email' }, '10.0.0.3');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid email/);
  });

  it('rejects extra fields', async () => {
    const res = await subscribe({ email: 'a@b.co', isAdmin: true }, '10.0.0.3');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown field: isAdmin/);
  });
});

describe('rate limit: 5 per hour per shopper', () => {
  it('the 6th sign-up from one shopper is refused with 429', async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await subscribe({ email: `r${i}@x.co` }, '10.0.1.1')).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('a different shopper behind the same proxy is not affected', async () => {
    expect((await subscribe({ email: 'other@x.co' }, '10.0.1.2')).status).toBe(200);
  });

  it('a FAKE client-IP header (no valid signature) cannot dodge the limit', async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await request(app).post('/api/newsletter')
        .set('x-nf-client-connection-ip', `203.0.113.${i}`)   // a new "IP" every time...
        .set('x-nf-sign', 'forged.token.here')                // ...but no valid signature
        .send({ email: `f${i}@x.co` })).status);
    }
    expect(codes.at(-1)).toBe(429); // all six counted against the real connection
  });
});

describe('Netlify signature check', () => {
  it('accepts a correctly signed, unexpired token', () => {
    expect(verifyNetlifySignature(netlifyToken(), TEST_SECRET)).toMatchObject({ iss: 'netlify' });
  });
  it('rejects a token signed with another secret', () => {
    expect(verifyNetlifySignature(netlifyToken({ secret: 'x'.repeat(40) }), TEST_SECRET)).toBeNull();
  });
  it('rejects an expired token', () => {
    expect(verifyNetlifySignature(netlifyToken({ exp: Math.floor(Date.now() / 1000) - 10 }), TEST_SECRET)).toBeNull();
  });
  it('rejects a token that is not from Netlify', () => {
    expect(verifyNetlifySignature(netlifyToken({ iss: 'someone' }), TEST_SECRET)).toBeNull();
  });
  it('rejects a different algorithm', () => {
    expect(verifyNetlifySignature(netlifyToken({ alg: 'none' }), TEST_SECRET)).toBeNull();
  });
  it('rejects garbage and missing tokens without throwing', () => {
    for (const t of [undefined, '', 'a.b', 'a.b.c', '...', 'x'.repeat(5000)]) {
      expect(verifyNetlifySignature(t, TEST_SECRET)).toBeNull();
    }
  });
  it('trusts nothing when no secret is configured', () => {
    expect(verifyNetlifySignature(netlifyToken(), '')).toBeNull();
    expect(verifyNetlifySignature(netlifyToken(), null)).toBeNull();
  });
});

/* ── Double opt-in ─────────────────────────────────────────────────────────────── */

let n = 0;
const fresh = () => `optin${Date.now()}${n++}@example.com`;
const ipFor = () => `10.0.9.${(n % 250) + 1}`;            // a new shopper each time: no rate limit in the way
const row = async (email) => (await db.execute(sql`select * from newsletter_subscribers where email = ${email}`)).rows[0];
const mailsTo = (email) => outbox.filter((m) => m.to === email);
const linkToken = (mail, kind) => new RegExp(`newsletter\\.html#${kind}\\.(\\S+)`).exec(mail.text)[1];
const post = (path, body) => asShopper(ipFor())(request(app).post(`/api/newsletter${path}`).send(body));

describe('signing up: pending, with one confirmation email', () => {
  it('a new address is pending and gets an email with a confirm link (no address in the link)', async () => {
    const email = fresh();
    expect((await subscribe({ email }, ipFor())).body).toEqual({ ok: true });
    const r = await row(email);
    expect(r.status).toBe('pending');
    const mails = mailsTo(email);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/Confirm/);
    expect(mails[0].text).not.toContain(email.split('@')[0] + '@');     // body text only mentions "this address"
    expect(readConfirmToken(linkToken(mails[0], 'confirm'))).toBe(r.id);
  });

  it('signing up again within the hour sends nothing more (nobody can flood an inbox)', async () => {
    const email = fresh();
    await subscribe({ email }, ipFor()); await subscribe({ email }, ipFor()); await subscribe({ email }, ipFor());
    expect(mailsTo(email)).toHaveLength(1);
  });

  it('after an hour, another sign-up sends a fresh email', async () => {
    const email = fresh();
    await subscribe({ email }, ipFor());
    await db.execute(sql`update newsletter_subscribers set confirm_sent_at = now() - interval '61 minutes' where email = ${email}`);
    await subscribe({ email }, ipFor());
    expect(mailsTo(email)).toHaveLength(2);
  });

  it('eight sign-ups at the same moment: one email', async () => {
    const email = fresh();
    await Promise.all([...Array(8).keys()].map(() => subscribe({ email }, ipFor())));
    expect(mailsTo(email)).toHaveLength(1);
  });

  it('the honeypot still saves and sends nothing', async () => {
    const email = fresh();
    await subscribe({ email, botField: 'x' }, ipFor());
    expect(await row(email)).toBeUndefined();
    expect(mailsTo(email)).toHaveLength(0);
  });
});

describe('confirming', () => {
  it('the link confirms, records when, and pressing it twice is fine', async () => {
    const email = fresh();
    await subscribe({ email }, ipFor());
    const token = linkToken(mailsTo(email)[0], 'confirm');
    expect((await post('/confirm', { token })).body).toEqual({ status: 'confirmed' });
    const r = await row(email);
    expect(r.status).toBe('confirmed');
    expect(Date.now() - new Date(r.confirmed_at)).toBeLessThan(10_000);
    expect((await post('/confirm', { token })).status).toBe(200);
  });

  it('a confirmed address signing up again: same answer, no email, still confirmed', async () => {
    const email = fresh();
    await subscribe({ email }, ipFor());
    await post('/confirm', { token: linkToken(mailsTo(email)[0], 'confirm') });
    await db.execute(sql`update newsletter_subscribers set confirm_sent_at = now() - interval '2 hours' where email = ${email}`);
    expect((await subscribe({ email }, ipFor())).body).toEqual({ ok: true });
    expect(mailsTo(email)).toHaveLength(1);
    expect((await row(email)).status).toBe('confirmed');
  });

  it('expired, tampered, or an unsubscribe link: refused, nothing confirmed', async () => {
    const email = fresh();
    await subscribe({ email }, ipFor());
    const { id } = await row(email);
    const old = confirmToken(id, { now: Date.now() - 8 * 24 * 3600 * 1000 });
    const good = confirmToken(id);
    const other = '00000000-0000-4000-8000-000000000000';
    for (const token of [old, good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA'), good.replace(id, other), unsubscribeToken(id), '', 'x'.repeat(200)]) {
      const res = await post('/confirm', { token });
      expect(res.status, token).toBe(400);
      expect(res.body.error).toMatch(/expired or isn’t valid/);
    }
    expect((await row(email)).status).toBe('pending');
  });
});

describe('unsubscribing', () => {
  it('works, is recorded, and an old confirm link can’t undo it', async () => {
    const email = fresh();
    await subscribe({ email }, ipFor());
    const confirm = linkToken(mailsTo(email)[0], 'confirm');
    await post('/confirm', { token: confirm });
    const { id } = await row(email);
    expect((await post('/unsubscribe', { token: unsubscribeToken(id) })).body).toEqual({ status: 'unsubscribed' });
    expect((await post('/unsubscribe', { token: unsubscribeToken(id) })).status).toBe(200);     // twice is fine
    const r = await row(email);
    expect(r.status).toBe('unsubscribed');
    expect(r.unsubscribed_at).not.toBeNull();
    expect((await post('/confirm', { token: confirm })).status).toBe(400);
    expect((await row(email)).status).toBe('unsubscribed');
  });

  it('signing up again after unsubscribing needs a new confirmation', async () => {
    const email = fresh();
    await subscribe({ email }, ipFor());
    const { id } = await row(email);
    await post('/unsubscribe', { token: unsubscribeToken(id) });
    await db.execute(sql`update newsletter_subscribers set confirm_sent_at = now() - interval '2 hours' where email = ${email}`);
    await subscribe({ email }, ipFor());
    expect((await row(email)).status).toBe('pending');
    const mails = mailsTo(email);
    expect(mails).toHaveLength(2);
    expect((await post('/confirm', { token: linkToken(mails[1], 'confirm') })).body.status).toBe('confirmed');
  });

  it('a forged or confirm-shaped token is refused', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(readUnsubscribeToken(unsubscribeToken(id, { secret: 'y'.repeat(40) }))).toBeNull();
    expect((await post('/unsubscribe', { token: confirmToken(id) })).status).toBe(400);
    expect((await post('/unsubscribe', { token: `${id}.${'A'.repeat(43)}` })).status).toBe(400);
  });
});
