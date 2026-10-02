// schema.js: every table NURA's database has, written in JavaScript.
//
// `npm run db:generate` compares this file with the last migration and writes the SQL
// needed to get from there to here into api/drizzle/. Read those .sql files: they are
// exactly what runs against Postgres.
//
// House rules, applied throughout:
//   - Money is whole Kenya shillings in integer columns (`*_kes`). Never floats, never
//     "KSh 14,200" strings. Daraja only accepts whole amounts; Paystack wants kes * 100.
//   - Rules the data must always obey live in the database as CHECK constraints, not just
//     in JavaScript. Code has bugs; a constraint catches the bug before bad data is saved.
//   - Public IDs are random UUIDs, so nobody can walk through orders by counting 1, 2, 3.
import { relations, sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, pgSequence, uuid, text, integer, boolean, timestamp, jsonb, varchar,
  primaryKey, uniqueIndex, index, check,
} from 'drizzle-orm/pg-core';

/* ── Enums: closed lists Postgres itself enforces ─────────────────────────────── */

export const roleEnum = pgEnum('role', ['CUSTOMER', 'DEMO_ADMIN', 'ADMIN']);
export const departmentEnum = pgEnum('department', ['WOMEN', 'MEN', 'UNISEX']);

// The 8 order states agreed in the build map (0.1). Payment failure is NOT an order state:
// a failed M-Pesa attempt marks the payment FAILED and the order stays PENDING_PAYMENT,
// so the shopper can retry until the order expires.
export const orderStatusEnum = pgEnum('order_status', [
  'PENDING_PAYMENT', 'AWAITING_COD', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'EXPIRED',
]);
export const paymentMethodEnum = pgEnum('payment_method', ['MPESA', 'CARD', 'COD']);
export const paymentProviderEnum = pgEnum('payment_provider', ['DARAJA', 'PAYSTACK', 'COD']);
// FLAGGED = the provider said "paid" but something did not match (e.g. the amount). A human decides.
export const paymentStatusEnum = pgEnum('payment_status', ['PENDING', 'PAID', 'FAILED', 'FLAGGED']);
export const refundStatusEnum = pgEnum('refund_status', ['NONE', 'DUE', 'DONE']);

// Human-friendly order numbers (NURA-000123) come from a sequence, not from counting rows:
// two checkouts in the same millisecond still get different numbers.
export const orderNumberSeq = pgSequence('order_number_seq', { startWith: 1, increment: 1 });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());

/* ── People and sessions ──────────────────────────────────────────────────────── */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),                  // always stored lower-case (see unique index)
  passwordHash: text('password_hash').notNull(),   // argon2id; the password itself is never stored
  name: text('name').notNull(),
  phone: text('phone'),
  role: roleEnum('role').notNull().default('CUSTOMER'),
  totpSecret: text('totp_secret'),                 // two-factor for ADMIN (Phase 7)
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // Unique on lower(email): "Ethan@x.com" and "ethan@x.com" are the same account.
  uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
]);

// Managed by connect-pg-simple in Phase 2. Declared here so the migration creates it.
export const sessions = pgTable('sessions', {
  sid: varchar('sid').primaryKey(),
  sess: jsonb('sess').notNull(),
  expire: timestamp('expire', { precision: 6 }).notNull(),
}, (t) => [index('sessions_expire_idx').on(t.expire)]);

// Password reset (Phase 2): only a hash of the emailed token is stored, so a database
// leak does not hand out working reset links.
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/* ── Catalogue ────────────────────────────────────────────────────────────────── */

export const brands = pgTable('brands', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull().unique(),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  sku: text('sku').notNull().unique(),             // your existing IDs: nura-001 ...
  slug: text('slug').notNull().unique(),           // linen-oversized-blazer
  name: text('name').notNull(),
  brandId: uuid('brand_id').notNull().references(() => brands.id),
  department: departmentEnum('department').notNull(),
  style: text('style'),                            // Casual | Formal | Streetwear | Evening (subcategory tiles)
  description: text('description'),
  priceKes: integer('price_kes').notNull(),
  compareAtKes: integer('compare_at_kes'),         // set => on sale; the crossed-out "was" price
  imageUrl: text('image_url').notNull(),
  imageFocus: text('image_focus').notNull().default('50% 50%'), // CSS object-position you tuned per card
  cardBg: text('card_bg').notNull().default('#efefed'),          // placeholder colour behind the image
  arrivedAt: timestamp('arrived_at', { withTimezone: true }).notNull().defaultNow(), // drives "New In"
  isActive: boolean('is_active').notNull().default(true),         // hidden products stay for old orders
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('products_price_positive', sql`${t.priceKes} > 0`),
  // A "was" price lower than the price would be a lie on the Sale page.
  check('products_compare_at_above_price', sql`${t.compareAtKes} IS NULL OR ${t.compareAtKes} > ${t.priceKes}`),
  index('products_department_idx').on(t.department),
]);

export const productVariants = pgTable('product_variants', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  size: text('size').notNull(),                    // XS..XL, UK 6..11, or ONE SIZE
  stock: integer('stock').notNull().default(0),
}, (t) => [
  uniqueIndex('variants_product_size_uq').on(t.productId, t.size),
  // The last line of defence against overselling: stock can never go below zero,
  // even if two checkouts race for the last blazer.
  check('variants_stock_non_negative', sql`${t.stock} >= 0`),
]);

/* ── Carts and wishlists (Phase 3) ───────────────────────────────────────────── */

export const carts = pgTable('carts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').unique().references(() => users.id, { onDelete: 'cascade' }),
  guestToken: text('guest_token').unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // A cart belongs to a guest OR a user, never both and never neither.
  check('carts_one_owner', sql`(${t.userId} IS NULL) <> (${t.guestToken} IS NULL)`),
]);

export const cartItems = pgTable('cart_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  cartId: uuid('cart_id').notNull().references(() => carts.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull().references(() => productVariants.id, { onDelete: 'cascade' }),
  qty: integer('qty').notNull(),
}, (t) => [
  uniqueIndex('cart_items_cart_variant_uq').on(t.cartId, t.variantId),
  check('cart_items_qty_positive', sql`${t.qty} > 0`),
]);

export const wishlistItems = pgTable('wishlist_items', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.productId] })]);

/* ── Orders and payments (Phases 4–6): a ledger. Rows are added, statuses move
      forward, history is never rewritten. ─────────────────────────────────────── */

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  number: text('number').notNull().unique(),       // NURA-000123
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }), // null = guest checkout
  email: text('email').notNull(),
  phone: text('phone').notNull(),                  // 2547XXXXXXXX: the format M-Pesa (Daraja) expects
  customerName: text('customer_name').notNull(),   // who the rider asks for at the door
  status: orderStatusEnum('status').notNull(),
  paymentMethod: paymentMethodEnum('payment_method').notNull(),
  subtotalKes: integer('subtotal_kes').notNull(),
  shippingKes: integer('shipping_kes').notNull(),
  totalKes: integer('total_kes').notNull(),
  addressLine1: text('address_line1').notNull(),
  addressArea: text('address_area').notNull(),
  addressCity: text('address_city').notNull(),     // one of Kenya's 47 counties (see lib/kenya.js)
  deliveryNotes: text('delivery_notes'),           // "Blue gate, call on arrival"
  // One random key per checkout attempt, sent by the browser. If "Place order" is sent twice
  // (a double tap, a retry after a timeout) the second request finds this order instead of
  // creating another. UNIQUE, so even two requests at the same instant can't both insert.
  checkoutKey: uuid('checkout_key').unique(),
  refundStatus: refundStatusEnum('refund_status').notNull().default('NONE'),
  stkAttempts: integer('stk_attempts').notNull().default(0), // M-Pesa prompts sent (max 3)
  expiresAt: timestamp('expires_at', { withTimezone: true }), // unpaid orders release stock after this
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('orders_total_adds_up', sql`${t.totalKes} = ${t.subtotalKes} + ${t.shippingKes}`),
  check('orders_amounts_non_negative', sql`${t.subtotalKes} >= 0 AND ${t.shippingKes} >= 0`),
  index('orders_status_idx').on(t.status),
  index('orders_user_idx').on(t.userId),
]);

// Snapshot of what was bought, copied at checkout. Next month's price change must not
// rewrite last month's receipts, so name, size and price are stored here, not looked up.
export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  size: text('size').notNull(),
  unitPriceKes: integer('unit_price_kes').notNull(),
  qty: integer('qty').notNull(),
}, (t) => [check('order_items_qty_positive', sql`${t.qty} > 0`)]);

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  provider: paymentProviderEnum('provider').notNull(),
  // Daraja's CheckoutRequestID or our Paystack reference. UNIQUE, so the same callback
  // arriving twice can never create a second payment.
  providerRef: text('provider_ref').unique(),
  receipt: text('receipt'),                        // M-Pesa receipt number, e.g. QK12ABC3XY
  phone: text('phone'),                            // M-Pesa: the number the prompt went to
  resultCode: text('result_code'),                 // M-Pesa: Safaricom's ResultCode (1032 = cancelled...)
  // What we asked the provider for. Equal to the order total, except in the Daraja sandbox,
  // where a token amount is requested (see DARAJA_SANDBOX_AMOUNT_KES).
  amountKes: integer('amount_kes').notNull(),
  status: paymentStatusEnum('status').notNull().default('PENDING'),
  failureReason: text('failure_reason'),
  raw: jsonb('raw'),                               // provider's payload, kept for disputes
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // At most one PENDING payment per order: no two live M-Pesa prompts for one order.
  uniqueIndex('payments_one_pending_per_order_uq').on(t.orderId).where(sql`${t.status} = 'PENDING'`),
  check('payments_amount_positive', sql`${t.amountKes} > 0`),
]);

// Every status change, by the system or an admin. Powers the "status history" on the
// admin order screen and answers "what happened to this order?" without guessing.
export const orderEvents = pgTable('order_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  fromStatus: orderStatusEnum('from_status'),      // null for the event that created the order
  toStatus: orderStatusEnum('to_status').notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }), // null = system
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [index('order_events_order_idx').on(t.orderId)]);

// Which emails an order has had (Phase 7). The primary key is the whole point: whoever inserts
// the row sends the email, so a double-clicked checkout, a retried job or two payment
// callbacks racing each other can never send the same email twice. It also tells the admin
// "did this customer get the shipped email?".
export const orderEmails = pgTable('order_emails', {
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),   // received | confirmed | shipped | delivered | cancelled | expired | refund_due | refunded
  status: text('status').notNull().default('queued'), // queued | sent | held | failed
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orderId, t.kind] })]);

/* ── Marketing and audit ─────────────────────────────────────────────────────── */

// Double opt-in (Phase 7): a sign-up is 'pending' until the person clicks the link in the
// confirmation email; only 'confirmed' addresses are ever exported or mailed. The dates are the
// record of consent (Kenya's Data Protection Act asks us to be able to show it was given).
export const newsletterSubscribers = pgTable('newsletter_subscribers', {
  email: text('email').primaryKey(),
  // Links in emails carry this id, never the address (see lib/newsletterLink.js).
  id: uuid('id').notNull().defaultRandom().unique(),
  status: text('status').notNull().default('pending'),       // pending | confirmed | unsubscribed
  confirmSentAt: timestamp('confirm_sent_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('newsletter_status_idx').on(t.status),
  check('newsletter_status_valid', sql`${t.status} in ('pending', 'confirmed', 'unsubscribed')`),
]);

// Written in the same transaction as every admin change (Phase 7), so a change without
// an audit entry cannot exist.
export const adminActions = pgTable('admin_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id').notNull().references(() => users.id),
  action: text('action').notNull(),                // e.g. product.update, order.transition
  entity: text('entity').notNull(),                // e.g. product, order
  entityId: text('entity_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  createdAt: createdAt(),
}, (t) => [index('admin_actions_created_idx').on(t.createdAt)]);

/* ── Relations: let queries say `with: { brand: true, variants: true }` ────────── */

export const brandsRelations = relations(brands, ({ many }) => ({ products: many(products) }));
export const productsRelations = relations(products, ({ one, many }) => ({
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
  variants: many(productVariants),
}));
export const variantsRelations = relations(productVariants, ({ one }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
}));
export const ordersRelations = relations(orders, ({ many }) => ({
  items: many(orderItems), payments: many(payments), events: many(orderEvents),
}));
export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));
export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
}));
export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
}));
