// services/pricing.js: the only place that turns quantities and prices into money.
//
// The cart drawer, checkout and (later) the M-Pesa and card amounts all use these two
// functions, so the number a shopper sees and the number they're charged can't drift apart.
import { config } from '../config.js';

/** Delivery for an order of this subtotal. An empty order costs nothing. */
export function shippingFor(subtotalKes) {
  const free = subtotalKes === 0 || subtotalKes >= config.FREE_SHIPPING_THRESHOLD_KES;
  return free ? 0 : config.SHIPPING_FEE_KES;
}

/** lines: [{ priceKes, qty }] with prices read from the database, never from a request. */
export function priceOrder(lines) {
  const subtotalKes = lines.reduce((sum, l) => sum + l.priceKes * l.qty, 0);
  const shippingKes = shippingFor(subtotalKes);
  return { subtotalKes, shippingKes, totalKes: subtotalKes + shippingKes };
}
