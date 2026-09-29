// adminGate.js: who may use /api/admin, decided again on EVERY request.
//
//   not signed in      → 401
//   CUSTOMER           → 403
//   DEMO_ADMIN         → may look (GET) at everything, with names, emails and phones masked;
//                        any change → 403. This is the account portfolio visitors use.
//   ADMIN              → everything, after the six-digit code from their authenticator app
//
// The role is read from the database each time, never trusted from the session: demoting an
// admin takes effect on their very next click. Admin sessions also end after 8 hours idle.
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { config } from '../config.js';
import { httpError } from './errors.js';

export const ADMIN_IDLE_MS = 8 * 60 * 60 * 1000;
const READ = new Set(['GET', 'HEAD']);

/** Does this admin still need to enter a code in this session? */
export function needsTotp(user, session) {
  if (user.role !== 'ADMIN') return false;
  if (!user.totpSecret) return config.isProd;              // production: two-factor is compulsory
  return !session.totpVerifiedAt;
}

export async function adminGate(req, res, next) {
  const id = req.session?.userId;
  const [u] = id ? await db.select().from(users).where(eq(users.id, id)) : [];
  if (!u) return next(httpError(401, 'Please sign in.'));
  if (u.role !== 'ADMIN' && u.role !== 'DEMO_ADMIN') return next(httpError(403, 'This account isn’t an admin.'));

  const now = Date.now();
  if (req.session.adminSeenAt && now - req.session.adminSeenAt > ADMIN_IDLE_MS) {
    await new Promise((ok) => req.session.destroy(() => ok()));
    res.clearCookie('nura.sid', { path: '/' });
    return next(httpError(401, 'Your admin session ended after 8 hours idle. Please sign in again.'));
  }
  req.session.adminSeenAt = now;

  req.admin = u;
  req.masked = u.role === 'DEMO_ADMIN';
  // The code check and "who am I" must work before the code is entered.
  const open = req.path === '/me' || req.path === '/totp';
  if (!open && needsTotp(u, req.session)) {
    const err = httpError(401, u.totpSecret ? 'Enter the code from your authenticator app.' : 'Two-factor isn’t set up for this admin. Run npm run create-admin.');
    err.needsTotp = true;
    return next(err);
  }
  if (req.masked && !READ.has(req.method) && req.path !== '/totp') {
    return next(httpError(403, 'The demo admin can look around but can’t change anything.'));
  }
  next();
}
