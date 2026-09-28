// routes/newsletter.js: POST /api/newsletter { email, botField? }
//
// Privacy by design: the answer is the same whether the address is new or already on the
// list, so nobody can use this form to check whether someone else subscribed.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { newsletterSubscribers } from '../db/schema.js';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';

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
      // ON CONFLICT DO NOTHING: subscribing twice is not an error, and it never creates a duplicate.
      await db.insert(newsletterSubscribers).values({ email }).onConflictDoNothing();
    }
    // A bot gets the same friendly answer, so it has no reason to try again differently.
    res.status(200).json({ ok: true });
  },
);
