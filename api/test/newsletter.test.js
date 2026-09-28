import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { verifyNetlifySignature } from '../src/lib/clientIp.js';
import { netlifyToken, TEST_SECRET } from './helpers.js';

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
