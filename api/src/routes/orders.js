// routes/orders.js: a shopper's own orders.
//
//   GET /api/orders       signed-in: order history, newest first
//   GET /api/orders/:id   one order, to its owner only (the account, or the guest's browser)
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
