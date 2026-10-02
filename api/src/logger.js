// logger.js: structured JSON logs (pino).
//
// Nothing personal or secret should ever reach a log (see lib/logSafe.js for why and how):
//   redact      fields named like secrets or contact details, at any of the first levels
//   serializers errors lose query parameters and the values Postgres quotes back
import { pino } from 'pino';
import { config } from './config.js';
import { errSerializer } from './lib/logSafe.js';

// pino's redact paths are exact: '*.phone' means "a phone field one level down". Logged objects
// are shallow ({ err, paymentId, … }), so the top level and one level down cover them.
const FIELDS = ['password', 'passwordHash', 'newPassword', 'currentPassword', 'token', 'secret', 'totpSecret',
  'phone', 'email', 'to', 'name', 'address', 'addressLine1', 'apiKey', 'api_key', 'signature', 'body'];

export const LOG_OPTIONS = {
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]',
            ...FIELDS, ...FIELDS.map((f) => `*.${f}`)],
    censor: '[redacted]',
  },
  serializers: { err: errSerializer(pino.stdSerializers.err) },
};

/** A logger with NURA's rules. `destination` lets tests read what would have been written. */
export function createLogger(level = config.LOG_LEVEL, destination) {
  return pino({ ...LOG_OPTIONS, level }, destination);
}

export const logger = createLogger(config.isTest ? 'silent' : config.LOG_LEVEL);
