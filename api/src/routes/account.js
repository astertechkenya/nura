// routes/account.js: a signed-in shopper's own account (Phase 7.6).
//
//   GET  /api/account            profile + the delivery details from their latest order
//   POST /api/account/password   { currentPassword, newPassword } → changed; other devices signed out
//   POST /api/account/delete     { password } → account erased; orders kept, detached from it
//
// Saved delivery details are NOT stored separately (decided 1 Oct 2026): they are read from the
// shopper's most recent order. One less copy of anyone's address to protect.
import { Router } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { newsletterSubscribers, orders, users } from '../db/schema.js';
import { validate } from '../middleware/validate.js';
import { httpError } from '../middleware/errors.js';
import { limit } from '../middleware/rateLimit.js';
import { requireAuth } from './auth.js';
import { sendMail } from '../services/mail.js';
import { accountDeletedMessage, passwordChangedMessage } from '../services/emails.js';

export const accountRouter = Router();
accountRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });   // personal
accountRouter.use(requireAuth);

const MINUTE = 60 * 1000;
const newPassword = z.string().min(8, 'Password must be at least 8 characters.').max(128, 'Password must be at most 128 characters.');
const currentPassword = z.string().min(1, 'Please enter your current password.').max(128);
// Per account, not per connection: someone who has a signed-in laptop in front of them
// mustn't be able to guess the password at full speed.
const perAccount = (max, message) => limit({ windowMs: 15 * MINUTE, max, by: (req) => req.session?.userId, ipToo: false, failuresOnly: true, message });

const session = {
  regenerate: (req) => new Promise((ok, fail) => req.session.regenerate((e) => (e ? fail(e) : ok()))),
  save: (req) => new Promise((ok, fail) => req.session.save((e) => (e ? fail(e) : ok()))),
  destroy: (req) => new Promise((ok, fail) => req.session.destroy((e) => (e ? fail(e) : ok()))),
};

accountRouter.get('/', async (req, res) => {
  const u = req.user;
  const [last] = await db.select({
    name: orders.customerName, phone: orders.phone, addressLine1: orders.addressLine1,
    area: orders.addressArea, county: orders.addressCity,
  }).from(orders).where(eq(orders.userId, u.id)).orderBy(desc(orders.createdAt)).limit(1);
  res.json({
    user: { name: u.name, email: u.email, memberSince: u.createdAt },
    lastDelivery: last ?? null,
  });
});

accountRouter.post(
  '/password',
  perAccount(5, 'Too many attempts. Wait 15 minutes and try again.'),
  validate(z.strictObject({ currentPassword, newPassword })),
  async (req, res) => {
    const { currentPassword: cur, newPassword: next } = req.valid.body;
    if (!(await argon2.verify(req.user.passwordHash, cur))) throw httpError(400, 'Your current password isn’t right.');
    if (cur === next) throw httpError(400, 'Choose a password different from your current one.');
    const passwordHash = await argon2.hash(next, { type: argon2.argon2id });
    await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, req.user.id));

    // A new session ID for this browser (credentials changed), then sign out every OTHER
    // device: if the old password leaked, whoever used it is now out.
    await session.regenerate(req);
    req.session.userId = req.user.id;
    await session.save(req);
    await db.execute(sql`delete from sessions where sess->>'userId' = ${req.user.id} and sid <> ${req.sessionID}`);

    sendMail(passwordChangedMessage(req.user));       // "if this wasn't you…": in the background
    res.json({ ok: true });
  },
);

accountRouter.post(
  '/delete',
  perAccount(5, 'Too many attempts. Wait 15 minutes and try again.'),
  validate(z.strictObject({ password: currentPassword })),
  async (req, res) => {
    const u = req.user;
    if (!(await argon2.verify(u.passwordHash, req.valid.body.password))) throw httpError(400, 'That password isn’t right.');
    // Admin accounts sign the audit log; deleting one would break its history. The owner
    // removes those by hand.
    if (u.role !== 'CUSTOMER') throw httpError(403, 'Admin accounts can’t be deleted here.');

    await db.transaction(async (tx) => {
      // Orders stay: they're the shop's records (accounts, refunds, disputes). Deleting the user
      // sets their user_id to null (ON DELETE SET NULL), so they're no longer tied to an account.
      await tx.delete(newsletterSubscribers).where(sql`lower(${newsletterSubscribers.email}) = ${u.email.toLowerCase()}`);
      await tx.execute(sql`delete from sessions where sess->>'userId' = ${u.id}`);
      // Cart, wishlist and reset links go with the account (ON DELETE CASCADE).
      await tx.delete(users).where(and(eq(users.id, u.id), eq(users.role, 'CUSTOMER')));
    });
    await session.destroy(req).catch(() => {});        // its row is already gone
    res.clearCookie('nura.sid', { path: '/' });
    sendMail(accountDeletedMessage(u));
    res.status(204).end();
  },
);
