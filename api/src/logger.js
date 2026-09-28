// logger.js: structured JSON logs (pino).
//
// `redact` removes secrets before a line is written. This list grows as later phases add
// auth and payments; nothing sensitive should ever reach a log file.
import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.isTest ? 'silent' : config.LOG_LEVEL,
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]',
            '*.password', '*.passwordHash', '*.token'],
    censor: '[redacted]',
  },
});
