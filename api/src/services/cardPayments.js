// services/cardPayments.js: card and Apple Pay payments through Paystack.
//
// The life of one card attempt (one row in `payments`, provider PAYSTACK):
//
//   PENDING, no providerRef  → openCardPayment() asks Paystack for a payment page
//   PENDING, providerRef set → the shopper is on Paystack's page (or left it)
//   PAID / FAILED / FLAGGED  → settled, never changed again
//
// Same rule as M-Pesa: nothing is marked paid on anyone's word. A webhook (signed) or the
// shopper coming back only triggers settleCard(), which asks Paystack itself (verify).
import { and, count, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, payments } from '../db/schema.js';
import { config } from '../config.js';
import { httpError } from '../middleware/errors.js';
import { logger } from '../logger.js';
import { initialize, verify } from './paystack.js';
import { markFailed, markPaid } from './payments.js';

export const MAX_CARD_ATTEMPTS = 5;

/**
 * Opens Paystack's payment page for a PENDING card payment that hasn't got one yet.
 * Returns the address to send the shopper to, or null if Paystack couldn't be reached
 * (the payment is then FAILED and the shopper can try again).
 */
export async function openCardPayment(paymentId) {
  const [p] = await db
    .select({ id: payments.id, amountKes: payments.amountKes, orderId: orders.id, number: orders.number, email: orders.email })
    .from(payments).innerJoin(orders, eq(payments.orderId, orders.id))
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'PENDING')));
  if (!p) return null;
  try {
    const { authorizationUrl } = await initialize({
      email: p.email,
      amountKes: p.amountKes,
      reference: p.id,                                   // our payment's own random id: unique by design
      // Paystack adds ?reference=… when it sends the shopper back; the order page reads it.
      callbackUrl: `${config.SITE_URL}/order-confirmed.html?order=${p.orderId}`,
      // cancel_action: where Paystack's "Cancel payment" link goes. Without it, a shopper who
      // gives up is stranded on Paystack's page; with it, they land back on their order.
      metadata: { order_id: p.orderId, order_number: p.number,
                  cancel_action: `${config.SITE_URL}/order-confirmed.html?order=${p.orderId}` },
    });
    await db.update(payments).set({ providerRef: p.id, raw: { authorizationUrl }, updatedAt: new Date() })
      .where(and(eq(payments.id, p.id), eq(payments.status, 'PENDING')));
    return authorizationUrl;
  } catch (err) {
    logger.warn({ err: err.message, paymentId }, 'Paystack initialize failed; payment marked FAILED');
    await markFailed(p.id, 'INIT_FAILED', err.message, null, 'We couldn’t open the card payment page. Please try again.');
    return null;
  }
}

/** Ask Paystack about one card payment and record the answer. Returns 'paid' | 'failed' | 'open'. */
export async function settleCard(payment) {
  const v = await verify(payment.providerRef);
  if (v.state === 'paid') {
    // A different currency counts as a wrong amount: FLAGGED, never paid.
    const amountKes = v.currency === 'KES' ? v.amountKes : -1;
    await markPaid(payment.id, { amountKes, receipt: v.last4 ? `Card •••• ${v.last4}` : `Paystack ${v.id}`, raw: { paystack: v } }, 'card');
  } else if (v.state === 'failed') {
    await markFailed(payment.id, 'CARD_DECLINED', v.message, { paystack: v },
      v.message ? `The card payment didn’t go through: ${v.message}.` : 'The card payment didn’t go through.');
  }
  return v.state;
}

/**
 * "Pay by card" again on an order that's still waiting. If the last Paystack page is still
 * open (the shopper just closed the tab), the same page is reused; otherwise a new attempt.
 * Returns the address to send the shopper to.
 */
export async function cardAttempt(orderId) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o || o.status !== 'PENDING_PAYMENT') throw httpError(409, 'This order is no longer waiting for payment.');
  if (o.paymentMethod !== 'CARD') throw httpError(409, 'This order isn’t paid by card.');

  const [live] = await db.select().from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'PENDING')));
  if (live?.providerRef) {
    // Maybe they paid and came back another way: check before offering the page again.
    const state = await settleCard(live);
    if (state === 'paid') return null;
    if (state === 'open' && live.raw?.authorizationUrl) return live.raw.authorizationUrl;
    if (state === 'open') await markFailed(live.id, 'SUPERSEDED', 'Replaced by a new attempt', null, 'Replaced by a new card attempt.');
  } else if (live) {
    return openCardPayment(live.id);
  }

  const [{ n }] = await db.select({ n: count() }).from(payments).where(eq(payments.orderId, orderId));
  if (n >= MAX_CARD_ATTEMPTS) throw httpError(409, 'That was the last card attempt for this order. Please place a new order.');
  const [p] = await db.insert(payments).values({ orderId, provider: 'PAYSTACK', amountKes: o.totalKes })
    .returning({ id: payments.id });
  const url = await openCardPayment(p.id);
  if (!url) throw httpError(502, 'We couldn’t open the card payment page. Please try again in a moment.');
  return url;
}

/** The shopper came back from Paystack (or the page asked): settle the latest attempt now. */
export async function checkCardOrder(orderId) {
  const [p] = await db.select().from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.provider, 'PAYSTACK'), eq(payments.status, 'PENDING'), isNotNull(payments.providerRef)))
    .orderBy(desc(payments.createdAt)).limit(1);
  if (p) {
    try { await settleCard(p); } catch (err) { logger.warn({ err: err.message }, 'Paystack verify failed; the job will retry'); }
  }
}

/** A signed webhook arrived. Only charge.success matters; everything else is ignored. */
export async function handlePaystackEvent(event) {
  if (event?.event !== 'charge.success' || typeof event.data?.reference !== 'string') return;
  const [p] = await db.select().from(payments).where(and(eq(payments.providerRef, event.data.reference), eq(payments.provider, 'PAYSTACK')));
  if (!p) { logger.warn({ ref: event.data.reference }, 'Paystack event for an unknown payment: ignored'); return; }
  if (p.status !== 'PENDING') return;                             // a repeat
  await settleCard(p);
}

/**
 * Every minute: card payments with no answer after two minutes are checked with Paystack.
 * A page still "open" after its order has closed (expired or cancelled) is finished: FAILED.
 */
export async function reconcileCards(now = new Date()) {
  const open = await db.select({ payment: payments, orderStatus: orders.status })
    .from(payments).innerJoin(orders, eq(payments.orderId, orders.id))
    .where(and(eq(payments.provider, 'PAYSTACK'), eq(payments.status, 'PENDING'), isNotNull(payments.providerRef),
               lt(payments.createdAt, new Date(now.getTime() - 2 * 60 * 1000))))
    .limit(20);
  let settled = 0;
  for (const { payment, orderStatus } of open) {
    try {
      const state = await settleCard(payment);
      if (state !== 'open') settled += 1;
      else if (orderStatus !== 'PENDING_PAYMENT') {
        await markFailed(payment.id, 'ABANDONED', 'Not completed before the order closed', null, 'The card payment wasn’t completed.');
      }
    } catch (err) {
      logger.warn({ err: err.message, paymentId: payment.id }, 'Paystack verify failed; will retry next minute');
    }
  }
  return settled;
}
