// migrate.js: applies any SQL files in api/drizzle/ that the database has not seen yet.
//
// Run by `npm run db:migrate` locally and by Render on every deploy. It uses the runtime
// migrator from drizzle-orm (not drizzle-kit), so production does not need dev tools installed.
// Drizzle records what it applied in drizzle.__drizzle_migrations, so running it twice is safe.
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client.js';

export async function runMigrations() {
  const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  await migrate(db, { migrationsFolder });
}

// Only run when executed directly (`node src/db/migrate.js`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runMigrations();
    console.log('Migrations applied.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
