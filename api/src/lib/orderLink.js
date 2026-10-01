// orderLink.js: the "View your order" link in emails, for guests.
//
// A guest's order normally opens only in the browser that placed it. The email may be read
// on a phone, so its link carries a token that proves "this link came from NURA, for this
// order, and hasn't expired": an HMAC (a keyed hash) of the order id and an expiry time,
// made with SESSION_SECRET. Nobody without the secret can make one, and changing the id or
// the expiry breaks it.
//
// The token rides in the #fragment of the link, which browsers never send to any server,
// so it can't end up in Netlify's or Render's logs. The page swaps it for access once
// (POST /api/orders/:id/open) and then removes it from the address bar.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export const ORDER_LINK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const sign = (orderId, exp, secret) =>
  // "order-view:" keeps these signatures apart from anything else signed with the same secret.
  createHmac('sha256', secret).update(`order-view:${orderId}:${exp}`).digest('base64url');

export function orderToken(orderId, { now = Date.now(), secret = config.SESSION_SECRET } = {}) {
  const exp = Math.floor((now + ORDER_LINK_DAYS * DAY_MS) / 1000);   // seconds keep it short
  return `${exp}.${sign(orderId, exp, secret)}`;
}

/** True only for a token made by orderToken for this very order, not yet expired. */
export function orderTokenValid(orderId, token, { now = Date.now(), secret = config.SESSION_SECRET } = {}) {
  const m = /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''));
  if (!m || !secret) return false;
  const exp = Number(m[1]);
  if (exp * 1000 < now) return false;
  const expected = Buffer.from(sign(orderId, exp, secret));
  const given = Buffer.from(m[2]);
  // Timing-safe: comparing byte by byte and stopping at the first difference would leak,
  // through response times, how much of a forged signature was right.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The link for an order email: signed for guest orders; account orders just need a sign-in. */
export function orderUrl(order) {
  const base = `${config.SITE_URL}/order-confirmed.html#${order.id}`;
  return order.guest && config.SESSION_SECRET ? `${base}.${orderToken(order.id)}` : base;
}
