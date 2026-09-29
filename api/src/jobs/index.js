// jobs/index.js: work the API does on a timer, not in answer to a request.
//
// A plain setInterval instead of a cron library: "every minute" needs nothing more. On
// Render's free tier the server sleeps when nobody visits, so jobs pause too; that's fine,
// because the first request after waking runs them straight away.
import { logger } from '../logger.js';
import { expireOrders } from '../services/orders.js';
import { reconcilePayments } from '../services/payments.js';
import { config } from '../config.js';

const EVERY_MINUTE = 60 * 1000;
let timer = null;
let running = false;

async function tick() {
  if (running) return;          // a slow run is never overlapped by the next one
  running = true;
  try {
    // First settle M-Pesa prompts whose result never arrived, THEN expire what's still unpaid:
    // an order must not expire while Safaricom is holding a "paid" for it.
    if (config.mpesaEnabled) {
      const settled = await reconcilePayments();
      if (settled) logger.info({ settled }, 'settled M-Pesa payments by query');
    }
    const n = await expireOrders();
    if (n) logger.info({ expired: n }, 'expired unpaid orders and returned their stock');
  } catch (err) {
    logger.error({ err }, 'order expiry job failed');   // logged, retried next minute
  } finally {
    running = false;
  }
}

export function startJobs() {
  if (timer) return;
  tick();
  timer = setInterval(tick, EVERY_MINUTE);
  timer.unref();                // never keeps the process alive on its own
}

export function stopJobs() {
  clearInterval(timer);
  timer = null;
}
