// services/admin.js: what the admin screens read and the changes they make.
//
// Two rules hold for every change here:
//   1. It happens inside a transaction together with its audit entry (audited()). A change
//      without a record of who made it cannot exist.
//   2. Orders only move the way services/orderStates.js allows. An admin can't "set" a status,
//      only ask for a move that is allowed from where the order is now.
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { queueOrderEmail } from './emails.js';
import {
  adminActions, brands, orderEmails, orderEvents, orderItems, orders, payments, productVariants, products, users,
} from '../db/schema.js';
import { slugify } from '../lib/slug.js';
import { verifiedImageUrl } from './cloudinary.js';
import { httpError } from '../middleware/errors.js';
import { ADMIN_NEXT, assertTransition, sideEffects } from './orderStates.js';

/* ── Audit ──────────────────────────────────────────────────────────────────────── */

/** Records one admin change. Call it with the SAME transaction (tx) as the change itself. */
export function audited(tx, admin, action, entity, entityId, before, after) {
  return tx.insert(adminActions).values({ adminId: admin.id, action, entity, entityId: String(entityId), before, after });
}

/* ── Masking for the demo admin ─────────────────────────────────────────────────── */

export const maskEmail = (e) => (e ? e.replace(/^(.)[^@]*(@.*)$/, '$1•••$2') : e);
export const maskPhone = (p) => (p ? `${p.slice(0, 4)}••••${p.slice(-2)}` : p);
export const maskName = (n) => (n ? n.split(/\s+/).map((w, i) => (i === 0 ? w : `${w[0]}.`)).join(' ') : n);

/* ── What an admin may do next with an order ────────────────────────────────────── */

/**
 * The buttons for this order. Cash on delivery can't simply be marked "delivered": that goes
 * through "Cash collected", which also records the money as received.
 */
export function actionsFor(o) {
  const next = [...(ADMIN_NEXT[o.status] ?? [])].filter((to) => !(to === 'DELIVERED' && o.paymentMethod === 'COD'));
  const list = next.map((to) => ({ action: 'transition', to }));
  if (o.status === 'SHIPPED' && o.paymentMethod === 'COD') list.push({ action: 'cod-collected', to: 'DELIVERED' });
  return list;
}

/* ── Reads ─────────────────────────────────────────────────────────────────────── */

export async function summary() {
  const byStatus = Object.fromEntries((await db.execute(sql`
    select status, count(*)::int as n from orders group by status`)).rows.map((r) => [r.status, r.n]));
  const [{ refunds }] = (await db.execute(sql`select count(*)::int as refunds from orders where refund_status = 'DUE'`)).rows;
  const [{ flagged }] = (await db.execute(sql`select count(*)::int as flagged from payments where status = 'FLAGGED'`)).rows;
  const lowStock = (await db.execute(sql`
    select p.id, p.name, v.size, v.stock from product_variants v join products p on p.id = v.product_id
    where p.is_active and v.stock <= 3 order by v.stock, p.name limit 20`)).rows;
  // Takings: orders whose money is in (paid by M-Pesa/card, or COD delivered), last 7 days.
  const [{ week }] = (await db.execute(sql`
    select coalesce(sum(total_kes), 0)::int as week from orders
    where status in ('PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED')
      and (payment_method <> 'COD' or status = 'DELIVERED')
      and created_at > now() - interval '7 days'`)).rows;
  return {
    toDo: (byStatus.AWAITING_COD ?? 0) + (byStatus.PAID ?? 0) + (byStatus.PROCESSING ?? 0),
    byStatus, refundsDue: refunds, flaggedPayments: flagged, lowStock, takingsLast7DaysKes: week,
  };
}

const TODO = ['AWAITING_COD', 'PAID', 'PROCESSING'];

export async function listOrders({ status, q, limit = 50, offset = 0 }, masked) {
  const where = [];
  if (status === 'TODO') where.push(inArray(orders.status, TODO));
  else if (status === 'REFUND_DUE') where.push(eq(orders.refundStatus, 'DUE'));
  else if (status) where.push(eq(orders.status, status));
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(orders.number, like), ilike(orders.customerName, like), ilike(orders.phone, like), ilike(orders.email, like)));
  }
  const rows = await db.select({
    id: orders.id, number: orders.number, status: orders.status, paymentMethod: orders.paymentMethod,
    customerName: orders.customerName, phone: orders.phone, county: orders.addressCity, area: orders.addressArea,
    totalKes: orders.totalKes, refundStatus: orders.refundStatus, placedAt: orders.createdAt,
    itemCount: sql`(select coalesce(sum(oi.qty), 0)::int from order_items oi where oi.order_id = "orders"."id")`,
  }).from(orders).where(where.length ? and(...where) : undefined)
    .orderBy(desc(orders.createdAt)).limit(limit).offset(offset);
  return rows.map((r) => (masked ? { ...r, customerName: maskName(r.customerName), phone: maskPhone(r.phone) } : r));
}

export async function orderDetail(id, masked) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o) return null;
  const items = await db.select({
    sku: orderItems.sku, name: orderItems.name, size: orderItems.size, qty: orderItems.qty,
    unitPriceKes: orderItems.unitPriceKes, imageUrl: products.imageUrl, cardBg: products.cardBg,
  }).from(orderItems).leftJoin(products, eq(orderItems.productId, products.id))
    .where(eq(orderItems.orderId, id)).orderBy(orderItems.name);
  const pays = await db.select({
    provider: payments.provider, status: payments.status, amountKes: payments.amountKes, receipt: payments.receipt,
    resultCode: payments.resultCode, failureReason: payments.failureReason, phone: payments.phone, createdAt: payments.createdAt,
  }).from(payments).where(eq(payments.orderId, id)).orderBy(payments.createdAt);
  const events = await db.select({
    from: orderEvents.fromStatus, to: orderEvents.toStatus, note: orderEvents.note, at: orderEvents.createdAt, by: users.name,
  }).from(orderEvents).leftJoin(users, eq(orderEvents.actorId, users.id))
    .where(eq(orderEvents.orderId, id)).orderBy(orderEvents.createdAt);
  // Which emails the customer got: "did they get the shipped email?" answered without guessing.
  const emails = await db.select({ kind: orderEmails.kind, status: orderEmails.status, at: orderEmails.createdAt })
    .from(orderEmails).where(eq(orderEmails.orderId, id)).orderBy(orderEmails.createdAt);
  const m = (v, f) => (masked ? f(v) : v);
  return {
    id: o.id, number: o.number, status: o.status, paymentMethod: o.paymentMethod, refundStatus: o.refundStatus,
    placedAt: o.createdAt, payBy: o.expiresAt, account: Boolean(o.userId),
    customer: { name: m(o.customerName, maskName), email: m(o.email, maskEmail), phone: m(o.phone, maskPhone) },
    delivery: {
      addressLine1: masked ? '•••' : o.addressLine1, area: o.addressArea, county: o.addressCity,
      notes: masked ? (o.deliveryNotes ? '•••' : null) : o.deliveryNotes,
    },
    items: items.map((i) => ({ ...i, lineTotalKes: i.unitPriceKes * i.qty })),
    subtotalKes: o.subtotalKes, shippingKes: o.shippingKes, totalKes: o.totalKes,
    payments: pays.map((p) => ({ ...p, phone: m(p.phone, maskPhone) })),
    events,
    emails,
    actions: actionsFor(o),
  };
}

/* ── Order changes ─────────────────────────────────────────────────────────────── */

/** Moves an order one allowed step, with its side effects, event and audit entry, atomically. */
export async function transitionOrder(admin, orderId, to, note) {
  const result = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!o) throw httpError(404, 'Order not found.');
    if (to === 'DELIVERED' && o.paymentMethod === 'COD') {
      throw httpError(409, 'For cash on delivery, use “Cash collected”: it records the money too.');
    }
    assertTransition(o.status, to, 'admin');

    const [paid] = await tx.select({ id: payments.id }).from(payments)
      .where(and(eq(payments.orderId, o.id), eq(payments.status, 'PAID')));
    const effects = sideEffects(to, { wasPaid: Boolean(paid) });
    const now = new Date();
    if (effects.releaseStock) {
      // The goods never left: put every reserved unit back on the shelf.
      await tx.execute(sql`
        update product_variants v set stock = v.stock + i.qty
        from order_items i where i.order_id = ${o.id} and i.variant_id = v.id`);
      // A COD order's cash will never come; a payment that never reached a provider never will.
      await tx.update(payments).set({ status: 'FAILED', failureReason: 'Order cancelled', updatedAt: now })
        .where(and(eq(payments.orderId, o.id), eq(payments.status, 'PENDING'),
                   or(eq(payments.provider, 'COD'), sql`${payments.providerRef} is null`)));
    }
    const patch = { status: to, updatedAt: now, ...(effects.refundDue ? { refundStatus: 'DUE' } : {}),
                    ...(to === 'CANCELLED' ? { expiresAt: null } : {}) };
    await tx.update(orders).set(patch).where(eq(orders.id, o.id));
    await tx.insert(orderEvents).values({ orderId: o.id, fromStatus: o.status, toStatus: to, actorId: admin.id,
      note: note || (effects.refundDue ? 'Cancelled after payment: refund due' : null) });
    await audited(tx, admin, 'order.transition', 'order', o.id,
      { status: o.status, refundStatus: o.refundStatus }, { status: to, refundStatus: patch.refundStatus ?? o.refundStatus });
  });
  // After the commit: a rolled-back change must never email anyone.
  const email = { SHIPPED: 'shipped', DELIVERED: 'delivered', CANCELLED: 'cancelled' }[to];
  if (email) queueOrderEmail(orderId, email);
  return result;
}

/** COD: the rider handed over the cash. The order is delivered AND the payment is in, together. */
export async function codCollected(admin, orderId, note) {
  await db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!o) throw httpError(404, 'Order not found.');
    if (o.paymentMethod !== 'COD') throw httpError(409, 'This order isn’t cash on delivery.');
    assertTransition(o.status, 'DELIVERED', 'admin');
    const now = new Date();
    const done = await tx.update(payments).set({ status: 'PAID', receipt: 'Cash', updatedAt: now })
      .where(and(eq(payments.orderId, o.id), eq(payments.provider, 'COD'), eq(payments.status, 'PENDING')))
      .returning({ id: payments.id });
    if (!done.length) throw httpError(409, 'There is no open cash payment on this order.');
    await tx.update(orders).set({ status: 'DELIVERED', updatedAt: now }).where(eq(orders.id, o.id));
    await tx.insert(orderEvents).values({ orderId: o.id, fromStatus: o.status, toStatus: 'DELIVERED', actorId: admin.id,
      note: note || `Cash collected: KSh ${o.totalKes.toLocaleString('en-KE')}` });
    await audited(tx, admin, 'order.cod-collected', 'order', o.id, { status: o.status, payment: 'PENDING' }, { status: 'DELIVERED', payment: 'PAID' });
  });
  queueOrderEmail(orderId, 'delivered');                      // after the commit, as always
}

/** A refund was paid back to the customer (by hand, in M-Pesa or Paystack): close it. */
export async function markRefunded(admin, orderId, note) {
  await db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!o) throw httpError(404, 'Order not found.');
    if (o.refundStatus !== 'DUE') throw httpError(409, 'No refund is due on this order.');
    await tx.update(orders).set({ refundStatus: 'DONE', updatedAt: new Date() }).where(eq(orders.id, o.id));
    await tx.insert(orderEvents).values({ orderId: o.id, fromStatus: o.status, toStatus: o.status, actorId: admin.id, note: note || 'Refund paid' });
    await audited(tx, admin, 'order.refunded', 'order', o.id, { refundStatus: 'DUE' }, { refundStatus: 'DONE' });
  });
  queueOrderEmail(orderId, 'refunded');
}

/* ── Products ──────────────────────────────────────────────────────────────────── */

// Every size the shop sells, in the order a shopper expects.
export const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11', 'ONE SIZE'];
// Where a photo is cropped on its card: the three choices offered in the admin.
export const FOCUS = { top: '50% 15%', centre: '50% 50%', bottom: '50% 85%' };

export async function listProducts() {
  const rows = await db.query.products.findMany({ with: { brand: true, variants: true }, orderBy: (p, { asc }) => [asc(p.sku)] });
  const order = SIZES;
  return rows.map((p) => ({
    id: p.id, sku: p.sku, name: p.name, brand: p.brand.name, department: p.department, style: p.style,
    priceKes: p.priceKes, compareAtKes: p.compareAtKes, isActive: p.isActive, imageUrl: p.imageUrl, cardBg: p.cardBg,
    imageFocus: p.imageFocus, description: p.description, slug: p.slug,
    variants: [...p.variants].sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size))
      .map((v) => ({ id: v.id, size: v.size, stock: v.stock })),
  }));
}

const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k]]));

export async function updateProduct(admin, id, changes) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(products).where(eq(products.id, id)).for('update');
    if (!before) throw httpError(404, 'Product not found.');
    const next = { ...pick(before, ['priceKes', 'compareAtKes', 'isActive']), ...changes };
    if (next.compareAtKes !== null && next.compareAtKes <= next.priceKes) {
      throw httpError(400, 'The “was” price must be higher than the price, or empty for no sale.');
    }
    await tx.update(products).set({ ...changes, updatedAt: new Date() }).where(eq(products.id, id));
    await audited(tx, admin, 'product.update', 'product', id,
      pick(before, Object.keys(changes)), changes);
  });
}

export async function listBrands() {
  return db.select({ name: brands.name }).from(brands).orderBy(brands.name);
}

/**
 * A new product, live on the shop at once (it arrives "now", so it's in New In too).
 * The photo is checked with Cloudinary BEFORE the transaction: a network call must never hold
 * database locks open.
 */
export async function createProduct(admin, input) {
  if (input.compareAtKes != null && input.compareAtKes <= input.priceKes) {
    throw httpError(400, 'The “was” price must be higher than the price, or empty for no sale.');
  }
  const imageUrl = await verifiedImageUrl(input.image.publicId);

  return db.transaction(async (tx) => {
    // Brand: an existing one (any capitalisation), or a new one.
    let [brand] = await tx.select().from(brands).where(sql`lower(${brands.name}) = ${input.brand.toLowerCase()}`);
    if (!brand) {
      [brand] = await tx.insert(brands).values({ name: input.brand, slug: slugify(input.brand) })
        .onConflictDoNothing().returning();
      if (!brand) throw httpError(409, 'A brand with a very similar name already exists. Pick it from the list.');
    }
    // The next code after the highest nura-NNN. Serialised by a transaction-level lock, so two
    // admins creating products at the same moment can't both get nura-022.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('nura:new-product'))`);
    const [{ n }] = (await tx.execute(sql`
      select coalesce(max(substring(sku from '^nura-([0-9]+)$')::int), 0) + 1 as n from products`)).rows;
    const sku = `nura-${String(n).padStart(3, '0')}`;
    // Address: the name as a slug; -2, -3… if another product already has it.
    const base = slugify(input.name) || sku;
    const taken = new Set((await tx.select({ slug: products.slug }).from(products)
      .where(sql`${products.slug} = ${base} or ${products.slug} like ${base + '-%'}`)).map((r) => r.slug));
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;

    const [p] = await tx.insert(products).values({
      sku, slug, name: input.name, brandId: brand.id, department: input.department, style: input.style ?? null,
      description: input.description || null, priceKes: input.priceKes, compareAtKes: input.compareAtKes ?? null,
      imageUrl, imageFocus: FOCUS[input.imageFocus ?? 'centre'], arrivedAt: new Date(),
    }).returning();
    await tx.insert(productVariants).values(input.sizes.map((s) => ({ productId: p.id, size: s.size, stock: s.stock })));
    await audited(tx, admin, 'product.create', 'product', p.id, null, {
      sku, name: p.name, brand: brand.name, priceKes: p.priceKes, sizes: input.sizes,
    });
    return { id: p.id, sku, slug };
  });
}

/** A new photo (and/or crop) for an existing product. */
export async function setProductImage(admin, id, { publicId, imageFocus }) {
  const imageUrl = publicId ? await verifiedImageUrl(publicId) : undefined;
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(products).where(eq(products.id, id)).for('update');
    if (!before) throw httpError(404, 'Product not found.');
    const changes = { ...(imageUrl ? { imageUrl } : {}), ...(imageFocus ? { imageFocus: FOCUS[imageFocus] } : {}) };
    await tx.update(products).set({ ...changes, updatedAt: new Date() }).where(eq(products.id, id));
    await audited(tx, admin, 'product.image', 'product', id, pick(before, Object.keys(changes)), changes);
  });
}

export async function setStock(admin, variantId, stock) {
  return db.transaction(async (tx) => {
    const [v] = await tx.select({ id: productVariants.id, stock: productVariants.stock, size: productVariants.size, sku: products.sku })
      .from(productVariants).innerJoin(products, eq(productVariants.productId, products.id))
      .where(eq(productVariants.id, variantId)).for('update');
    if (!v) throw httpError(404, 'Size not found.');
    await tx.update(productVariants).set({ stock }).where(eq(productVariants.id, variantId));
    await audited(tx, admin, 'stock.set', 'variant', variantId, { sku: v.sku, size: v.size, stock: v.stock }, { stock });
  });
}

/* ── Customers and the newsletter ──────────────────────────────────────────────── */

// Orders that count as placed (an unpaid M-Pesa/card attempt that expired doesn't), and money
// actually in: the same rule as the dashboard's takings (COD counts once the cash is collected).
const PLACED = sql`o.status not in ('PENDING_PAYMENT', 'EXPIRED')`;
const MONEY_IN = sql`o.status in ('PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED') and (o.payment_method <> 'COD' or o.status = 'DELIVERED')`;

/** Shopper accounts (guests have no account, so they're only in Orders), newest first. */
export async function listCustomers({ q, limit = 50, offset = 0 }, masked) {
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  // The demo admin searches by name only: searching by email would let it test whether an
  // address has an account, which the masking is there to prevent.
  const match = !like ? sql`true` : masked ? sql`u.name ilike ${like}` : sql`(u.name ilike ${like} or u.email ilike ${like})`;
  const where = sql`u.role = 'CUSTOMER' and ${match}`;
  const rows = (await db.execute(sql`
    select u.id, u.name, u.email, u.created_at as "memberSince",
      (select count(*)::int from orders o where o.user_id = u.id and ${PLACED}) as "orderCount",
      (select coalesce(sum(o.total_kes), 0)::int from orders o where o.user_id = u.id and ${MONEY_IN}) as "spentKes",
      (select max(o.created_at) from orders o where o.user_id = u.id and ${PLACED}) as "lastOrderAt",
      coalesce(ns.status, 'none') as newsletter
    from users u left join newsletter_subscribers ns on ns.email = lower(u.email)
    where ${where} order by u.created_at desc limit ${limit} offset ${offset}`)).rows;
  const [{ total }] = (await db.execute(sql`select count(*)::int as total from users u where ${where}`)).rows;
  const counts = Object.fromEntries((await db.execute(sql`
    select status, count(*)::int as n from newsletter_subscribers group by status`)).rows.map((r) => [r.status, r.n]));
  return {
    total,
    newsletter: { confirmed: counts.confirmed ?? 0, pending: counts.pending ?? 0, unsubscribed: counts.unsubscribed ?? 0 },
    customers: rows.map((r) => (masked ? { ...r, name: maskName(r.name), email: maskEmail(r.email) } : r)),
  };
}

// CSV injection: a spreadsheet treats a cell starting with = + - @ (or tab/CR) as a formula, so a
// crafted value could run one when the file is opened in Excel. Such cells get a leading
// apostrophe, which spreadsheets show as plain text. Quotes are doubled, as CSV requires.
export const csvCell = (v) => {
  const s = v instanceof Date ? v.toISOString() : String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** Confirmed subscribers only, as CSV. Exporting personal data is audited like any change. */
export async function newsletterCsv(admin) {
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      select email, confirmed_at from newsletter_subscribers where status = 'confirmed' order by confirmed_at`)).rows;
    await audited(tx, admin, 'newsletter.export', 'newsletter', 'confirmed', null, { rows: rows.length });
    // \r\n line ends and a BOM: what Excel expects, so it opens cleanly on Windows.
    return '﻿' + [['email', 'confirmed_at'], ...rows.map((r) => [r.email, new Date(r.confirmed_at)])]
      .map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  });
}

/* ── Activity ──────────────────────────────────────────────────────────────────── */

export async function activity(limit = 100) {
  return db.select({
    id: adminActions.id, action: adminActions.action, entity: adminActions.entity, entityId: adminActions.entityId,
    before: adminActions.before, after: adminActions.after, at: adminActions.createdAt, by: users.name,
  }).from(adminActions).innerJoin(users, eq(adminActions.adminId, users.id))
    .orderBy(desc(adminActions.createdAt)).limit(limit);
}
