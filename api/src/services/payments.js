// services/payments.js: M-Pesa payments from "send the prompt" to "the order is paid".
//
// The life of one M-Pesa attempt (one row in `payments`):
//
//   PENDING, no providerRef  → pushPayment() asks Safaricom to prompt the phone
//   PENDING, providerRef set → waiting for the shopper's PIN
//   PAID / FAILED / FLAGGED  → settled, never changed again
//
// Settling always goes through settleFromQuery(): Safaricom's own answer to OUR question. A
// callback posted to us only triggers that question and supplies the receipt number. Every
// status change is a conditional UPDATE ("... where status = 'PENDING'"), so a payment can
// only ever move forward, and only once, however many times a result arrives.
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orderEvents, orders, payments } from '../db/schema.js';
import { httpError } from '../middleware/errors.js';
import { logger } from '../logger.js';
import { queueOrderEmail } from './emails.js';
import { sendAlert } from './alerts.js';
import { amountToRequest, stkPush, stkQuery } from './daraja.js';
import { MAX_STK_ATTEMPTS, assertTransition } from './orderStates.js';

export const PUSHES_PER_PHONE_PER_HOUR = 5;

/** What to tell the shopper for Safaricom's ResultCodes. */
const RESULT_MESSAGES = {
  1: 'Your M-Pesa balance wasn’t enough for this payment.',
  1032: 'The M-Pesa prompt was cancelled.',
  1037: 'We couldn’t reach your phone. Check it’s on and has signal, then resend the prompt.',
  1019: 'The prompt expired before it was answered.',
  2001: 'The M-Pesa PIN was incorrect.',
};
export const failureMessage = (code) => RESULT_MESSAGES[code] ?? 'M-Pesa couldn’t complete the payment.';

/** Pushes to this number in the last hour. Counted in the database, so restarts don't reset it. */
export async function recentPushes(phone, tx = db) {
  const [{ n }] = (await tx.execute(sql`
    select count(*)::int as n from payments
    where provider = 'DARAJA' and phone = ${phone} and created_at > now() - interval '1 hour'`)).rows;
  return n;
}

/**
 * Sends the STK prompt for a PENDING payment that hasn't been sent yet. Runs AFTER the
 * payment row is committed: if the push fails, the order still exists and can be retried.
 * Never throws for a Safaricom problem; the payment becomes FAILED with a reason instead.
 */
export async function pushPayment(paymentId) {
  const [p] = await db
    .select({ id: payments.id, phone: payments.phone, amountKes: payments.amountKes, number: orders.number })
    .from(payments).innerJoin(orders, eq(payments.orderId, orders.id))
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'PENDING'), isNull(payments.providerRef)));
  if (!p) return;
  let checkoutRequestId;
  try {
    ({ checkoutRequestId } = await stkPush({ phone: p.phone, amountKes: p.amountKes, reference: p.number }));
  } catch (err) {
    logger.warn({ err: err.message, paymentId }, 'M-Pesa push failed; payment marked FAILED');
    await db.update(payments)
      .set({ status: 'FAILED', resultCode: 'PUSH_FAILED', failureReason: 'We couldn’t reach M-Pesa. Please try again.', updatedAt: new Date() })
      .where(and(eq(payments.id, p.id), eq(payments.status, 'PENDING')));
    return;
  }
  // The prompt IS on the shopper's phone now, so this ID must not be lost: without it, their
  // payment could never be matched to the order. Try twice; if the database still refuses,
  // log it loudly with everything needed to match it by hand.
  for (let attempt = 1; ; attempt++) {
    try {
      // providerRef IS NULL: if this payment were somehow pushed twice, the first prompt's ID is
      // kept, never overwritten by the second's (which would orphan the first one's callback).
      await db.update(payments).set({ providerRef: checkoutRequestId, updatedAt: new Date() })
        .where(and(eq(payments.id, p.id), eq(payments.status, 'PENDING'), isNull(payments.providerRef)));
      return;
    } catch (err) {
      if (attempt === 2) {
        logger.error({ err: err.message, paymentId, checkoutRequestId, order: p.number },
          'STK prompt sent but its CheckoutRequestID could not be saved: reconcile this payment by hand');
        return;
      }
    }
  }
}

/**
 * A new attempt on an order that is still waiting for payment ("Resend prompt"), optionally
 * to a different number. Returns the new payment's id, to pass to pushPayment().
 */
export async function newAttempt(orderId, phone) {
  return db.transaction(async (tx) => {
    // FOR UPDATE: two taps on "Resend" queue up here instead of both passing the checks.
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!o || o.status !== 'PENDING_PAYMENT') throw httpError(409, 'This order is no longer waiting for payment.');
    if (o.paymentMethod !== 'MPESA') throw httpError(409, 'This order isn’t paid by M-Pesa.');
    if (o.stkAttempts >= MAX_STK_ATTEMPTS) {
      throw httpError(409, `That was the last of ${MAX_STK_ATTEMPTS} M-Pesa prompts for this order. Please place a new order.`);
    }
    const [live] = await tx.select({ id: payments.id }).from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, 'PENDING')));
    if (live) throw httpError(409, 'A prompt is already on its way. Check your phone.');
    const to = phone ?? o.phone;
    if (await recentPushes(to, tx) >= PUSHES_PER_PHONE_PER_HOUR) {
      throw httpError(429, 'Too many M-Pesa prompts to this number. Please wait an hour.');
    }
    await tx.update(orders).set({ stkAttempts: o.stkAttempts + 1, updatedAt: new Date() }).where(eq(orders.id, orderId));
    const [p] = await tx.insert(payments).values({
      orderId, provider: 'DARAJA', phone: to, amountKes: amountToRequest(o.totalKes),
    }).returning({ id: payments.id });
    return p.id;
  });
}

/** `message` is what the shopper reads; for M-Pesa it comes from the ResultCode. */
export async function markFailed(paymentId, resultCode, desc, raw, message = failureMessage(resultCode)) {
  await db.update(payments)
    .set({ status: 'FAILED', resultCode, failureReason: message, raw: raw ?? { resultDesc: desc }, updatedAt: new Date() })
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'PENDING')));
}

/**
 * The provider confirmed the money moved. `fromCallback` (optional) carries the receipt and
 * the amount it reported. Paid, but for a different amount → FLAGGED for a human.
 * Used for M-Pesa and cards alike; `method` only changes the wording of the history note.
 */
export async function markPaid(paymentId, fromCallback = {}, method = 'M-Pesa') {
  const outcome = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
    if (!p || p.status !== 'PENDING') return;                     // already settled: do nothing
    const wrongAmount = fromCallback.amountKes !== undefined && fromCallback.amountKes !== p.amountKes;
    const now = new Date();
    await tx.update(payments).set({
      status: wrongAmount ? 'FLAGGED' : 'PAID',
      // The real figure, for a refund or an accepted difference. -1 (another currency): unknown.
      receivedKes: wrongAmount && fromCallback.amountKes > 0 ? fromCallback.amountKes : null,
      receipt: fromCallback.receipt ?? null,
      resultCode: '0',
      failureReason: wrongAmount ? `Paid ${fromCallback.amountKes} KES, expected ${p.amountKes}` : null,
      raw: fromCallback.raw ?? null,
      updatedAt: now,
    }).where(eq(payments.id, p.id));
    if (wrongAmount) {
      logger.warn({ paymentId, got: fromCallback.amountKes, expected: p.amountKes, method }, 'amount mismatch: payment FLAGGED');
      const [o] = await tx.select({ number: orders.number, expiresAt: orders.expiresAt }).from(orders).where(eq(orders.id, p.orderId));
      // The order stays unpaid until reviewed; the owner is emailed (after the commit, below).
      return { flagged: { orderId: p.orderId, number: o.number, method, expectedKes: p.amountKes,
                          gotKes: fromCallback.amountKes, receipt: fromCallback.receipt, expiresAt: o.expiresAt } };
    }

    const [o] = await tx.select().from(orders).where(eq(orders.id, p.orderId)).for('update');
    if (o.status === 'PENDING_PAYMENT') {
      assertTransition(o.status, 'PAID', 'system');
      await tx.update(orders).set({ status: 'PAID', expiresAt: null, updatedAt: now }).where(eq(orders.id, o.id));
      await tx.insert(orderEvents).values({ orderId: o.id, fromStatus: o.status, toStatus: 'PAID',
        note: `Paid by ${method}${fromCallback.receipt ? ` (${fromCallback.receipt})` : ''}` });
      return { paid: o.id };                                       // this call made it PAID
    } else {
      // Money arrived after the order expired or was cancelled: its stock is gone, so the
      // shopper is owed a refund. Recorded for the admin (Phase 7) to act on.
      await tx.update(orders).set({ refundStatus: 'DUE', updatedAt: now }).where(eq(orders.id, o.id));
      await tx.insert(orderEvents).values({ orderId: o.id, fromStatus: o.status, toStatus: o.status,
        note: `${method} payment arrived after the order closed: refund due` });
      logger.warn({ orderId: o.id, status: o.status, method }, 'late payment: refund due');
      return { late: o.id, alert: { orderId: o.id, number: o.number, method, expectedKes: p.amountKes,
                                    receipt: fromCallback.receipt, orderStatus: o.status } };
    }
    return null;
  });
  // After the commit, and only from the one call that settled this payment (the row lock
  // above makes sure there is exactly one, however many callbacks race).
  if (outcome?.paid) queueOrderEmail(outcome.paid, 'confirmed');
  if (outcome?.late) queueOrderEmail(outcome.late, 'refund_due');
  if (outcome?.late) sendAlert('refund_due', outcome.alert);
  if (outcome?.flagged) sendAlert('flagged', outcome.flagged);
}

/** Ask Safaricom about one payment and record the answer. Returns the state it found. */
export async function settleFromQuery(payment, fromCallback) {
  const answer = await stkQuery(payment.providerRef);
  if (answer.state === 'paid') await markPaid(payment.id, fromCallback);
  else if (answer.state === 'failed') await markFailed(payment.id, answer.resultCode, answer.resultDesc, fromCallback?.raw);
  return answer.state;
}

/** Reads Safaricom's callback body. Returns null if it isn't one. */
export function parseCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb || typeof cb.CheckoutRequestID !== 'string') return null;
  const items = Object.fromEntries((cb.CallbackMetadata?.Item ?? []).map((i) => [i.Name, i.Value]));
  return {
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: String(cb.ResultCode),
    amountKes: items.Amount !== undefined ? Number(items.Amount) : undefined,
    receipt: typeof items.MpesaReceiptNumber === 'string' ? items.MpesaReceiptNumber : undefined,
    raw: body,
  };
}

/** A callback arrived. Find its payment; if it's still open, go and ask Safaricom. */
export async function handleCallback(body) {
  const cb = parseCallback(body);
  if (!cb) { logger.warn('M-Pesa callback without a stkCallback: ignored'); return; }
  const [p] = await db.select().from(payments).where(eq(payments.providerRef, cb.checkoutRequestId));
  if (!p) { logger.warn({ ref: cb.checkoutRequestId }, 'M-Pesa callback for an unknown payment: ignored'); return; }
  if (p.status !== 'PENDING') return;                             // a repeat: already settled
  const state = await settleFromQuery(p, { receipt: cb.receipt, amountKes: cb.amountKes, raw: cb.raw });
  if (state === 'pending') logger.info({ paymentId: p.id }, 'callback arrived but Safaricom still says pending; the job will re-check');
}

/**
 * Every minute: settle prompts that have had no callback (the shopper's phone was off, or the
 * callback never reached us), and give up on pushes that never got sent.
 */
export async function reconcilePayments(now = new Date()) {
  const quietFor = new Date(now.getTime() - 60 * 1000);
  const open = await db.select().from(payments)
    .where(and(eq(payments.provider, 'DARAJA'), eq(payments.status, 'PENDING'), isNotNull(payments.providerRef), lt(payments.createdAt, quietFor)))
    .limit(20);
  let settled = 0;
  for (const p of open) {
    try {
      if (await settleFromQuery(p) !== 'pending') settled += 1;
    } catch (err) {
      logger.warn({ err: err.message, paymentId: p.id }, 'STK query failed; will retry next minute');
    }
  }
  await db.update(payments)
    .set({ status: 'FAILED', resultCode: 'PUSH_FAILED', failureReason: 'We couldn’t reach M-Pesa. Please try again.', updatedAt: now })
    .where(and(eq(payments.provider, 'DARAJA'), eq(payments.status, 'PENDING'), isNull(payments.providerRef),
               lt(payments.createdAt, new Date(now.getTime() - 2 * 60 * 1000))));
  return settled;
}

/** The latest attempt, as the order page shows it. */
export async function paymentSummary(orderId) {
  const [p] = await db.select().from(payments).where(eq(payments.orderId, orderId))
    .orderBy(sql`${payments.createdAt} desc`).limit(1);
  if (!p) return null;
  return {
    status: p.status,
    provider: p.provider,
    sent: Boolean(p.providerRef),
    phone: p.phone,
    amountKes: p.amountKes,        // what the phone prompt asks for (a token amount in the sandbox)
    receivedKes: p.receivedKes,     // set when a different amount arrived (FLAGGED, or accepted by the admin)
    receipt: p.receipt,
    resultCode: p.resultCode,
    message: p.status === 'FAILED' ? p.failureReason : null,
  };
}
