// emails.js: what NURA's emails say, and when order emails go out.
//
// Each email has a plain-text part (read by some clients, and by spam filters that distrust
// HTML-only mail) and a simple HTML part. The HTML uses inline styles and one centred column
// because email clients ignore stylesheets and most modern CSS.
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orderEmails } from '../db/schema.js';
import { config } from '../config.js';
import { loadOrder, paidOn } from './orders.js';
import { orderUrl } from '../lib/orderLink.js';
import { inBackground, sendMail } from './mail.js';

// Everything that goes into HTML passes through here: a product or customer name is data,
// never markup. (A name like <img onerror=…> must arrive as text.)
// One escaping function for every HTML the API writes (pages and emails): lib/html.js.
import { esc } from '../lib/html.js';
export { esc };
export const ksh = (n) => `KSh ${Number(n).toLocaleString('en-KE')}`;
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'there';
const localPhone = (p) => { const m = /^254(\d{3})(\d{3})(\d{3})$/.exec(String(p)); return m ? `0${m[1]} ${m[2]} ${m[3]}` : p; };

const PURPLE = '#7038c9';
export function layout({ heading, intro, body = '', button }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f2;">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:Helvetica,Arial,sans-serif;color:#111;">
  <p style="margin:0 0 28px;font-size:22px;letter-spacing:6px;">NUR<span style="color:${PURPLE};">A</span></p>
  <div style="background:#fff;padding:28px 24px;">
    <h1 style="margin:0 0 14px;font-size:22px;font-weight:600;">${heading}</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;">${intro}</p>
    ${body}
    ${button ? `<p style="margin:24px 0 0;"><a href="${esc(button.href)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 26px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${esc(button.label)}</a></p>` : ''}
  </div>
  <p style="margin:20px 0 0;font-size:12px;color:#666;line-height:1.6;">NURA · Nairobi, Kenya · <a href="${esc(config.SITE_URL)}" style="color:#666;">${esc(config.SITE_URL.replace(/^https?:\/\//, ''))}</a></p>
</div></body></html>`;
}

/* ── Order emails ───────────────────────────────────────────────────────────── */

function itemsHtml(o) {
  const rows = o.items.map((i) => `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;">${esc(i.name)}<br><span style="color:#666;font-size:12px;">${esc(i.size)} · Qty ${Number(i.qty)}</span></td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:right;white-space:nowrap;">${ksh(i.lineTotalKes)}</td></tr>`).join('');
  const line = (label, value, bold) => `<tr><td style="padding:6px 0;font-size:14px;${bold ? 'font-weight:700;' : 'color:#444;'}">${label}</td><td style="padding:6px 0;font-size:14px;text-align:right;${bold ? 'font-weight:700;' : ''}">${value}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}
    ${line('Subtotal', ksh(o.subtotalKes))}${line('Delivery', o.shippingKes ? ksh(o.shippingKes) : 'Free')}${line('Total', ksh(o.totalKes), true)}</table>
    <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#444;"><strong style="color:#111;">Delivering to</strong><br>
    ${esc(o.contact.name)}<br>${esc(o.delivery.addressLine1)}<br>${esc(o.delivery.area)}, ${esc(o.delivery.county)}</p>`;
}
const itemsText = (o) => `${o.items.map((i) => `- ${i.name} (${i.size}) x${i.qty}  ${ksh(i.lineTotalKes)}`).join('\n')}
Subtotal ${ksh(o.subtotalKes)} · Delivery ${o.shippingKes ? ksh(o.shippingKes) : 'Free'} · Total ${ksh(o.totalKes)}

Delivering to: ${o.contact.name}, ${o.delivery.addressLine1}, ${o.delivery.area}, ${o.delivery.county}`;

// Where a refund goes, in the customer's words. M-Pesa refunds go back to the paying number.
// The refund's amount in words. kes is null when a rejected payment wasn't in shillings.
const refundAmount = (o) => (o.paid?.kes != null ? ksh(o.paid.kes) : 'your payment');
const refundTo = (o) => (o.paid?.provider === 'DARAJA'
  ? `to the M-Pesa number you paid from${o.paid.phone ? ` (ending ${String(o.paid.phone).slice(-3)})` : ''}`
  : 'to the card you paid with');

const ORDER_EMAILS = {
  // Cash on delivery: sent when the order is placed.
  received: (o) => ({
    subject: `Order ${o.number} received`,
    heading: `Thanks, ${esc(firstName(o.contact.name))}. We have your order.`,
    intro: `We’ll call you on <strong>${esc(localPhone(o.contact.phone))}</strong> to confirm delivery. Pay <strong>${ksh(o.totalKes)}</strong> in cash when it arrives.`,
    introText: `We'll call you on ${localPhone(o.contact.phone)} to confirm delivery. Pay ${ksh(o.totalKes)} in cash when it arrives.`,
  }),
  // M-Pesa and card: sent when the payment is confirmed (never before: an unpaid order may expire).
  // The amount is what arrived: normally the total; a different amount the admin accepted otherwise.
  confirmed: (o) => ({
    subject: `Order ${o.number} confirmed`,
    heading: `Payment received. Thank you, ${esc(firstName(o.contact.name))}.`,
    intro: `We’ve received <strong>${ksh(o.payment?.receivedKes ?? o.totalKes)}</strong>${o.payment?.receipt ? ` (${esc(o.payment.receipt)})` : ''}. We’ll email you again when your order is on its way.`,
    introText: `We've received ${ksh(o.payment?.receivedKes ?? o.totalKes)}${o.payment?.receipt ? ` (${o.payment.receipt})` : ''}. We'll email you again when your order is on its way.`,
  }),
  shipped: (o) => {
    const cash = o.paymentMethod === 'COD' ? ` Please have <strong>${ksh(o.totalKes)}</strong> ready in cash.` : '';
    return {
      subject: `Order ${o.number} is on its way`,
      heading: 'Your order is on its way',
      intro: `It’s with our rider now, headed to ${esc(o.delivery.area)}.${cash}`,
      introText: `It's with our rider now, headed to ${o.delivery.area}.${o.paymentMethod === 'COD' ? ` Please have ${ksh(o.totalKes)} ready in cash.` : ''}`,
    };
  },
  delivered: (o) => {
    const cash = o.paymentMethod === 'COD' ? ` We’ve received your cash payment of <strong>${ksh(o.totalKes)}</strong>.` : '';
    return {
      subject: `Order ${o.number} delivered`,
      heading: `Delivered. Enjoy, ${esc(firstName(o.contact.name))}.`,
      intro: `Your order has been delivered.${cash} Thank you for shopping with NURA.`,
      introText: `Your order has been delivered.${o.paymentMethod === 'COD' ? ` We've received your cash payment of ${ksh(o.totalKes)}.` : ''} Thank you for shopping with NURA.`,
    };
  },
  // Cancelled by the shop. If money was taken, say how much comes back and where; never
  // promise a refund that isn't owed, never deny one that is.
  cancelled: (o) => {
    const refund = o.paid
      ? [`You paid <strong>${refundAmount(o)}</strong>. We’ll refund it ${esc(refundTo(o))} and email you when it’s sent.`,
         `You paid ${refundAmount(o)}. We'll refund it ${refundTo(o)} and email you when it's sent.`]
      : ['No payment was taken for it.', 'No payment was taken for it.'];
    return {
      subject: `Order ${o.number} cancelled`,
      heading: 'Your order has been cancelled',
      intro: `We’ve cancelled order ${esc(o.number)}. ${refund[0]}`,
      introText: `We've cancelled order ${o.number}. ${refund[1]}`,
    };
  },
  // Unpaid M-Pesa/card order closed by the payment window. Careful wording: a payment can still
  // land at the last second, in which case the refund_due email follows.
  expired: (o) => ({
    subject: `Order ${o.number} wasn’t completed`,
    heading: 'Your order wasn’t completed',
    intro: `We didn’t receive payment in time, so we released the items back to the shop. If money did leave your account, it will be refunded in full and we’ll email you.`,
    introText: `We didn't receive payment in time, so we released the items back to the shop. If money did leave your account, it will be refunded in full and we'll email you.`,
  }),
  // A payment that arrived after the order closed (expired or cancelled).
  refund_due: (o) => ({
    subject: `About your payment for order ${o.number}`,
    heading: 'Your payment arrived after the order closed',
    intro: `We received <strong>${refundAmount(o)}</strong>, but by then the order had closed and the items were no longer held for you. We’ll refund it in full ${esc(refundTo(o))} and email you when it’s sent.`,
    introText: `We received ${refundAmount(o)}, but by then the order had closed and the items were no longer held for you. We'll refund it in full ${refundTo(o)} and email you when it's sent.`,
  }),
  // The admin turned down a payment for the wrong amount (services/admin.js resolveFlagged).
  payment_rejected: (o) => {
    const open = o.status === 'PENDING_PAYMENT';
    const next = open ? ' Your order is still open: you can pay the correct amount of ' : '';
    return {
      subject: `About your payment for order ${o.number}`,
      heading: 'We couldn’t accept that payment',
      intro: `We received <strong>${refundAmount(o)}</strong> for this order, but its total is <strong>${ksh(o.totalKes)}</strong>, so we couldn’t accept it as payment. We’ll refund it in full ${esc(refundTo(o))} and email you when it’s sent.${open ? `${next}<strong>${ksh(o.totalKes)}</strong> from your order page.` : ''}`,
      introText: `We received ${refundAmount(o)} for this order, but its total is ${ksh(o.totalKes)}, so we couldn't accept it as payment. We'll refund it in full ${refundTo(o)} and email you when it's sent.${open ? `${next}${ksh(o.totalKes)} from your order page.` : ''}`,
    };
  },
  refunded: (o) => {
    const card = o.paid?.provider === 'PAYSTACK' ? ' Card refunds can take a few working days to appear.' : '';
    return {
      subject: `Refund sent for order ${o.number}`,
      heading: 'Your refund is on its way',
      intro: `We’ve refunded <strong>${refundAmount(o)}</strong> ${esc(refundTo(o))}.${card}`,
      introText: `We've refunded ${refundAmount(o)} ${refundTo(o)}.${card}`,
    };
  },
};

export function orderMessage(kind, o) {
  const t = ORDER_EMAILS[kind](o);
  const link = orderUrl(o);
  return {
    to: o.contact.email,
    subject: t.subject,
    text: `${t.introText}\n\nOrder ${o.number}\n${itemsText(o)}\n\nView your order: ${link}\n`,
    html: layout({ heading: t.heading, intro: t.intro, body: itemsHtml(o), button: { href: link, label: 'View your order' } }),
  };
}

/**
 * Sends one order email, at most once per order and kind, in the background. Call it AFTER
 * the transaction that caused it has committed (never inside: a rolled-back order must not
 * get an email). Returns at once.
 */
export function queueOrderEmail(orderId, kind) {
  return inBackground(`order email ${kind}`, async () => {
    // Claim first: the primary key (order_id, kind) lets exactly one caller through.
    const claimed = await db.insert(orderEmails).values({ orderId, kind }).onConflictDoNothing().returning();
    if (!claimed.length) return 'duplicate';
    const mark = (status) => db.update(orderEmails).set({ status })
      .where(and(eq(orderEmails.orderId, orderId), eq(orderEmails.kind, kind)));
    try {
      const o = { ...(await loadOrder(orderId)), paid: await paidOn(orderId) };
      const status = await sendMail(orderMessage(kind, o));
      await mark(status);
      return status;
    } catch (err) {
      // Claimed but not sent (a database hiccup while building it): say so, so the admin's
      // "Emails to the customer" shows failed rather than queued forever. inBackground logs it.
      await mark('failed').catch(() => {});
      throw err;
    }
  });
}

/* ── Account emails ─────────────────────────────────────────────────────────── */

export function welcomeMessage(user) {
  const shop = config.SITE_URL;
  return {
    to: user.email,
    subject: 'Welcome to NURA',
    text: `Hi ${firstName(user.name)},\n\nYour NURA account is ready. Your orders, cart and wishlist now follow you to any device you sign in on.\n\nShop the latest: ${shop}/new-in.html\n\nIf you didn't create this account, reset the password here: ${shop}/index.html#forgot\n`,
    html: layout({
      heading: `Welcome, ${esc(firstName(user.name))}`,
      intro: 'Your NURA account is ready. Your orders, cart and wishlist now follow you to any device you sign in on.',
      button: { href: `${shop}/new-in.html`, label: 'See what’s new' },
    }),
  };
}

export function resetMessage(user, link) {
  return {
    to: user.email,
    subject: 'Reset your NURA password',
    text: `Hi ${firstName(user.name)},\n\nUse this link to choose a new password. It works for 30 minutes and only once:\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.`,
    html: layout({
      heading: 'Reset your password',
      intro: `Hi ${esc(firstName(user.name))}, use the button below to choose a new password. It works for 30 minutes and only once.<br><br>If you didn’t ask for this, ignore this email; your password stays the same.`,
      button: { href: link, label: 'Choose a new password' },
    }),
  };
}

// Security notices: sent so that a change the owner didn't make doesn't go unnoticed.
export function passwordChangedMessage(user) {
  const reset = `${config.SITE_URL}/index.html#forgot`;
  return {
    to: user.email,
    subject: 'Your NURA password was changed',
    text: `Hi ${firstName(user.name)},\n\nThe password for your NURA account was just changed, and any other devices were signed out.\n\nIf this wasn't you, reset your password now: ${reset}\n`,
    html: layout({
      heading: 'Your password was changed',
      intro: `Hi ${esc(firstName(user.name))}, the password for your NURA account was just changed, and any other devices were signed out.<br><br>If this wasn’t you, reset it now.`,
      button: { href: reset, label: 'Reset my password' },
    }),
  };
}

export function accountDeletedMessage(user) {
  return {
    to: user.email,
    subject: 'Your NURA account has been deleted',
    text: `Hi ${firstName(user.name)},\n\nYour NURA account has been deleted, along with your saved cart, wishlist and newsletter subscription. Records of past orders are kept for our accounts and are no longer linked to an account.\n\nYou're welcome back any time: ${config.SITE_URL}\n`,
    html: layout({
      heading: 'Your account has been deleted',
      intro: `Hi ${esc(firstName(user.name))}, your NURA account has been deleted, along with your saved cart, wishlist and newsletter subscription. Records of past orders are kept for our accounts and are no longer linked to an account.`,
    }),
  };
}

/* ── Newsletter ──────────────────────────────────────────────────────────────── */

// Double opt-in: nothing is ever sent to this address again unless this link is used.
export function newsletterConfirmMessage(email, link) {
  return {
    to: email,
    subject: 'Confirm your NURA newsletter subscription',
    text: `Hi,\n\nSomeone (hopefully you) asked to get NURA's newsletter at this address: new drops and offers, no spam.\n\nConfirm here (the link works for 7 days):\n${link}\n\nIf it wasn't you, ignore this email. You won't hear from us again.\n`,
    html: layout({
      heading: 'One click to confirm',
      intro: 'Someone (hopefully you) asked to get NURA’s newsletter at this address: new drops and offers, no spam. The button works for 7 days.<br><br>If it wasn’t you, ignore this email. You won’t hear from us again.',
      button: { href: link, label: 'Yes, subscribe me' },
    }),
  };
}
