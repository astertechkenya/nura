// Phase 8: the server knows when the database is behind the code.
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db/client.js';
import { journal, pendingMigrations } from '../src/db/schemaCheck.js';

afterAll(() => pool.end());

describe('missing migrations', () => {
  it('none when the database has run every migration in drizzle/', async () => {
    expect(await pendingMigrations()).toEqual([]);
  });
  it('names a migration the code has and the database hasn’t', async () => {
    const extra = { idx: 99, when: 4102444800000, tag: '0099_from_the_future' };
    expect(await pendingMigrations([...journal(), extra])).toEqual(['0099_from_the_future']);
  });
});
