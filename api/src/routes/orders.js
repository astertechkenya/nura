// routes/orders.js: a shopper's own orders.
//
//   GET /api/orders       signed-in: order history, newest first
//   GET /api/orders/:id   one order, to its owner only (the account, or the guest's browser)
//   POST /api/orders/:id/pay  { phone? }  pay again: M-Pesa → another prompt (max 3),
//                                          card → back to Paystack's page ({ redirectUrl })
//   POST /api/orders/:id/check              card: "I'm back from Paystack", settle it now
//   POST /api/orders/:id/open  { token }    the signed link from an order email: this browser
//                                          may now see the guest order (see lib/orderLink.js)
//
// Anyone else gets 404, not 403: "forbidden" would confirm the order exists, and order IDs
// are random UUIDs precisely so they can't be guessed or counted.
import { Router } from 'express';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { validate } from '../middleware/validate.js';
import { httpError } from '../middleware/errors.js';
import { requireAuth } from './auth.js';
import { canSeeOrder, loadOrder } from '../services/orders.js';
import { newAttempt, pushPayment } from '../services/payments.js';
import { cardAttempt, checkCardOrder } from '../services/cardPayments.js';
import { normalisePhone } from '../lib/kenya.js';
import { limit } from '../middleware/rateLimit.js';
import { orderTokenValid } from '../lib/orderLink.js';

export const ordersRouter = Router();
ordersRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

ordersRouter.get('/', requireAuth, async (req, res) => {
  const rows = await db
    .select({
      id: orders.id, number: orders.number, status: orders.status, paymentMethod: orders.paymentMethod,
      totalKes: orders.totalKes, placedAt: orders.createdAt,
      // Written as plain SQL on purpose: inside a subquery, Drizzle would print orders.id as a
      // bare "id", which Postgres would read as order_items.id (a real bug the tests caught).
      itemCount: sql`(select coalesce(sum(oi.qty), 0)::int from order_items oi where oi.order_id = "orders"."id")`,
    })
    .from(orders)
    .where(eq(orders.userId, req.user.id))
    .orderBy(desc(orders.createdAt))
    .limit(100);
  res.json({ orders: rows });
});

ordersRouter.get('/:id', validate(z.strictObject({ id: z.uuid() }), 'params'), async (req, res) => {
  const { id } = req.valid.params;
  if (!(await canSeeOrder(req, id))) throw httpError(404, 'Order not found.');
  res.json({ order: await loadOrder(id) });
});

// The email link's token, swapped once for access in this browser. Guest orders only: an
// account's order opens by signing in, so a forwarded email can't bypass the account.
// Same 404 for every failure (bad token, expired, account order, no such order): nothing
// here tells a stranger which of those it was.
ordersRouter.post(
  '/:id/open',
  limit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts. Please wait a little.' }),
  validate(z.strictObject({ id: z.uuid() }), 'params'),
  validate(z.strictObject({ token: z.string().max(80) })),
  async (req, res) => {
    const { id } = req.valid.params;
    const [o] = await db.select({ userId: orders.userId }).from(orders).where(eq(orders.id, id));
    if (!o || o.userId || !orderTokenValid(id, req.valid.body.token)) {
      throw httpError(404, 'This order link has expired or isn’t valid.');
    }
    const ids = (req.session.guestOrderIds ?? []).filter((x) => x !== id);
    req.session.guestOrderIds = [...ids, id].slice(-20);
    await new Promise((ok, fail) => req.session.save((e) => (e ? fail(e) : ok())));
    res.json({ ok: true });
  },
);

const payBody = z.strictObject({
  phone: z.string().max(20).transform((p, ctx) => {
    const n = normalisePhone(p);
    if (!n) ctx.addIssue({ code: 'custom', message: 'Please enter a Kenyan mobile number, like 0712 345 678.' });
    return n ?? z.NEVER;
  }).optional(),
});

ordersRouter.post(
  '/:id/pay',
  limit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many payment attempts. Please wait a little.' }),
  validate(z.strictObject({ id: z.uuid() }), 'params'),
  validate(payBody),
  async (req, res) => {
    const { id } = req.valid.params;
    if (!(await canSeeOrder(req, id))) throw httpError(404, 'Order not found.');
    const [o] = await db.select({ method: orders.paymentMethod }).from(orders).where(eq(orders.id, id));
    if (o.method === 'CARD') {
      const redirectUrl = await cardAttempt(id);                 // null = it turned out to be paid already
      return res.json({ order: await loadOrder(id), redirectUrl });
    }
    const paymentId = await newAttempt(id, req.valid.body.phone);
    await pushPayment(paymentId);
    res.json({ order: await loadOrder(id) });
  },
);

ordersRouter.post(
  '/:id/check',
  limit({ windowMs: 60 * 1000, max: 20, message: 'Please wait a moment.' }),
  validate(z.strictObject({ id: z.uuid() }), 'params'),
  async (req, res) => {
    const { id } = req.valid.params;
    if (!(await canSeeOrder(req, id))) throw httpError(404, 'Order not found.');
    await checkCardOrder(id);
    res.json({ order: await loadOrder(id) });
  },
);
