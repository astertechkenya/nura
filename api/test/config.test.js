import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('refuses to start without DATABASE_URL, naming the variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it('refuses a SESSION_SECRET that is too short to be safe', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://u@h/db', SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
  it('scripts like db:migrate run without a SESSION_SECRET', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://u@h/db' })).not.toThrow();
  });
  it('refuses a database URL that is not Postgres', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/);
  });
  it('fills in safe defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://u@h/db', SESSION_SECRET: 's'.repeat(32) });
    expect(c).toMatchObject({ NODE_ENV: 'development', PORT: 3000, NEW_IN_DAYS: 30, isProd: false });
    expect(Object.isFrozen(c)).toBe(true);
  });
  it('refuses an M-Pesa callback secret that would break a web address', () => {
    const base = { DATABASE_URL: 'postgresql://u@h/db' };
    expect(() => loadConfig({ ...base, MPESA_CALLBACK_SECRET: 'a/b+c='.padEnd(40, 'x') })).toThrow(/MPESA_CALLBACK_SECRET/);
    expect(() => loadConfig({ ...base, MPESA_CALLBACK_SECRET: 'Ab0_-'.repeat(9) })).not.toThrow();
  });
  it('MAIL_ONLY_TO: plain addresses (tidied); anything that could never match a recipient is refused', () => {
    const base = { DATABASE_URL: 'postgresql://u@h/db' };
    expect(loadConfig({ ...base, MAIL_ONLY_TO: ' Ethan@Gmail.com , b@nura.co.ke' }).MAIL_ONLY_TO).toEqual(['ethan@gmail.com', 'b@nura.co.ke']);
    expect(loadConfig(base).MAIL_ONLY_TO).toBeNull();
    for (const bad of ['<ethan@gmail.com>', '"ethan@gmail.com"', 'ethan@gmail.com # me', 'a@b.com; c@d.com', 'your email here']) {
      expect(() => loadConfig({ ...base, MAIL_ONLY_TO: bad }), bad).toThrow(/MAIL_ONLY_TO: must be plain email addresses/);
    }
  });
  it('an empty KEY= line means "not set" (as in .env.example), never a startup error', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://u@h/db', RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '',
                           DARAJA_CONSUMER_KEY: '', COD_MAX_KES: '', MAIL_ONLY_TO: '' });
    expect(c).toMatchObject({ mailEnabled: false, cardEnabled: false, mpesaEnabled: false, MAIL_ONLY_TO: null });
    expect(c.COD_MAX_KES).toBeUndefined();
  });
  it('turns numeric strings from the environment into numbers', () => {
    expect(loadConfig({ DATABASE_URL: 'postgresql://u@h/db', SESSION_SECRET: 's'.repeat(32), PORT: '8080' }).PORT).toBe(8080);
  });

  it('production connects as the limited app login, and checks Neon’s certificate', () => {
    const prod = (url) => () => loadConfig({ NODE_ENV: 'production', DATABASE_URL: url, SESSION_SECRET: 's'.repeat(32) });
    expect(prod('postgresql://nura_app:pw@ep-x.neon.tech/nura_prod?sslmode=verify-full&channel_binding=require')).not.toThrow();
    expect(prod('postgresql://nura_app:pw@ep-x.neon.tech/nura_prod?sslmode=require')).toThrow(/verify-full/);
    expect(prod('postgresql://neondb_owner:pw@ep-x.neon.tech/nura_prod?sslmode=verify-full')).toThrow(/limited app login.*neondb_owner/);
    expect(prod('postgresql://nura_prod_owner:pw@h/nura_prod')).toThrow(/verify-full[\s\S]*neondb_owner|verify-full[\s\S]*nura_prod_owner/);
    // Development and tests may use anything (local Postgres has no certificate).
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://neondb_owner@localhost/nura_dev' })).not.toThrow();
  });
});
