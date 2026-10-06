// alerts.js: emails to the shop owner when money needs a human (Phase 8).
//
// Two situations, both raised by markPaid() in payments.js:
//   flagged     the provider says "paid", but not the amount we asked for (or, for cards, not
//               in shillings). The order is NOT marked paid. Real money is sitting there.
//   refund_due  the money arrived after the order had expired or been cancelled. Its stock is
//               already back on sale, so the shopper is owed their money back.
//
// Why email and not just the dashboard: the dashboard only helps when you open it. A flagged
// order expires within its payment window, and the shopper is told it wasn't completed, while
// they know they paid. That's a phone call you want to make first.
//
// The rules, same as the shopper emails:
//   - Sent after the database change commits, never inside it, and never blocking it.
//   - markPaid() settles each payment exactly once (row lock), so each alert goes out once.
//   - If an alert can't be delivered (Resend down, address held), that's logged as an ERROR
//     with an Error object, so Sentry emails you instead. Two channels, so one can fail.
//   - Minimal content: order number, amounts, method, receipt, a link to the admin. No names,
//     phones or addresses: those stay in the admin, behind your sign-in, not in a mailbox.
import { config } from '../config.js';
import { logger } from '../logger.js';
import { inBackground, sendMail } from './mail.js';
import { esc, ksh, layout } from './emails.js';

const adminOrderUrl = (orderId) => `${config.SITE_URL}/admin/#order/${orderId}`;

// "14:05 on 5 Oct" in Nairobi time, whatever timezone the server runs in (Render's is UTC).
const nairobiTime = (d) => {
  const at = (opts) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', ...opts });
  return `${at({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} on ${at({ day: 'numeric', month: 'short' })}`;
};
// Who reported the payment: markPaid's `method` is 'M-Pesa' or 'card'.
const reporter = (method) => (method === 'card' ? 'Paystack' : method);

// cardPayments.js passes -1 when Paystack reports a currency other than KES.
const paidAmount = (got) => (got < 0 ? 'an amount in another currency' : ksh(got));

const ALERTS = {
  flagged: (a) => {
    const what = `${reporter(a.method)} reports a payment of ${paidAmount(a.gotKes)} for order ${a.number}, which expected ${ksh(a.expectedKes)}.`;
    const status = 'The order has NOT been marked paid.'
      + (a.expiresAt ? ` Unless the shopper pays again, it expires at ${nairobiTime(a.expiresAt)} (Nairobi time) and its stock goes back on sale.` : '');
    const todo = 'The money is real: check the receipt in your M-Pesa or Paystack dashboard, then contact the shopper (their details are in the admin) and refund it or settle the difference.';
    return {
      subject: `Check payment: ${a.number} paid ${a.gotKes < 0 ? 'in another currency' : ksh(a.gotKes)}, expected ${ksh(a.expectedKes)}`,
      lines: [what, status, a.receipt ? `Receipt: ${a.receipt}` : null, todo],
      heading: 'A payment needs checking',
    };
  },
  refund_due: (a) => ({
    subject: `Refund due: ${a.number}, ${ksh(a.expectedKes)} by ${a.method}`,
    lines: [
      `A ${a.method} payment of ${ksh(a.expectedKes)} arrived for order ${a.number} after it had ${a.orderStatus === 'CANCELLED' ? 'been cancelled' : 'expired'}. Its stock was already back on sale, so the shopper is owed a refund. They have been emailed that it's coming.`,
      a.receipt ? `Receipt: ${a.receipt}` : null,
      'Send the money back from your M-Pesa or Paystack dashboard, then press "Refund paid" on the order in the admin.',
    ],
    heading: 'A refund is due',
  }),
};

/** The email for one alert. Exported for tests. */
export function alertMessage(kind, a) {
  const t = ALERTS[kind](a);
  const lines = t.lines.filter(Boolean);
  const link = adminOrderUrl(a.orderId);
  return {
    to: config.ALERT_EMAIL,
    subject: `[NURA] ${t.subject}`,
    text: `${lines.join('\n\n')}\n\nOpen the order: ${link}\n`,
    html: layout({
      heading: esc(t.heading),
      intro: lines.map(esc).join('<br><br>'),
      button: { href: link, label: 'Open the order' },
    }),
  };
}

/**
 * Sends one alert in the background. Returns at once (the promise is for tests).
 * `a`: { orderId, number, method, expectedKes, gotKes?, receipt?, expiresAt?, orderStatus? }
 */
export function sendAlert(kind, a) {
  return inBackground(`alert ${kind}`, async () => {
    if (!config.ALERT_EMAIL) {
      logger.warn({ kind, orderId: a.orderId }, 'alert not emailed: ALERT_EMAIL is not set');
      return 'skipped';
    }
    const status = await sendMail(alertMessage(kind, a));
    if (status === 'failed' || status === 'held') {
      // An Error object, at level error: logger.js passes it to Sentry, which emails you.
      logger.error({ err: new Error(`Alert email ${status}: ${kind} on order ${a.number}`), kind, orderId: a.orderId },
        'alert email not delivered: check the admin');
    }
    return status;
  });
}
