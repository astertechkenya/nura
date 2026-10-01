// services/orders.js: turning a cart into an order, and everything that happens to orders
// without an HTTP request (expiry, claiming guest orders on sign-up).
//
// The one rule that matters most here: stock is taken in the SAME database transaction that
// creates the order, with a conditional UPDATE ("take 1 if at least 1 is left"). Two shoppers
// pressing "Place order" for the last blazer at the same moment can't both win: Postgres runs
// the two UPDATEs one after the other, the second finds stock 0 and changes nothing, and that
// checkout rolls back completely.
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { queueOrderEmail } from './emails.js';
import {
  brands, carts, cartItems, orderEvents, orderItems, orders, payments, productVariants, products,
} from '../db/schema.js';
import { config } from '../config.js';
import { httpError } from '../middleware/errors.js';
import { priceOrder } from './pricing.js';
import { MAX_STK_ATTEMPTS, assertTransition, sideEffects } from './orderStates.js';
import { amountToRequest } from './daraja.js';
import { paymentSummary } from './payments.js';

/** Payment methods that can take orders: M-Pesa once Daraja is configured, cards once Paystack is. */
export const AVAILABLE_METHODS = Object.freeze({ COD: true, MPESA: config.mpesaEnabled, CARD: config.cardEnabled });

/** Can this order be paid in cash? `rules` defaults to the configured ones (tests pass their own). */
export const codAvailable = (county, totalKes, rules = config) =>
  rules.COD_COUNTIES.includes(county) && (rules.COD_MAX_KES === undefined || totalKes <= rules.COD_MAX_KES);

const codRefusal = (county, rules = config) => (!rules.COD_COUNTIES.includes(county)
  ? `Cash on delivery is only available in ${rules.COD_COUNTIES.join(', ')} for now.`
  : `Cash on delivery is available for orders up to KSh ${rules.COD_MAX_KES.toLocaleString('en-KE')}.`);

/** A Postgres "unique violation" on one particular constraint. */
const isUniqueViolation = (err, constraint) =>
  (err?.code ?? err?.cause?.code) === '23505' && (err?.constraint ?? err?.cause?.constraint) === constraint;

/**
 * Creates an order from the cart `cartId`. `details` is the validated checkout form.
 * Returns the new order's id. Throws a 4xx with a shopper-friendly message when it can't.
 */
export async function placeOrder({ cartId, userId, details }) {
  try {
    return await db.transaction(async (tx) => {
      const lines = cartId ? await tx
        .select({
          variantId: productVariants.id, size: productVariants.size, qty: cartItems.qty,
          productId: products.id, sku: products.sku, name: products.name,
          priceKes: products.priceKes, isActive: products.isActive,
        })
        .from(cartItems)
        .innerJoin(productVariants, eq(cartItems.variantId, productVariants.id))
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(eq(cartItems.cartId, cartId))
        .orderBy(asc(products.name), asc(productVariants.size)) : [];
      if (!lines.length) throw httpError(400, 'Your cart is empty.');

      const gone = lines.filter((l) => !l.isActive);
      if (gone.length) {
        throw httpError(409, `${gone.map((l) => l.name).join(', ')} is no longer available. Remove it from your cart to continue.`);
      }

      // Money: prices come from the rows just read, never from the request.
      const { subtotalKes, shippingKes, totalKes } = priceOrder(lines);
      if (details.paymentMethod === 'COD' && !codAvailable(details.county, totalKes)) {
        throw httpError(409, codRefusal(details.county));
      }

      // Reserve stock, line by line. Each UPDATE only succeeds if enough is left.
      for (const l of lines) {
        const took = await tx.update(productVariants)
          .set({ stock: sql`${productVariants.stock} - ${l.qty}` })
          .where(and(eq(productVariants.id, l.variantId), sql`${productVariants.stock} >= ${l.qty}`))
          .returning({ id: productVariants.id });
        if (!took.length) {
          const [{ stock }] = await tx.select({ stock: productVariants.stock }).from(productVariants)
            .where(eq(productVariants.id, l.variantId));
          const size = l.size === 'ONE SIZE' ? '' : ` in size ${l.size}`;
          throw httpError(409, stock === 0
            ? `Sorry, ${l.name}${size} just sold out. Remove it from your cart to continue.`
            : `Sorry, only ${stock} ${l.name}${size} left. Lower the quantity in your cart to continue.`);
        }
      }

      // NURA-000123. A sequence, not "count the orders + 1": two checkouts in the same
      // millisecond still get different numbers, and a deleted order never frees its number.
      const [{ n }] = (await tx.execute(sql`select nextval('order_number_seq')::int as n`)).rows;
      const number = `NURA-${String(n).padStart(6, '0')}`;

      const cod = details.paymentMethod === 'COD';
      const mpesa = details.paymentMethod === 'MPESA';
      const status = cod ? 'AWAITING_COD' : 'PENDING_PAYMENT';
      const [order] = await tx.insert(orders).values({
        number,
        userId: userId ?? null,
        email: details.email,
        phone: details.phone,
        customerName: details.name,
        status,
        paymentMethod: details.paymentMethod,
        subtotalKes, shippingKes, totalKes,
        addressLine1: details.addressLine1,
        addressArea: details.area,
        addressCity: details.county,
        deliveryNotes: details.notes || null,
        checkoutKey: details.checkoutKey,
        stkAttempts: mpesa ? 1 : 0,                   // the checkout itself sends the first prompt
        // COD orders wait for the rider, not for a payment prompt, so they never expire.
        expiresAt: cod ? null : new Date(Date.now() + config.PAYMENT_WINDOW_MINUTES * 60 * 1000),
      }).returning({ id: orders.id });

      // Snapshots: next month's price change must not rewrite this receipt.
      await tx.insert(orderItems).values(lines.map((l) => ({
        orderId: order.id, productId: l.productId, variantId: l.variantId,
        sku: l.sku, name: l.name, size: l.size, unitPriceKes: l.priceKes, qty: l.qty,
      })));
      await tx.insert(payments).values({
        orderId: order.id,
        provider: cod ? 'COD' : mpesa ? 'DARAJA' : 'PAYSTACK',
        phone: mpesa ? details.phone : null,
        amountKes: mpesa ? amountToRequest(totalKes) : totalKes,
      });
      await tx.insert(orderEvents).values({ orderId: order.id, fromStatus: null, toStatus: status, note: 'Order placed' });

      await tx.delete(cartItems).where(eq(cartItems.cartId, cartId));
      await tx.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cartId));
      return order.id;
    });
  } catch (err) {
    // The same checkout sent twice: the first one won the unique checkout_key. Hand back that order.
    if (isUniqueViolation(err, 'orders_checkout_key_unique')) {
      const [existing] = await db.select({ id: orders.id, userId: orders.userId }).from(orders)
        .where(eq(orders.checkoutKey, details.checkoutKey));
      if (existing && (existing.userId ?? null) === (userId ?? null)) return existing.id;
      throw httpError(409, 'This checkout was already used. Reload the page and try again.');
    }
    throw err;
  }
}

/** The money actually taken on an order (all PAID payments) and how it was paid. */
export async function paidOn(orderId) {
  const rows = await db.select({ amountKes: payments.amountKes, provider: payments.provider, phone: payments.phone })
    .from(payments).where(and(eq(payments.orderId, orderId), eq(payments.status, 'PAID')))
    .orderBy(sql`${payments.createdAt} desc`);
  if (!rows.length) return null;
  return { kes: rows.reduce((n, r) => n + r.amountKes, 0), provider: rows[0].provider, phone: rows[0].phone };
}

/** The order as its owner sees it: what was bought, where it goes, and what happens next. */
export async function loadOrder(id) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o) return null;
  const items = await db
    .select({
      sku: orderItems.sku, name: orderItems.name, size: orderItems.size,
      unitPriceKes: orderItems.unitPriceKes, qty: orderItems.qty,
      imageUrl: products.imageUrl, cardBg: products.cardBg, brand: brands.name,
    })
    .from(orderItems)
    .leftJoin(products, eq(orderItems.productId, products.id))   // left: the product may be deleted one day
    .leftJoin(brands, eq(products.brandId, brands.id))
    .where(eq(orderItems.orderId, id))
    .orderBy(asc(orderItems.name));
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    paymentMethod: o.paymentMethod,
    placedAt: o.createdAt,
    contact: { name: o.customerName, email: o.email, phone: o.phone },
    delivery: { addressLine1: o.addressLine1, area: o.addressArea, county: o.addressCity, notes: o.deliveryNotes },
    items: items.map((i) => ({ ...i, lineTotalKes: i.unitPriceKes * i.qty })),
    subtotalKes: o.subtotalKes,
    shippingKes: o.shippingKes,
    totalKes: o.totalKes,
    // Private to the owner, so no need to hide it; used by "Create an account with this email".
    guest: o.userId === null,
    // A refund owed or already sent (cancelled after paying, or paid after it closed).
    refund: o.refundStatus === 'NONE' ? null
      : { status: o.refundStatus, kes: (await paidOn(o.id))?.kes ?? 0 },
    // M-Pesa: where the latest attempt stands, how many prompts are left, and until when.
    payment: await paymentSummary(o.id),
    promptsLeft: o.paymentMethod === 'MPESA' ? Math.max(0, MAX_STK_ATTEMPTS - o.stkAttempts) : 0,
    payBy: o.expiresAt,
  };
}

/** May this request see this order? Its account, or the browser session that placed it as a guest. */
export async function canSeeOrder(req, orderId) {
  const [o] = await db.select({ userId: orders.userId }).from(orders).where(eq(orders.id, orderId));
  if (!o) return false;
  if (o.userId) return o.userId === req.session?.userId;
  return (req.session?.guestOrderIds ?? []).includes(orderId);
}

/**
 * After sign-up or sign-in: guest orders placed in THIS browser session with THIS account's
 * email become the account's orders. Both conditions, so nobody can claim someone else's
 * order just by knowing its email, or just by sharing a computer.
 */
export async function claimGuestOrders(orderIds, userId, email) {
  if (!orderIds?.length) return;
  await db.update(orders).set({ userId })
    .where(and(inArray(orders.id, orderIds), isNull(orders.userId), sql`lower(${orders.email}) = ${email.toLowerCase()}`));
}

/**
 * Unpaid M-Pesa/card orders past their window: mark EXPIRED, give the stock back, close the
 * pending payment. One transaction per run; SKIP LOCKED means a payment callback that is
 * updating an order right now is left alone and looked at again next minute.
 * Returns how many orders expired.
 */
export async function expireOrders(now = new Date()) {
  const expired = await db.transaction(async (tx) => {
    const due = await tx.select({ id: orders.id, status: orders.status }).from(orders)
      .where(and(eq(orders.status, 'PENDING_PAYMENT'), lt(orders.expiresAt, now)))
      .for('update', { skipLocked: true });
    for (const o of due) {
      assertTransition(o.status, 'EXPIRED', 'system');
      if (sideEffects('EXPIRED', { wasPaid: false }).releaseStock) {
        await tx.execute(sql`
          update product_variants v set stock = v.stock + i.qty
          from order_items i where i.order_id = ${o.id} and i.variant_id = v.id`);
      }
      await tx.update(orders).set({ status: 'EXPIRED', updatedAt: now }).where(eq(orders.id, o.id));
      // Close attempts that never reached a provider. An M-Pesa prompt or Paystack page that
      // WAS opened stays PENDING: only the provider knows whether the shopper paid at the last
      // second, and the payments job will ask. If they did, the money is recorded and a refund
      // marked due.
      await tx.update(payments).set({ status: 'FAILED', failureReason: 'Payment window expired', updatedAt: now })
        .where(and(eq(payments.orderId, o.id), eq(payments.status, 'PENDING'),
                   isNull(payments.providerRef)));
      await tx.insert(orderEvents).values({ orderId: o.id, fromStatus: o.status, toStatus: 'EXPIRED', note: 'Not paid in time; stock returned' });
    }
    return due.map((o) => o.id);
  });
  for (const id of expired) queueOrderEmail(id, 'expired');   // after the commit
  return expired.length;
}
