import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('refuses to start without DATABASE_URL, naming the variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it('refuses a database URL that is not Postgres', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/);
  });
  it('fills in safe defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://u@h/db' });
    expect(c).toMatchObject({ NODE_ENV: 'development', PORT: 3000, NEW_IN_DAYS: 30, isProd: false });
    expect(Object.isFrozen(c)).toBe(true);
  });
  it('turns numeric strings from the environment into numbers', () => {
    expect(loadConfig({ DATABASE_URL: 'postgresql://u@h/db', PORT: '8080' }).PORT).toBe(8080);
  });
});
