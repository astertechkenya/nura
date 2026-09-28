import { describe, it, expect } from 'vitest';
import {
  ORDER_STATUSES, canTransition, assertTransition, sideEffects,
  canTransitionPayment, canRetryPayment, MAX_STK_ATTEMPTS,
} from '../src/services/orderStates.js';

// The whole rulebook written out as a table. The test below checks EVERY pair of statuses
// for both actors (8 × 8 × 2 = 128 cases), so an accidental extra arrow cannot hide.
const ALLOWED = {
  system: ['PENDING_PAYMENT>PAID', 'PENDING_PAYMENT>EXPIRED'],
  admin: [
    'PENDING_PAYMENT>CANCELLED',
    'AWAITING_COD>PROCESSING', 'AWAITING_COD>CANCELLED',
    'PAID>PROCESSING', 'PAID>CANCELLED',
    'PROCESSING>SHIPPED', 'PROCESSING>CANCELLED',
    'SHIPPED>DELIVERED',
  ],
};

describe('order transitions', () => {
  for (const actor of ['system', 'admin']) {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const expected = ALLOWED[actor].includes(`${from}>${to}`);
        it(`${actor}: ${from} → ${to} is ${expected ? 'allowed' : 'refused'}`, () => {
          expect(canTransition(from, to, actor)).toBe(expected);
        });
      }
    }
  }

  it('an admin cannot mark an order paid; only a payment provider can', () => {
    expect(canTransition('PENDING_PAYMENT', 'PAID', 'admin')).toBe(false);
  });

  it('final states have no way out', () => {
    for (const s of ['DELIVERED', 'CANCELLED', 'EXPIRED']) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(s, to, 'admin') || canTransition(s, to, 'system')).toBe(false);
      }
    }
  });

  it('refused moves throw a 409 with a readable message', () => {
    expect(() => assertTransition('SHIPPED', 'CANCELLED', 'admin'))
      .toThrow(expect.objectContaining({ status: 409, message: 'Cannot move an order from SHIPPED to CANCELLED' }));
  });

  it('rejects an unknown actor instead of guessing', () => {
    expect(() => canTransition('PAID', 'PROCESSING', 'customer')).toThrow('Unknown actor');
  });
});

describe('side effects', () => {
  it('cancelling a paid order releases stock and flags a refund', () => {
    expect(sideEffects('CANCELLED', { wasPaid: true })).toEqual({ releaseStock: true, refundDue: true });
  });
  it('cancelling an unpaid COD order releases stock, no refund', () => {
    expect(sideEffects('CANCELLED', { wasPaid: false })).toEqual({ releaseStock: true, refundDue: false });
  });
  it('expiry releases stock', () => {
    expect(sideEffects('EXPIRED', { wasPaid: false })).toEqual({ releaseStock: true, refundDue: false });
  });
  it('shipping keeps stock out', () => {
    expect(sideEffects('SHIPPED', { wasPaid: true })).toEqual({ releaseStock: false, refundDue: false });
  });
});

describe('payments and retries', () => {
  it('payments only move forward', () => {
    expect(canTransitionPayment('PENDING', 'PAID')).toBe(true);
    expect(canTransitionPayment('FLAGGED', 'PAID')).toBe(true);
    expect(canTransitionPayment('FAILED', 'PAID')).toBe(false);  // a retry makes a NEW payment
    expect(canTransitionPayment('PAID', 'FAILED')).toBe(false);  // a replayed failure can't undo a payment
    expect(canTransitionPayment('PAID', 'PAID')).toBe(false);    // nor pay twice
  });
  it(`allows up to ${MAX_STK_ATTEMPTS} M-Pesa prompts while the order is open`, () => {
    expect(canRetryPayment({ status: 'PENDING_PAYMENT', stkAttempts: 2 })).toBe(true);
    expect(canRetryPayment({ status: 'PENDING_PAYMENT', stkAttempts: 3 })).toBe(false);
    expect(canRetryPayment({ status: 'EXPIRED', stkAttempts: 0 })).toBe(false);
  });
});
