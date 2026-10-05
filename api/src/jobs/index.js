// jobs/index.js: work the API does on a timer, not in answer to a request.
//
// A plain setInterval instead of a cron library: "every minute" needs nothing more.
//
// The jobs only have work while a payment is open (an unpaid M-Pesa/card order, or a payment
// still PENDING). When there's none, they go quiet: no timer, no database queries. That matters
// on Neon's free plan: the database sleeps after 5 idle minutes, and the monthly allowance
// (100 compute-hours, about 400 hours awake at the smallest size) is less than a month of
// 730 hours. Queried every minute, it would never sleep and run out before the month ends.
// A request that could open a payment (checkout, pay, a provider callback) wakes the jobs
// (wakeJobs, called from app.js); they then run every minute until nothing is open.
import { logger } from '../logger.js';
import { expireOrders } from '../services/orders.js';
import { reconcilePayments } from '../services/payments.js';
import { reconcileCards } from '../services/cardPayments.js';
import { config } from '../config.js';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

const EVERY_MINUTE = 60 * 1000;
let timer = null;
let running = false;
let started = false;
export const jobStats = { ticks: 0, wakes: 0 };   // for tests

/** Is any payment still open? Then the jobs have work to do next minute. */
async function anythingOpen() {
  const { rows: [r] } = await db.execute(sql`select
    exists(select 1 from orders where status = 'PENDING_PAYMENT') or
    exists(select 1 from payments where status = 'PENDING' and provider in ('DARAJA', 'PAYSTACK')) as open`);
  // (A cash-on-delivery payment stays PENDING until the rider collects: nothing to poll for.)
  return r.open;
}

async function tick() {
  if (running) return;          // a slow run is never overlapped by the next one
  running = true;
  jobStats.ticks += 1;
  try {
    // First settle M-Pesa prompts whose result never arrived, THEN expire what's still unpaid:
    // an order must not expire while Safaricom is holding a "paid" for it.
    if (config.mpesaEnabled) {
      const settled = await reconcilePayments();
      if (settled) logger.info({ settled }, 'settled M-Pesa payments by query');
    }
    if (config.cardEnabled) {
      const settled = await reconcileCards();
      if (settled) logger.info({ settled }, 'settled card payments by verify');
    }
    const n = await expireOrders();
    if (n) logger.info({ expired: n }, 'expired unpaid orders and returned their stock');
    if (!(await anythingOpen())) quiet();          // nothing left to watch: stop until woken
  } catch (err) {
    logger.error({ err }, 'order expiry job failed');   // logged, retried next minute
  } finally {
    running = false;
  }
}

function every() {
  if (timer) return;
  timer = setInterval(tick, EVERY_MINUTE);
  timer.unref();                // never keeps the process alive on its own
}
function quiet() { clearInterval(timer); timer = null; }

export function startJobs() {
  if (started) return;
  started = true;
  every();
  tick();                       // catch up on anything left open before a restart
}

/** Something may have opened a payment: run now, then every minute until nothing is open. */
export function wakeJobs() {
  if (!started) return;         // tests and scripts never start the timer
  jobStats.wakes += 1;
  const wasQuiet = !timer;
  every();
  if (wasQuiet) tick();
}

export const jobsAreQuiet = () => !timer;
export const jobsRunning = () => running;
export { tick as runJobsOnce };

export function stopJobs() {
  started = false;
  quiet();
}
