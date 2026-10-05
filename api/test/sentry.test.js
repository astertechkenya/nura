// Phase 8: error reports leave without personal data, and only when Sentry is configured.
import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import * as Sentry from '@sentry/node';
import { db, pool } from '../src/db/client.js';
import { scrubEvent, initSentry } from '../src/lib/sentry.js';
import { createLogger } from '../src/logger.js';
import { config } from '../src/config.js';
import { Writable } from 'node:stream';

afterAll(() => pool.end());
const dbError = async (q) => { try { await db.execute(q); } catch (e) { return e; } throw new Error('expected a failure'); };

describe('scrubbing an event before it leaves', () => {
  it('request, user, breadcrumbs, local variables and database values all go', async () => {
    const err = await dbError(sql`insert into users (email, name, password_hash) values (${'jane.w@example.com'}, ${'Jane W'}, null)`);
    const event = scrubEvent({
      message: undefined,
      request: { url: 'https://x/api/admin/customers?q=jane', headers: { cookie: 'nura.sid=abc' }, data: { password: 'p' } },
      user: { ip_address: '41.90.1.2' },
      extra: { body: { phone: '0712345678' } },
      breadcrumbs: [{ message: 'GET /api/orders?q=0712' }],
      exception: { values: [
        { type: 'DrizzleQueryError', value: err.message, stacktrace: { frames: [{ function: 'x', vars: { email: 'jane.w@example.com' } }] } },
        { type: 'DatabaseError', value: err.cause.message },
      ] },
    });
    const out = JSON.stringify(event);
    for (const s of ['jane.w@example.com', 'Jane W', 'nura.sid', '41.90.1.2', '0712345678', 'q=jane']) expect(out).not.toContain(s);
    expect(event.request).toBeUndefined();                     // body (with the password) gone
    expect(event.exception.values[0].value).toMatch(/^Failed query: insert into "?users/);
  });

  it('Postgres quoting a bad value, or a duplicate key, is scrubbed too', async () => {
    const bad = await dbError(sql`select ${'0712345678x'}::int`);
    expect(scrubEvent({ exception: { values: [{ value: bad.cause.message }] } }).exception.values[0].value).not.toContain('0712345678');
    expect(scrubEvent({ message: 'Key (email)=(a@b.co) already exists.' }).message).toBe('Key (email)=([redacted]) already exists.');
  });
});

describe('switching it on', () => {
  it('stays off without a DSN (tests and development send nothing)', () => {
    expect(config.SENTRY_DSN).toBeUndefined();
    expect(initSentry(undefined)).toBe(false);
  });

  it('with a DSN: an error logged with { err } is reported once, scrubbed; a warning is not', async () => {
    const sent = [];
    // A DSN pointing nowhere, and a transport that records instead of sending.
    initSentry('https://abc123@o1.ingest.sentry.io/1');
    Sentry.getClient().getOptions().transport = undefined;
    Sentry.getClient().on('beforeSendEvent', (e) => sent.push(e));
    Sentry.getClient().getTransport().send = async () => ({});
    const log = createLogger('info', new Writable({ write(c, e, cb) { cb(); } }));
    const err = await dbError(sql`select ${'secret-thing'}::uuid`);
    log.warn({ err }, 'just a warning');
    log.error({ err }, 'payment job failed');
    log.error('no err object');
    await Sentry.flush(1000);
    expect(sent).toHaveLength(1);
    expect(sent[0].tags.log).toBe('payment job failed');
    expect(JSON.stringify(sent[0])).not.toContain('secret-thing');
    await Sentry.close();
  });
});
