// routes/newsletter.js: the newsletter, with double opt-in (Phase 7).
//
//   POST /api/newsletter              { email, botField? }  sign up → a confirmation email
//   POST /api/newsletter/confirm      { token }             the link in that email (pressed on newsletter.html)
//   POST /api/newsletter/unsubscribe  { token }             the unsubscribe link in every newsletter
//
// Privacy by design: signing up answers the same whether the address is new, waiting to confirm,
// confirmed or unsubscribed, so nobody can use the form to learn whether someone else subscribed.
// An address only counts once its owner clicks the link: typing someone else's address into the
// form gets them one email they can ignore, never a newsletter.
import { Router } from 'express';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { httpError } from '../middleware/errors.js';
import { sendMail } from '../services/mail.js';
import { newsletterConfirmMessage } from '../services/emails.js';
import { confirmUrl, readConfirmToken, readUnsubscribeToken } from '../lib/newsletterLink.js';

export const newsletterRouter = Router();

const body = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email('Please enter a valid email address.').max(254)),
  // Honeypot: a field hidden from people with CSS. Bots that fill in every field fill this one too.
  botField: z.string().max(200).optional(),
});

newsletterRouter.post(
  '/',
  limit({ windowMs: 60 * 60 * 1000, max: 5, message: 'Too many sign-ups from this connection. Try again later.' }),
  validate(body, 'body'),
  async (req, res) => {
    const { email, botField } = req.valid.body;
    if (!botField) {
      // One statement, so two sign-ups at once can't both send an email. It creates the row, or
      // (for someone not yet confirmed, or unsubscribed) makes it pending again, but only if no
      // confirmation went out in the last hour: rotating IP addresses then still can't turn the
      // form into a way to flood someone's inbox. A confirmed address is left alone.
      // RETURNING gives a row only when a confirmation should be sent now.
      const { rows } = await db.execute(sql`
        insert into newsletter_subscribers (email, status, confirm_sent_at) values (${email}, 'pending', now())
        on conflict (email) do update set status = 'pending', confirm_sent_at = now()
          where newsletter_subscribers.status <> 'confirmed'
            and (newsletter_subscribers.confirm_sent_at is null or newsletter_subscribers.confirm_sent_at < now() - interval '1 hour')
        returning id`);
      if (rows[0]) sendMail(newsletterConfirmMessage(email, confirmUrl(rows[0].id)));   // in the background
    }
    // A bot gets the same friendly answer, so it has no reason to try again differently.
    res.status(200).json({ ok: true });
  },
);

const token = z.strictObject({ token: z.string().max(200) });
// Links are unguessable, so this only slows down someone hammering the endpoint.
const linkLimit = limit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many tries. Wait a few minutes.' });

newsletterRouter.post('/confirm', linkLimit, validate(token), async (req, res) => {
  const id = readConfirmToken(req.valid.body.token);
  const bad = () => httpError(400, 'This link has expired or isn’t valid. Sign up again on the homepage and use the newest email.');
  if (!id) throw bad();
  // pending → confirmed. A link pressed twice is fine. Someone who unsubscribed AFTER confirming
  // stays unsubscribed: an old confirmation link must never undo an unsubscribe.
  const { rows } = await db.execute(sql`
    update newsletter_subscribers set status = 'confirmed', confirmed_at = now()
    where id = ${id} and status = 'pending' returning id`);
  if (rows[0]) return res.json({ status: 'confirmed' });
  const [now] = (await db.execute(sql`select status from newsletter_subscribers where id = ${id}`)).rows;
  if (now?.status === 'confirmed') return res.json({ status: 'confirmed' });
  throw bad();
});

newsletterRouter.post('/unsubscribe', linkLimit, validate(token), async (req, res) => {
  const id = readUnsubscribeToken(req.valid.body.token);
  if (!id) throw httpError(400, 'This unsubscribe link isn’t valid. Please use the link in your most recent NURA email.');
  // Always succeeds for a genuine link: already unsubscribed, or the account deleted, is still "off the list".
  await db.execute(sql`
    update newsletter_subscribers set status = 'unsubscribed', unsubscribed_at = now()
    where id = ${id} and status <> 'unsubscribed'`);
  res.json({ status: 'unsubscribed' });
});
