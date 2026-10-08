// routes/auth.js: accounts and sign-in.
//
//   POST /api/auth/register  { name, email, password }  → signed in
//   POST /api/auth/login     { email, password }        → signed in
//   POST /api/auth/logout                               → signed out
//   GET  /api/auth/me                                   → { user } or { user: null }
//   POST /api/auth/forgot    { email }                  → always the same answer
//   POST /api/auth/reset     { token, password }        → new password, other sessions ended, signed in
//
// Nothing about a password ever reaches the browser or the logs. The database holds only an
// argon2id hash, which is deliberately slow to compute, so a stolen copy of the table is
// expensive to attack.
import { Router } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, passwordResetTokens } from '../db/schema.js';
import { config } from '../config.js';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { httpError } from '../middleware/errors.js';
import { inBackground, sendMail } from '../services/mail.js';
import { resetMessage, welcomeMessage } from '../services/emails.js';
import { mergeGuestCart } from '../services/cart.js';
import { claimGuestOrders } from '../services/orders.js';

export const authRouter = Router();

const RESET_TTL_MS = 30 * 60 * 1000;   // reset links work for 30 minutes
const MINUTE = 60 * 1000;

// Computed once at startup. When an email has no account we still verify against this, so a
// wrong email takes as long as a wrong password and response times don't reveal who has an account.
const DUMMY_HASH = await argon2.hash('not-a-real-password-just-for-timing');

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const email = z.string().trim().toLowerCase().pipe(z.email('Please enter a valid email address.').max(254));
// Length is what makes passwords strong. No "must contain a symbol" rules: they push people
// towards predictable patterns like Password1!. 128 max keeps hashing time bounded.
const password = z.string().min(8, 'Password must be at least 8 characters.').max(128, 'Password must be at most 128 characters.');

export const publicUser = (u) => ({ name: u.name, email: u.email });

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// express-session uses callbacks; these wrap them so routes can simply `await`.
const regenerate = (req) => new Promise((ok, fail) => req.session.regenerate((e) => (e ? fail(e) : ok())));
const saveSession = (req) => new Promise((ok, fail) => req.session.save((e) => (e ? fail(e) : ok())));
const destroySession = (req) => new Promise((ok, fail) => req.session.destroy((e) => (e ? fail(e) : ok())));

/** Starts a fresh session for this user. A NEW session ID on every sign-in defeats "session
 *  fixation", where an attacker plants a known ID in your browser before you log in.
 *  Then anything this browser put in its cart as a guest moves into the account's cart, and
 *  orders it placed as a guest with this account's email join the account's history. */
async function signIn(req, res, user) {
  const guestOrderIds = req.session?.guestOrderIds;   // read before the old session is thrown away
  await regenerate(req);
  req.session.userId = user.id;
  await saveSession(req);
  await mergeGuestCart(req, res, user.id);
  await claimGuestOrders(guestOrderIds, user.id, user.email);
}

async function findUserByEmail(addr) {
  const [u] = await db.select().from(users).where(sql`lower(${users.email}) = ${addr}`);
  return u ?? null;
}

/** Route guard for later phases: 401 unless signed in; puts the user on req.user. */
export async function requireAuth(req, res, next) {
  const id = req.session?.userId;
  const [u] = id ? await db.select().from(users).where(eq(users.id, id)) : [];
  if (!u) return next(httpError(401, 'Please sign in first.'));
  req.user = u;
  next();
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

const registerBody = z.strictObject({            // strict: a "role" field is a 400, not an admin
  name: z.string().trim().min(1, 'Please enter your name.').max(80),
  email,
  password,
});

authRouter.post(
  '/register',
  limit({ windowMs: 60 * MINUTE, max: 5, message: 'Too many new accounts from this connection. Try again later.' }),
  validate(registerBody),
  async (req, res) => {
    const { name, email: addr, password: pw } = req.valid.body;
    // Registration does say when an email is taken: a shop can't hide that without email
    // verification (Phase 7). The rate limit above keeps this from being used to scan emails.
    if (await findUserByEmail(addr)) {
      throw httpError(409, 'An account with this email already exists. Sign in, or reset your password.');
    }
    const passwordHash = await argon2.hash(pw, { type: argon2.argon2id });
    const [user] = await db.insert(users).values({ name, email: addr, passwordHash })
      .onConflictDoNothing()                      // two simultaneous sign-ups: only one row wins
      .returning();
    if (!user) throw httpError(409, 'An account with this email already exists. Sign in, or reset your password.');
    await signIn(req, res, user);
    sendMail(welcomeMessage(user));                 // in the background: never delays the sign-up
    res.status(201).json({ user: publicUser(user) });
  },
);

const loginBody = z.strictObject({ email, password: z.string().min(1, 'Please enter your password.').max(128) });

authRouter.post(
  '/login',
  // 5 tries per 15 minutes per connection+email. Throttling, not lockout: locking accounts
  // after N failures would let anyone lock any customer out just by knowing their email.
  limit({ windowMs: 15 * MINUTE, max: 5, by: (req) => req.body?.email,
          message: 'Too many sign-in attempts. Wait 15 minutes, or reset your password.' }),
  // And per connection alone, counting only wrong passwords (Oct 2026): the limit above is per
  // email, so one address could otherwise try 5 passwords on every email in a leaked list.
  // Generous, because Kenyan mobile networks put many customers behind one shared address.
  limit({ windowMs: 15 * MINUTE, max: 30, failuresOnly: true,
          message: 'Too many sign-in attempts from this connection. Wait 15 minutes.' }),
  validate(loginBody),
  async (req, res) => {
    const { email: addr, password: pw } = req.valid.body;
    const user = await findUserByEmail(addr);
    const ok = await argon2.verify(user?.passwordHash ?? DUMMY_HASH, pw);
    // One message for both mistakes: never reveal whether the email has an account.
    if (!user || !ok) throw httpError(401, 'Incorrect email or password.');
    await signIn(req, res, user);
    res.json({ user: publicUser(user) });
  },
);

authRouter.post('/logout', async (req, res) => {
  if (req.session) await destroySession(req);
  res.clearCookie('nura.sid', { path: '/' });
  res.status(204).end();
});

authRouter.get('/me', async (req, res) => {
  res.set('Cache-Control', 'no-store');           // personal: never cache anywhere
  const id = req.session?.userId;
  const [user] = id ? await db.select().from(users).where(eq(users.id, id)) : [];
  res.json({ user: user ? publicUser(user) : null });
});

const FORGOT_REPLY = { ok: true, message: 'If an account exists for that email, a reset link is on its way. It works for 30 minutes.' };

authRouter.post(
  '/forgot',
  limit({ windowMs: 60 * MINUTE, max: 3, by: (req) => req.body?.email,
          message: 'Too many reset requests for this email. Try again later.' }),
  // Per connection too: otherwise one address could send reset emails to any number of people.
  limit({ windowMs: 60 * MINUTE, max: 20, message: 'Too many reset requests. Try again later.' }),
  validate(z.strictObject({ email })),
  async (req, res) => {
    const user = await findUserByEmail(req.valid.body.email);
    if (user) {
      // Everything after the lookup runs in the background, so this request does the SAME work
      // whether or not the account exists. Writing the token or calling Resend here would make
      // real accounts measurably slower to answer, and that difference would reveal who has one.
      inBackground('password reset', async () => {
        // 32 random bytes = 256 bits: unguessable. Only its hash is stored, so a copy of the
        // database contains no working reset links.
        const token = randomBytes(32).toString('base64url');
        await db.transaction(async (tx) => {
          await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id)); // one live link at a time
          await tx.insert(passwordResetTokens).values({
            userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS),
          });
        });
        // The token goes in the #fragment: browsers never send it to any server, so it can't
        // leak through server logs or the Referer header.
        return sendMail(resetMessage(user, `${config.SITE_URL}/reset.html#token=${token}`));
      });
    }
    res.json(FORGOT_REPLY);                         // identical whether or not the account exists
  },
);

const resetBody = z.strictObject({ token: z.string().min(20).max(200), password });

authRouter.post(
  '/reset',
  limit({ windowMs: 60 * MINUTE, max: 10, message: 'Too many attempts. Try again later.' }),
  validate(resetBody),
  async (req, res) => {
    const { token, password: pw } = req.valid.body;
    const passwordHash = await argon2.hash(pw, { type: argon2.argon2id });

    const user = await db.transaction(async (tx) => {
      // Claim the token in one statement: it must exist, be unused and unexpired. Marking it
      // used in the same UPDATE means two simultaneous clicks can't both succeed.
      const [claimed] = await tx.update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.tokenHash, sha256(token)),
                   isNull(passwordResetTokens.usedAt),
                   gt(passwordResetTokens.expiresAt, new Date())))
        .returning();
      if (!claimed) return null;
      const [u] = await tx.update(users).set({ passwordHash }).where(eq(users.id, claimed.userId)).returning();
      // A reset means "someone may know my old password": sign out every device.
      await tx.execute(sql`delete from sessions where sess->>'userId' = ${u.id}`);
      return u;
    });
    if (!user) throw httpError(400, 'This reset link has expired or was already used. Request a new one.');
    await signIn(req, res, user);
    res.json({ user: publicUser(user) });
  },
);
