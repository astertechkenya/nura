// check-db.mjs: connects the way the API on Render does (node-postgres, the same certificate
// authorities, sslmode from the string) and reports who it is and what it can see.
// Used by ops/move-production.ps1. The connection string comes from NURA_CHECK_URL and is
// never printed: error messages from pg don't include the password.
import pg from 'pg';

const url = process.env.NURA_CHECK_URL;
if (!url) { console.error('NURA_CHECK_URL is not set'); process.exit(2); }

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
try {
  await client.connect();
  const { rows: [r] } = await client.query('select current_user as who, (select count(*) from products)::int as products');
  const mode = new URL(url).searchParams.get('sslmode');
  // With verify-full, getting this far means Neon's certificate and name were checked.
  console.log(`connected as ${r.who}, ${r.products} products, sslmode=${mode}${mode === 'verify-full' ? ' (certificate checked)' : ''}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
