// session.js: who is signed in, remembered with a cookie.
//
// The cookie holds only a random session ID. Everything else (which user) lives in the
// `sessions` table, so the browser never holds anything worth stealing except that ID,
// and the cookie is set up so page JavaScript can't read even that.
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from '../config.js';
import { pool } from '../db/client.js';

// Fail at startup, with a clear message, rather than on the first sign-in.
if (!config.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set. Generate one with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
    'and put it in api/.env (locally) or Render\'s Environment settings (production).');
}

const PgStore = connectPgSimple(session);

export const sessionStore = new PgStore({
  pool,
  tableName: 'sessions',            // created by our Drizzle migration, not by the library
  createTableIfMissing: false,
  pruneSessionInterval: config.isTest ? false : 15 * 60,   // delete expired sessions every 15 min
});

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const sessionMiddleware = session({
  store: sessionStore,
  name: 'nura.sid',
  secret: config.SESSION_SECRET,
  resave: false,                    // don't rewrite unchanged sessions on every request
  saveUninitialized: false,         // no cookie at all until someone signs in
  rolling: true,                    // each visit pushes the 30 days forward
  proxy: true,                      // Netlify/Render terminate HTTPS in front of us
  cookie: {
    httpOnly: true,                 // invisible to page JavaScript: an injected script can't steal it
    secure: config.isProd,          // only ever sent over HTTPS in production
    sameSite: 'lax',                // not sent on cross-site form posts (CSRF protection, layer 1)
    maxAge: THIRTY_DAYS_MS,
  },
});
