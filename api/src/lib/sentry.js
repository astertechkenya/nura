// sentry.js: error reports to Sentry (Phase 8).
//
// Logs tell you something failed if you happen to look. Sentry emails you the first time a new
// kind of error happens, groups repeats, and keeps the stack trace, which line, which file.
//
// Privacy first, because a report leaves our servers (Sentry stores it in the region you chose
// when signing up):
//   - Off unless SENTRY_DSN is set (tests and local development send nothing).
//   - No default integrations. Many of them collect data we must not send: request bodies,
//     headers and cookies, shoppers' IP addresses, console output, the values of local
//     variables at the moment of the error (a password, a phone number). Only the ones that
//     catch crashes and describe the error itself are switched on.
//   - Every event passes through scrubEvent before it leaves: database errors lose the
//     values Postgres and Drizzle put in their messages, and anything request-shaped is removed.
//   - No performance tracing: errors only (and the free plan's quota goes further).
//
// What gets reported: anything logged at level "error" or worse with an `err` (logger.js calls
// reportError), plus crashes and unhandled promise rejections.
import * as Sentry from '@sentry/node';
import { config } from '../config.js';

let enabled = false;

// Drizzle: "Failed query: <sql>\nparams: <values>…"; Postgres data errors quote the value.
const scrubText = (s) => (typeof s === 'string'
  ? s.replace(/\nparams:[\s\S]*$/, '\nparams: [redacted]')
     .replace(/(invalid input (?:syntax|value) for [^:]*: )"(?:[^"\\]|\\.)*"/g, '$1"[redacted]"')
     .replace(/=\((.*?)\)(?=[ .]|$)/g, '=([redacted])')
     .replace(/(Failing row contains )\(.*\)/s, '$1([redacted])')
  : s);

/** Removes anything that could identify a shopper or carry a secret. Exported for tests. */
export function scrubEvent(event) {
  delete event.request;            // URL with query, headers, cookies, body
  delete event.user;               // IP address, ids
  delete event.extra;
  if (event.contexts) { delete event.contexts.response; delete event.contexts.state; }
  delete event.breadcrumbs;
  event.message = scrubText(event.message);
  if (event.logentry) event.logentry.message = scrubText(event.logentry.message);
  for (const ex of event.exception?.values ?? []) {
    ex.value = scrubText(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) delete frame.vars;   // local variables
  }
  return event;
}

export function initSentry(dsn = config.SENTRY_DSN) {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: config.NODE_ENV,
    release: process.env.RENDER_GIT_COMMIT,          // Render sets this: which commit failed
    sendDefaultPii: false,
    tracesSampleRate: 0,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.linkedErrorsIntegration(),              // includes err.cause (the Postgres error)
      Sentry.dedupeIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.nodeContextIntegration(),               // Node version, memory: no personal data
    ],
    beforeSend: scrubEvent,
    beforeBreadcrumb: () => null,                    // no breadcrumbs at all
  });
  enabled = true;
  return true;
}

/** Sends one error to Sentry (no-op when it's off). `message` is our log line, for context. */
export function reportError(err, message) {
  if (!enabled || !(err instanceof Error)) return;
  Sentry.withScope((scope) => {
    if (message) scope.setTag('log', String(message).slice(0, 200));
    Sentry.captureException(err);
  });
}

/** On shutdown: give queued reports up to 2 seconds to leave. */
export const flushSentry = () => (enabled ? Sentry.flush(2000) : Promise.resolve(true));
