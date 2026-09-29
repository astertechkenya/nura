// mail.js: the one place that sends email.
//
// Real sending arrives in Phase 7 (Resend). Until then:
//   development  prints the message in the API's terminal, so you can click the link
//   test         keeps messages in `outbox`, so tests can read them
//   production   logs that an email WOULD have been sent (without the link: it's a secret)
import { config } from '../config.js';
import { logger } from '../logger.js';

export const outbox = [];

export async function sendMail({ to, subject, text }) {
  if (config.isTest) {
    outbox.push({ to, subject, text });
    return;
  }
  if (!config.isProd) {
    // console.log on purpose: it shows even when LOG_LEVEL hides info lines.
    console.log(`\n──── email (not sent: development) ────\nTo: ${to}\nSubject: ${subject}\n\n${text}\n───────────────────────────────────────\n`);
    return;
  }
  logger.warn({ subject }, 'email not sent: no email provider configured yet (Phase 7)');
}
