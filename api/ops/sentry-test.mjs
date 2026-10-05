// sentry-test.mjs: sends one test error to Sentry, to check SENTRY_DSN is right.
//   $env:SENTRY_DSN = Read-Host "Sentry DSN"; node --env-file-if-exists=.env ops/sentry-test.mjs
// The error is harmless and says what it is; resolve it in Sentry afterwards.
import { initSentry, reportError, flushSentry } from '../src/lib/sentry.js';

if (!initSentry(process.env.SENTRY_DSN)) { console.error('SENTRY_DSN is not set.'); process.exit(1); }
reportError(new Error('NURA test error: Sentry is connected (sent by ops/sentry-test.mjs)'), 'sentry-test');
console.log(await flushSentry() ? 'Sent. Look in Sentry → Issues within a minute.' : 'Could not send within 2 seconds. Check the DSN and your connection.');
