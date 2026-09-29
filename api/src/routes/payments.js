// routes/payments.js: where payment providers report back, server to server.
//
//   POST /api/payments/mpesa/callback/:secret   Safaricom's STK result
//   POST /api/payments/paystack/webhook          Paystack's events, signed with our secret key
//
// No session, no cookies, no Origin: this is Safaricom's server, not a browser. The secret in
// the address keeps out anyone who doesn't know it (404, as if the route didn't exist). Even
// with the secret, a posted "paid" changes nothing by itself: services/payments.js asks
// Safaricom directly before marking anything paid.
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { handleCallback } from '../services/payments.js';
import { handlePaystackEvent } from '../services/cardPayments.js';
import { signatureValid } from '../services/paystack.js';

export const paymentsRouter = Router();

function secretMatches(given) {
  const want = Buffer.from(config.MPESA_CALLBACK_SECRET ?? '');
  const got = Buffer.from(String(given));
  // timingSafeEqual: the comparison takes as long for a nearly-right guess as a wrong one.
  return want.length > 0 && want.length === got.length && timingSafeEqual(want, got);
}

paymentsRouter.post('/mpesa/callback/:secret', (req, res) => {
  if (!secretMatches(req.params.secret)) return res.status(404).json({ error: 'Not found' });
  // Answer Safaricom straight away (it retries if we're slow), then do the work.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  handleCallback(req.body).catch((err) => logger.error({ err }, 'M-Pesa callback processing failed; the job will re-check'));
});

paymentsRouter.post('/paystack/webhook', (req, res) => {
  // The signature covers the exact bytes Paystack sent (req.rawBody, kept by app.js), not our
  // parsed copy: re-serialising JSON could change spacing and break the comparison.
  if (!signatureValid(req.rawBody, req.get('x-paystack-signature'))) {
    logger.warn('Paystack webhook with a bad or missing signature: ignored');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  res.sendStatus(200);                                           // answer fast; Paystack retries on slowness
  handlePaystackEvent(req.body).catch((err) => logger.error({ err }, 'Paystack webhook processing failed; the job will re-check'));
});
