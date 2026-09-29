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
// globalSetup runs in this process and loads config.js, so it needs these too.
const TEST_SESSION_SECRET = 'test-only-session-secret-long-enough-4567';
process.env.DATABASE_URL = testUrl;
process.env.SESSION_SECRET ??= TEST_SESSION_SECRET;

export default defineConfig({
  test: {
    env: {                   // for the test files
      NODE_ENV: 'test',
      DATABASE_URL: testUrl,
      NETLIFY_PROXY_SECRET: 'test-only-secret-that-is-long-enough-123', // never a real secret
      SESSION_SECRET: TEST_SESSION_SECRET,
      // M-Pesa against a FAKE Daraja that test/fakeDaraja.js runs on this port. No test ever
      // talks to Safaricom.
      DARAJA_BASE_URL: 'http://127.0.0.1:4599',
      DARAJA_CONSUMER_KEY: 'test-key',
      DARAJA_CONSUMER_SECRET: 'test-secret',
      DARAJA_SHORTCODE: '174379',
      DARAJA_PASSKEY: 'test-passkey',
      PUBLIC_API_URL: 'https://api.example.test',
      MPESA_CALLBACK_SECRET: 'test-only-callback-secret-0123456789abcdef',
      // Cards against a FAKE Paystack (test/fakePaystack.js). Never a real key.
      PAYSTACK_BASE_URL: 'http://127.0.0.1:4597',
      PAYSTACK_SECRET_KEY: 'sk_test_fakeKeyForTestsOnly0123456789',
    },
    globalSetup: ['./test/globalSetup.js'],
    fileParallelism: false,  // files share one database, so run them one at a time
    // Every test talks to a real database, often in another country (Neon, Frankfurt). The
    // password-reset tests make ~10 round trips plus deliberately slow password hashing, so
    // Vitest's 5-second default is too tight. A test that truly hangs still fails, after 30 s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
