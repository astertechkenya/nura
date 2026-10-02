// newsletterLink.js: the links in newsletter emails (Phase 7, double opt-in).
//
//   confirm      newsletter.html#confirm.<id>.<exp>.<sig>   valid 7 days
//   unsubscribe  newsletter.html#unsub.<id>.<sig>           never expires (an unsubscribe link
//                                                           must work in a two-year-old email)
//
// Same idea as orderLink.js: an HMAC with SESSION_SECRET proves the link came from us. The
// links carry the subscriber's random id, never the email address, so the address doesn't sit
// in browser history. The #fragment is never sent to any server, and the page POSTs it only when
// the person presses the button: mail scanners that open every link in an email (Outlook,
// antivirus) would otherwise confirm or unsubscribe people by themselves.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export const CONFIRM_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// A different prefix for each purpose: a signed unsubscribe link can never be replayed as a
// confirmation, or the other way round.
const sign = (what, secret) => createHmac('sha256', secret).update(`newsletter-${what}`).digest('base64url');

const same = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);   // timing-safe, as in orderLink.js
};

export function confirmToken(id, { now = Date.now(), secret = config.SESSION_SECRET } = {}) {
  const exp = Math.floor((now + CONFIRM_DAYS * DAY_MS) / 1000);
  return `${id}.${exp}.${sign(`confirm:${id}:${exp}`, secret)}`;
}

export function unsubscribeToken(id, { secret = config.SESSION_SECRET } = {}) {
  return `${id}.${sign(`unsubscribe:${id}`, secret)}`;
}

/** The subscriber id from a valid, unexpired confirm token; otherwise null. */
export function readConfirmToken(token, { now = Date.now(), secret = config.SESSION_SECRET } = {}) {
  const m = new RegExp(`^(${UUID})\\.(\\d{10})\\.([A-Za-z0-9_-]{43})$`).exec(String(token ?? ''));
  if (!m || !secret || Number(m[2]) * 1000 < now) return null;
  return same(sign(`confirm:${m[1]}:${m[2]}`, secret), m[3]) ? m[1] : null;
}

/** The subscriber id from a valid unsubscribe token; otherwise null. */
export function readUnsubscribeToken(token, { secret = config.SESSION_SECRET } = {}) {
  const m = new RegExp(`^(${UUID})\\.([A-Za-z0-9_-]{43})$`).exec(String(token ?? ''));
  if (!m || !secret) return null;
  return same(sign(`unsubscribe:${m[1]}`, secret), m[2]) ? m[1] : null;
}

export const confirmUrl = (id) => `${config.SITE_URL}/newsletter.html#confirm.${confirmToken(id)}`;
export const unsubscribeUrl = (id) => `${config.SITE_URL}/newsletter.html#unsub.${unsubscribeToken(id)}`;
