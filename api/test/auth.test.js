import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { mailSettled, outbox } from '../src/services/mail.js';
import { sessionStore } from '../src/middleware/session.js';
import { netlifyToken } from './helpers.js';

const app = createApp();
afterAll(async () => { sessionStore.close(); await pool.end(); });

// Each call can pretend to be a different shopper (signed proxy IP), so rate limits from one
// test don't spill into another. `agent` keeps cookies between requests, like a browser.
let ipCounter = 0;
const shopper = () => { const ip = `10.2.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`; return ip; };
function as(agentOrApp, ip = shopper()) {
  // An Express app is a function; supertest's agent is an object that remembers cookies.
  const target = typeof agentOrApp === 'function' ? request(agentOrApp) : agentOrApp;
  const wrap = (method) => (url) => target[method](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip);
  return { get: wrap('get'), post: wrap('post') };
}
const sidOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('nura.sid='));
const uniq = () => `user${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

async function register(agent, overrides = {}) {
  const body = { name: 'Wanjiku Mwangi', email: uniq(), password: 'correct horse battery', ...overrides };
  const res = await as(agent).post('/api/auth/register').send(body);
  return { res, body };
}

describe('register', () => {
  it('creates the account, signs in, and sets a safe cookie', async () => {
    const agent = request.agent(app);
    const { res, body } = await register(agent, { email: 'Mixed.Case@Example.COM' });
    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ name: 'Wanjiku Mwangi', email: 'mixed.case@example.com' });
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('nura.sid='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const me = await as(agent).get('/api/auth/me');
    expect(me.body.user.email).toBe('mixed.case@example.com');
    const [row] = (await db.execute(sql`select password_hash from users where email = 'mixed.case@example.com'`)).rows;
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(body.password);
    // and a welcome email, to the address as normalised
    const welcome = outbox.filter((m) => m.to === 'mixed.case@example.com' && m.subject === 'Welcome to NURA');
    expect(welcome).toHaveLength(1);
    expect(welcome[0].html).toContain('Welcome, Wanjiku');
  });

  it('refuses a second account for the same email, whatever the case', async () => {
    const { body } = await register(request.agent(app));
    const res = await as(app).post('/api/auth/register').send({ ...body, email: body.email.toUpperCase() });
    expect(res.status).toBe(409);
  });

  it('nobody can make themselves an admin', async () => {
    const res = await as(app).post('/api/auth/register').send({ name: 'X', email: uniq(), password: 'longenough1', role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown field: role/);
  });

  it('needs at least 8 characters', async () => {
    const res = await as(app).post('/api/auth/register').send({ name: 'X', email: uniq(), password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8/);
  });
});

describe('login and logout', () => {
  it('wrong password and unknown email get the SAME answer', async () => {
    const { body } = await register(request.agent(app));
    const wrong = await as(app).post('/api/auth/login').send({ email: body.email, password: 'not the password' });
    const nobody = await as(app).post('/api/auth/login').send({ email: uniq(), password: 'not the password' });
    expect(wrong.status).toBe(401);
    expect(nobody.status).toBe(401);
    expect(wrong.body.error).toBe(nobody.body.error);
    expect(wrong.body.error).toBe('Incorrect email or password.');
  });

  it('every sign-in gets a brand-new session ID (no session fixation)', async () => {
    // Fixation: an attacker gets a browser to carry a session ID they know, then waits for the
    // victim to sign in with it. So sign in from a browser that ALREADY has a session cookie:
    // the ID must change, and the old one must stop working.
    const agent = request.agent(app);
    const { res, body } = await register(agent);
    const before = sidOf(res);
    const after = sidOf(await as(agent).post('/api/auth/login').send({ email: body.email, password: body.password }));
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect((await as(app).get('/api/auth/me').set('Cookie', before)).body.user).toBeNull();
  });

  it('logout ends the session on the server, not just in the browser', async () => {
    const agent = request.agent(app);
    const { res } = await register(agent);
    const oldCookie = sidOf(res);
    expect((await as(agent).post('/api/auth/logout')).status).toBe(204);
    expect((await as(agent).get('/api/auth/me')).body.user).toBeNull();
    // Replaying the old cookie (e.g. copied before logout) must not work either.
    const replay = await as(app).get('/api/auth/me').set('Cookie', oldCookie);
    expect(replay.body.user).toBeNull();
  });

  it('/me is never cached', async () => {
    const res = await as(app).get('/api/auth/me');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ user: null });
  });

  it('browsing the catalogue never creates a session cookie', async () => {
    const res = await as(app).get('/api/products?limit=1');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('6th rapid attempt on one email is refused; another email is not affected', async () => {
    const ip = shopper();
    const target = uniq();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await as(app, ip).post('/api/auth/login').send({ email: target, password: 'guess' + i })).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await as(app, ip).post('/api/auth/login').send({ email: uniq(), password: 'x' })).status).toBe(401);
  });
});

describe('password reset', () => {
  beforeEach(() => { outbox.length = 0; });
  const tokenFrom = (mail) => mail.text.match(/#token=([\w-]+)/)[1];
  // The reset email is prepared in the background (so real and unknown emails answer in the
  // same time); wait for it. Sign-ups also send a welcome email, so pick out the reset ones.
  const forgot = async (addr) => {
    const res = await as(app).post('/api/auth/forgot').send({ email: addr });
    await mailSettled();
    return res;
  };
  const resets = () => outbox.filter((m) => m.subject === 'Reset your NURA password');

  it('unknown email: same answer, no email sent', async () => {
    const res = await forgot(uniq());
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/If an account exists/);
    expect(outbox).toHaveLength(0);
  });

  it('known email: the link is emailed, and only its hash is stored', async () => {
    const { body } = await register(request.agent(app));
    const res = await forgot(body.email);
    expect(res.body.message).toMatch(/If an account exists/);
    expect(resets()).toHaveLength(1);
    expect(resets()[0].text).toMatch(/reset\.html#token=/);   // in the fragment, never sent to servers
    expect(resets()[0].html).toMatch(/reset\.html#token=/);   // the button in the HTML part too
    const token = tokenFrom(resets()[0]);
    const stored = (await db.execute(sql`select token_hash from password_reset_tokens`)).rows.map((r) => r.token_hash);
    expect(stored).not.toContain(token);
  });

  it('resetting changes the password, signs out other devices, signs this one in', async () => {
    const phone = request.agent(app);
    const { body } = await register(phone);                        // signed in on a "phone"
    await forgot(body.email);
    const token = tokenFrom(resets()[0]);

    const laptop = request.agent(app);
    const res = await as(laptop).post('/api/auth/reset').send({ token, password: 'a brand new passphrase' });
    expect(res.status).toBe(200);
    expect((await as(laptop).get('/api/auth/me')).body.user.email).toBe(body.email);
    expect((await as(phone).get('/api/auth/me')).body.user).toBeNull();            // phone signed out
    expect((await as(app).post('/api/auth/login').send({ email: body.email, password: body.password })).status).toBe(401);
    expect((await as(app).post('/api/auth/login').send({ email: body.email, password: 'a brand new passphrase' })).status).toBe(200);
    // The same link can't be used twice.
    const again = await as(app).post('/api/auth/reset').send({ token, password: 'another passphrase' });
    expect(again.status).toBe(400);
  });

  it('an expired link is refused', async () => {
    const { body } = await register(request.agent(app));
    await forgot(body.email);
    await db.execute(sql`update password_reset_tokens set expires_at = now() - interval '1 minute'`);
    const res = await as(app).post('/api/auth/reset').send({ token: tokenFrom(resets()[0]), password: 'whatever long enough' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/);
  });

  it('asking again replaces the previous link', async () => {
    const { body } = await register(request.agent(app));
    await forgot(body.email);
    await forgot(body.email);
    const [first, second] = resets().map(tokenFrom);
    expect((await as(app).post('/api/auth/reset').send({ token: first, password: 'first link password' })).status).toBe(400);
    expect((await as(app).post('/api/auth/reset').send({ token: second, password: 'second link password' })).status).toBe(200);
  });
});

describe('cross-site requests (CSRF)', () => {
  it('a POST from another website is refused', async () => {
    const res = await as(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: uniq(), password: 'x' });
    expect(res.status).toBe(403);
  });
  it('a POST from the storefront is accepted', async () => {
    const res = await as(app).post('/api/auth/login').set('Origin', 'http://localhost:8000').send({ email: uniq(), password: 'x' });
    expect(res.status).toBe(401);  // reached the route (wrong password), not blocked
  });
});
