// services/paystack.js: the only file that talks to Paystack (cards and Apple Pay).
//
//   initialize({ email, amountKes, reference, callbackUrl, metadata }) → { authorizationUrl }
//   verify(reference) → { state: 'paid' | 'failed' | 'open', amountKes, currency, ... }
//   signatureValid(rawBody, header) → does this webhook really come from Paystack?
//
// The shopper types their card on Paystack's page, never on NURA, so card numbers never
// reach this server. That keeps NURA out of the heaviest card-security rules (PCI DSS).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const BASE = config.PAYSTACK_BASE_URL ?? 'https://api.paystack.co';
const TIMEOUT_MS = 15_000;
// What the shopper may use on Paystack's page. M-Pesa has its own button at checkout.
export const CHANNELS = ['card', 'apple_pay'];

export class PaystackError extends Error {
  constructor(message, { status, body } = {}) { super(message); this.status = status; this.body = body; }
}

async function call(method, path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== true) throw new PaystackError(body.message || 'Paystack request failed', { status: res.status, body });
  return body.data;
}

/** Opens a payment. Paystack counts KES in cents: KSh 2,400 is sent as 240000. */
export async function initialize({ email, amountKes, reference, callbackUrl, metadata }) {
  const data = await call('POST', '/transaction/initialize', {
    email, amount: amountKes * 100, currency: 'KES', reference, callback_url: callbackUrl,
    channels: CHANNELS, metadata,
  });
  return { authorizationUrl: data.authorization_url, reference: data.reference };
}

/**
 * Asks Paystack what happened.
 *   paid   status "success"
 *   failed status "failed" or "reversed" (declined, or taken back)
 *   open   anything else: "abandoned", "ongoing", "pending"... the page may still be open
 */
export async function verify(reference) {
  const d = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  const state = d.status === 'success' ? 'paid' : ['failed', 'reversed'].includes(d.status) ? 'failed' : 'open';
  return {
    state,
    status: d.status,
    amountKes: typeof d.amount === 'number' ? d.amount / 100 : undefined,
    currency: d.currency,
    channel: d.channel,
    last4: d.authorization?.last4,
    message: d.gateway_response,
    id: d.id,
  };
}

/** Paystack signs every webhook: HMAC-SHA512 of the exact body bytes, with our secret key. */
export function signatureValid(rawBody, header) {
  if (!config.PAYSTACK_SECRET_KEY || !rawBody || typeof header !== 'string') return false;
  const want = Buffer.from(createHmac('sha512', config.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex'));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}
