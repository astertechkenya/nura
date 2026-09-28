// orderStates.js: the rules for how an order and its payments may move.
//
// These are pure functions: no database, no Express. That makes them trivial to test
// exhaustively (see test/orderStates.test.js), and every route that changes an order
// must go through them. An admin cannot "set" a status; they can only ask for a move
// that this file allows.
import { httpError } from '../middleware/errors.js';

export const ORDER_STATUSES = Object.freeze([
  'PENDING_PAYMENT', 'AWAITING_COD', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'EXPIRED',
]);

// Moves only the system may make. They happen because something outside the admin's
// control happened: a provider confirmed payment, or the 15-minute window ran out.
export const SYSTEM_NEXT = Object.freeze({
  PENDING_PAYMENT: Object.freeze(['PAID', 'EXPIRED']),
});

// Moves an admin may request from the dashboard.
// AWAITING_COD → PROCESSING happens after confirming the order by phone.
// SHIPPED → DELIVERED for COD goes through the "cash collected" action, which also
// marks the payment PAID in the same transaction (Phase 7).
export const ADMIN_NEXT = Object.freeze({
  PENDING_PAYMENT: Object.freeze(['CANCELLED']),
  AWAITING_COD: Object.freeze(['PROCESSING', 'CANCELLED']),
  PAID: Object.freeze(['PROCESSING', 'CANCELLED']),
  PROCESSING: Object.freeze(['SHIPPED', 'CANCELLED']),
  SHIPPED: Object.freeze(['DELIVERED']),
  // DELIVERED, CANCELLED and EXPIRED are final: nothing moves out of them.
});

/** Is `from` → `to` allowed for this kind of actor ('system' | 'admin')? */
export function canTransition(from, to, actor) {
  const table = actor === 'system' ? SYSTEM_NEXT : actor === 'admin' ? ADMIN_NEXT : null;
  if (!table) throw new Error(`Unknown actor: ${actor}`);
  return (table[from] ?? []).includes(to);
}

/** Throws a 409 the page can show if the move is not allowed. */
export function assertTransition(from, to, actor) {
  if (!canTransition(from, to, actor)) {
    throw httpError(409, `Cannot move an order from ${from} to ${to}`);
  }
}

/**
 * What else must happen, in the same database transaction, when an order moves to `to`.
 *   releaseStock: put the reserved quantities back (the goods never left the shop)
 *   refundDue:    money was taken and the order will not be fulfilled
 * `wasPaid` is whether a payment on this order is PAID (true for card/M-Pesa after PAID,
 * false for a COD order that was never delivered).
 */
export function sideEffects(to, { wasPaid }) {
  const endsUnfulfilled = to === 'CANCELLED' || to === 'EXPIRED';
  return Object.freeze({
    releaseStock: endsUnfulfilled,
    refundDue: to === 'CANCELLED' && wasPaid,
  });
}

/* ── Payments ───────────────────────────────────────────────────────────────────
   PENDING  → PAID | FAILED | FLAGGED   (the provider answered)
   FLAGGED  → PAID | FAILED             (a human reviewed a mismatch)
   PAID and FAILED are final. A retry after FAILED creates a NEW payment row. */
export const PAYMENT_NEXT = Object.freeze({
  PENDING: Object.freeze(['PAID', 'FAILED', 'FLAGGED']),
  FLAGGED: Object.freeze(['PAID', 'FAILED']),
});

export function canTransitionPayment(from, to) {
  return (PAYMENT_NEXT[from] ?? []).includes(to);
}

// Retries (Phase 5): a shopper may re-send the M-Pesa prompt while the order is still
// open, up to this many prompts per order.
export const MAX_STK_ATTEMPTS = 3;

export function canRetryPayment(order) {
  return order.status === 'PENDING_PAYMENT' && order.stkAttempts < MAX_STK_ATTEMPTS;
}
