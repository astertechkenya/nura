// Phase 8: nothing personal or secret reaches a log line, and CSP reports are logged trimmed.
// Each test writes through NURA's real logger configuration into memory and reads it back.
import { describe, it, expect, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { createLogger } from '../src/logger.js';
import { safeUrl, reqSerializer } from '../src/lib/logSafe.js';
import { readReports, trimUrl } from '../src/routes/csp.js';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { netlifyToken } from './helpers.js';

afterAll(() => pool.end());

function capture() {
  const lines = [];
  const dest = new Writable({ write(chunk, enc, cb) { lines.push(chunk.toString()); cb(); } });
  return { log: createLogger('info', dest), text: () => lines.join('') };
}
const dbError = async (query) => { try { await db.execute(query); } catch (e) { return e; } throw new Error('expected the query to fail'); };

describe('database errors lose the data in them', () => {
  it('a failed insert: the SQL and the code stay, the parameters go', async () => {
    const err = await dbError(sql`insert into users (email, name, password_hash) values (${'jane.wanjiku@example.com'}, ${'Jane Wanjiku'}, null)`);
    const { log, text } = capture();
    log.error({ err }, 'unhandled error');
    const out = text();
    expect(out).toContain('insert into users');
    expect(out).toContain('23502');                         // not-null violation: still debuggable
    expect(out).not.toContain('jane.wanjiku@example.com');
    expect(out).not.toContain('Jane Wanjiku');
  });

  it('a duplicate key: Postgres’ "Key (email)=(…)" detail is scrubbed', async () => {
    await db.execute(sql`create temporary table dup_t (email text primary key)`);
    await db.execute(sql`insert into dup_t values ('taken@example.com')`);
    const err = await dbError(sql`insert into dup_t values (${'taken@example.com'})`);
    const { log, text } = capture();
    log.error({ err }, 'x');
    expect(text()).toContain('23505');
    expect(text()).not.toContain('taken@example.com');
  });

  it('bad input: the value Postgres quotes back is scrubbed', async () => {
    const err = await dbError(sql`select ${'0712345678x'}::int`);
    const { log, text } = capture();
    log.error({ err }, 'x');
    expect(text()).toContain('22P02');
    expect(text()).not.toContain('0712345678');
  });
});

describe('fields and requests', () => {
  it('secret and contact fields are redacted at the top level and one level down', () => {
    const { log, text } = capture();
    log.warn({ password: 'hunter2hunter2', phone: '254712345678', order: { email: 'a@b.co', addressLine1: 'Flat 9', number: 'NUR-1' } }, 'x');
    const out = text();
    for (const s of ['hunter2hunter2', '254712345678', 'a@b.co', 'Flat 9']) expect(out).not.toContain(s);
    expect(out).toContain('NUR-1');                         // ordinary fields are kept
  });

  it('query values are kept only for harmless keys', () => {
    expect(safeUrl('/api/admin/customers?q=jane%40x.com&page=2')).toBe('/api/admin/customers?q=[redacted]&page=2');
    expect(safeUrl('/api/admin/orders?status=TODO&q=0712345678')).toBe('/api/admin/orders?status=TODO&q=[redacted]');
    expect(safeUrl('/api/products?sale=true')).toBe('/api/products?sale=true');
    expect(safeUrl('/api/payments/mpesa/callback/s3cr3t?x=1')).toBe('/api/payments/mpesa/callback/[redacted]?x=[redacted]');
    expect(safeUrl('/api/health')).toBe('/api/health');
  });

  it('the request log line has no headers, cookies or personal query values', () => {
    const { log, text } = capture();
    const req = { id: 'r1', method: 'GET', url: '/api/admin/customers?q=jane', headers: { cookie: 'nura.sid=abc', 'x-nf-sign': 'x' } };
    log.info({ req: reqSerializer(() => null)(req) }, 'request completed');
    expect(text()).not.toMatch(/jane|nura\.sid|cookie/);
    expect(text()).toContain('"viaNetlify":false');
  });

  it('the app wires both in: its error responses never leak, and pino-http uses our error serializer', async () => {
    // Uses the logger the app was built with: same options object.
    const { LOG_OPTIONS } = await import('../src/logger.js');
    const err = await dbError(sql`select ${'secret-value-123'}::uuid`);
    const out = LOG_OPTIONS.serializers.err(err);
    expect(JSON.stringify(out)).not.toContain('secret-value-123');
    const appSrc = (await import('node:fs')).readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
    expect(appSrc).toMatch(/err: LOG_OPTIONS\.serializers\.err/);
    expect(appSrc).toMatch(/req: reqSerializer\(/);
    expect(pino.stdSerializers.err(err).message).toBeTruthy();
  });
});

describe('CSP reports', () => {
  const app = createApp();
  let n = 0;
  const post = (type, body) => request(app).post('/api/csp-report').set('Content-Type', type)
    .set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', `10.33.0.${++n}`).send(JSON.stringify(body));

  it('both report formats are accepted with 204', async () => {
    const old = { 'csp-report': { 'document-uri': 'https://nurafashion.netlify.app/order-confirmed.html?order=1#abc.123.sig', 'violated-directive': 'img-src', 'effective-directive': 'img-src', 'blocked-uri': 'https://evil.example/x.png?leak=1' } };
    expect((await post('application/csp-report', old)).status).toBe(204);
    const neu = [{ type: 'csp-violation', body: { documentURL: 'https://nurafashion.netlify.app/', effectiveDirective: 'script-src-elem', blockedURL: 'inline', disposition: 'enforce' } }];
    expect((await post('application/reports+json', neu)).status).toBe(204);
  });

  it('reports are trimmed: page path only (no tokens), blocked origin and path only', () => {
    const [r] = readReports({ 'csp-report': { 'document-uri': 'https://nurafashion.netlify.app/newsletter.html#confirm.abc', 'effective-directive': 'connect-src', 'blocked-uri': 'https://evil.example/c?d=secret' } });
    expect(r).toEqual({ directive: 'connect-src', blocked: 'https://evil.example/c', page: '/newsletter.html', disposition: 'enforce' });
    expect(trimUrl('inline')).toBe('inline');
    expect(readReports([1, 2, 3].map(() => ({ body: {} })).concat(Array(20).fill({ body: {} })))).toHaveLength(10);
  });

  it('junk is answered without crashing; a flood is limited', async () => {
    expect((await post('application/csp-report', 'nonsense')).status).toBeLessThan(500);
    const ip = '10.33.1.1';
    const codes = [];
    for (let i = 0; i < 31; i++) {
      codes.push((await request(app).post('/api/csp-report').set('Content-Type', 'application/csp-report')
        .set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip).send('{"csp-report":{}}')).status);
    }
    expect(codes.at(-1)).toBe(429);
  });
});
