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
      throw httpError(409, 'That payment method is coming soon. Choose cash on delivery for now.');
    }
    const cartId = await cartIdFor(req, res);
    const userId = req.session?.userId ?? null;
    const orderId = await placeOrder({ cartId, userId, details });

    if (!userId) {
      // A guest's proof of ownership is this browser session. Keep the latest 20.
      const ids = (req.session.guestOrderIds ?? []).filter((id) => id !== orderId);
      req.session.guestOrderIds = [...ids, orderId].slice(-20);
      await new Promise((ok, fail) => req.session.save((e) => (e ? fail(e) : ok())));
    }
    res.status(201).json({ order: await loadOrder(orderId) });
  },
);
