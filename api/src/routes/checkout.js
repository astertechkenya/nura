// routes/checkout.js: placing an order.
//
//   GET  /api/checkout/options   counties, payment methods, COD rules, delivery fee (for the form)
//   POST /api/checkout           the form → an order, from this browser's cart
//
// The body carries who and where, never what or how much: the items come from the cart in
// the database and every amount is computed here (services/pricing.js).
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { COUNTIES, normalisePhone } from '../lib/kenya.js';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { httpError } from '../middleware/errors.js';
import { cartIdFor } from '../services/cart.js';
import { AVAILABLE_METHODS, loadOrder, placeOrder } from '../services/orders.js';
import { PUSHES_PER_PHONE_PER_HOUR, pushPayment, recentPushes } from '../services/payments.js';
import { openCardPayment } from '../services/cardPayments.js';
import { queueOrderEmail } from '../services/emails.js';
import { db } from '../db/client.js';
import { payments } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';

export const checkoutRouter = Router();
checkoutRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

checkoutRouter.get('/options', (req, res) => {
  res.json({
    counties: COUNTIES,
    methods: AVAILABLE_METHODS,
    cod: { counties: config.COD_COUNTIES, maxKes: config.COD_MAX_KES ?? null },
    shipping: { feeKes: config.SHIPPING_FEE_KES, freeFromKes: config.FREE_SHIPPING_THRESHOLD_KES },
  });
});

const text = (label, max) => z.string().trim().min(1, `Please enter ${label}.`).max(max, `${label} is too long.`);

export const CheckoutSchema = z.strictObject({
  checkoutKey: z.uuid('checkoutKey must be a UUID'),
  email: z.string().trim().toLowerCase().pipe(z.email('Please enter a valid email address.').max(254)),
  phone: z.string().max(20).transform((p, ctx) => {
    const n = normalisePhone(p);
    if (!n) ctx.addIssue({ code: 'custom', message: 'Please enter a Kenyan mobile number, like 0712 345 678.' });
    return n ?? z.NEVER;
  }),
  name: text('your name', 80),
  addressLine1: text('a street or building', 120),
  area: text('an area or estate', 80),
  county: z.enum(COUNTIES, { error: 'Please choose a county.' }),
  notes: z.string().trim().max(300, 'Delivery notes can be up to 300 characters.').optional(),
  paymentMethod: z.enum(['COD', 'MPESA', 'CARD'], { error: 'Please choose how to pay.' }),
});

checkoutRouter.post(
  '/',
  // Generous for a real shopper fixing a typo, tight for a script reserving stock it won't buy.
  limit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many checkout attempts. Please wait a little and try again.' }),
  validate(CheckoutSchema),
  async (req, res) => {
    const details = req.valid.body;
    if (!AVAILABLE_METHODS[details.paymentMethod]) {
      throw httpError(409, 'That payment method is coming soon. Choose another one for now.');
    }
    if (details.paymentMethod === 'MPESA' && await recentPushes(details.phone) >= PUSHES_PER_PHONE_PER_HOUR) {
      throw httpError(429, 'Too many M-Pesa prompts to this number. Please wait an hour, or choose another way to pay.');
    }
    const cartId = await cartIdFor(req, res);
    const userId = req.session?.userId ?? null;
    const { id: orderId, created } = await placeOrder({ cartId, userId, details });

    if (!userId) {
      // A guest's proof of ownership is this browser session. Keep the latest 20.
      const ids = (req.session.guestOrderIds ?? []).filter((id) => id !== orderId);
      req.session.guestOrderIds = [...ids, orderId].slice(-20);
      await new Promise((ok, fail) => req.session.save((e) => (e ? fail(e) : ok())));
    }
    // The order (and its stock) is saved first; only then do we ask Safaricom or Paystack. If
    // they can't be reached, nothing is lost: the payment is FAILED and the shopper retries.
    let redirectUrl = null;
    // COD: the order is final now, so say so. (M-Pesa and card get "confirmed" when paid,
    // never before: an unpaid order may still expire.) Sent at most once, even when the same
    // checkout arrives twice, because order_emails lets one sender through per order.
    if (details.paymentMethod === 'COD') queueOrderEmail(orderId, 'received');
    if (details.paymentMethod !== 'COD') {
      const [p] = await db.select({ id: payments.id, raw: payments.raw }).from(payments)
        .where(and(eq(payments.orderId, orderId), eq(payments.status, 'PENDING')));
      if (p && created) {
        if (details.paymentMethod === 'MPESA') await pushPayment(p.id);
        if (details.paymentMethod === 'CARD') redirectUrl = await openCardPayment(p.id);
      } else if (p && details.paymentMethod === 'CARD') {
        // The same checkout again (a double tap, or a retry after a timeout): never a second
        // prompt or a second Paystack page for the same payment (Oct 2026). A second page would
        // replace the first one's record, and a payment made on the first could then be lost.
        // Send them back to the page that's already open, if it's ready.
        redirectUrl = p.raw?.authorizationUrl ?? null;
      }
    }
    // Card: the browser goes to Paystack's page next (redirectUrl), then comes back.
    res.status(201).json({ order: await loadOrder(orderId), redirectUrl });
  },
);
