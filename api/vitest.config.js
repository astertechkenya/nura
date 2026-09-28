// vitest.config.js: tests run against a SEPARATE database (TEST_DATABASE_URL), which the
// test setup wipes and rebuilds on every run. Never point it at a database you care about.
import { defineConfig } from 'vitest/config';

// Load api/.env if it exists. Only "file not found" is ignored (CI sets real environment
// variables instead); any other problem, like an unreadable file, is reported.
try {
  process.loadEnvFile('.env');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const testUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testUrl) {
  throw new Error(
    'TEST_DATABASE_URL is empty or missing in api/.env. Put the nura_test connection string ' +
    'after TEST_DATABASE_URL= on one line, with no spaces around the = sign.',
  );
}
if (testUrl === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL: the tests wipe their database.');
}
process.env.DATABASE_URL = testUrl; // for globalSetup, which runs in this process

export default defineConfig({
  test: {
    env: {                   // for the test files
      NODE_ENV: 'test',
      DATABASE_URL: testUrl,
      NETLIFY_PROXY_SECRET: 'test-only-secret-that-is-long-enough-123', // never a real secret
    },
    globalSetup: ['./test/globalSetup.js'],
    fileParallelism: false,  // files share one database, so run them one at a time
  },
});
