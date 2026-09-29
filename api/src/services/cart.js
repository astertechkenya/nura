// services/cart.js: whose cart is this, what's in it, and merging a guest's cart on sign-in.
//
// A cart belongs to exactly one owner (the database enforces it, see carts_one_owner):
//   - a signed-in user: found through the session (req.session.userId), or
//   - a guest: found through the `nura.guest` cookie, a random 256-bit token.
//
// The guest token works like a password for that cart, so it gets the same care as the
// password-reset tokens: httpOnly (page scripts can't read it), and only its SHA-256 hash is
// stored. A copy of the carts table therefore can't be used to open anyone's cart.
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { brands, carts, cartItems, productVariants, products } from '../db/schema.js';
import { config } from '../config.js';
import { shippingFor } from './pricing.js';

export const GUEST_COOKIE = 'nura.guest';
export const MAX_QTY = 10;                       // per line: a shop, not a wholesaler
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;          // 32 bytes in base64url; anything else is ignored

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.isProd,
  sameSite: 'lax',
  path: '/',
});

/** Reads one cookie. express-session parses only its own cookie, and one value doesn't
 *  justify another dependency. Malformed input simply counts as "no cookie". */
export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
  }
  return null;
}

function guestToken(req) {
  const t = readCookie(req, GUEST_COOKIE);
  return t && TOKEN_RE.test(t) ? t : null;
}

/**
 * The id of the cart this request is allowed to touch, or null if it has none yet.
 * With { create: true } a missing cart is created (and a guest gets their cookie).
 * Reads never create anything: browsing the shop leaves no rows and sets no cookies.
 */
export async function cartIdFor(req, res, { create = false } = {}) {
  const userId = req.session?.userId;
  if (userId) {
    const [mine] = await db.select({ id: carts.id }).from(carts).where(eq(carts.userId, userId));
    if (mine || !create) return mine?.id ?? null;
    // onConflictDoNothing: two first-adds at the same moment must not create two carts.
    await db.insert(carts).values({ userId }).onConflictDoNothing();
    const [made] = await db.select({ id: carts.id }).from(carts).where(eq(carts.userId, userId));
    return made.id;
  }

  const token = guestToken(req);
  if (token) {
    const [found] = await db.select({ id: carts.id }).from(carts).where(eq(carts.guestToken, sha256(token)));
    if (found) return found.id;
  }
  if (!create) return null;

  // A new guest (or one whose cart was merged or cleaned up): fresh token, fresh cart.
  const fresh = randomBytes(32).toString('base64url');
  const [made] = await db.insert(carts).values({ guestToken: sha256(fresh) }).returning({ id: carts.id });
  res.cookie(GUEST_COOKIE, fresh, { ...cookieOptions(), maxAge: THIRTY_DAYS_MS });
  return made.id;
}

/** Marks the cart as used, so a future clean-up job can remove guest carts idle for months. */
export const touch = (cartId, tx = db) =>
  tx.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cartId));

/**
 * The cart as the storefront sees it. Every price comes from the products table right now;
 * nothing the browser sent is ever used for money. Lines that can't be bought are kept (so
 * the shopper sees what happened) but left out of the subtotal.
 */
export async function loadCart(cartId) {
  const rows = cartId ? await db
    .select({
      id: cartItems.id, qty: cartItems.qty,
      variantId: productVariants.id, size: productVariants.size, stock: productVariants.stock,
      sku: products.sku, slug: products.slug, name: products.name, isActive: products.isActive,
      priceKes: products.priceKes, compareAtKes: products.compareAtKes,
      imageUrl: products.imageUrl, cardBg: products.cardBg, brand: brands.name,
    })
    .from(cartItems)
    .innerJoin(productVariants, eq(cartItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(brands, eq(products.brandId, brands.id))
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(products.name), asc(productVariants.size))   // stable: lines don't jump around
    : [];

  const items = rows.map((r) => {
    const problem = !r.isActive ? 'No longer available.'
      : r.stock === 0 ? 'Sold out in this size.'
      : r.qty > r.stock ? `Only ${r.stock} left in this size.`
      : null;
    const buyable = r.isActive && r.stock > 0;
    return {
      id: r.id,
      qty: r.qty,
      variant: { id: r.variantId, size: r.size, stock: r.stock },
      product: {
        sku: r.sku, slug: r.slug, name: r.name, brand: r.brand,
        priceKes: r.priceKes, compareAtKes: r.compareAtKes, imageUrl: r.imageUrl, cardBg: r.cardBg,
      },
      lineTotalKes: buyable ? r.priceKes * r.qty : 0,
      problem,
    };
  });

  const subtotalKes = items.reduce((s, i) => s + i.lineTotalKes, 0);
  const shippingKes = shippingFor(subtotalKes);
  return {
    items,
    count: items.reduce((s, i) => s + i.qty, 0),       // the badge number
    subtotalKes,
    shipping: {
      feeKes: shippingKes,
      thresholdKes: config.FREE_SHIPPING_THRESHOLD_KES,
      awayKes: Math.max(0, config.FREE_SHIPPING_THRESHOLD_KES - subtotalKes), // "KSh 800 away from free shipping"
    },
    totalKes: subtotalKes + shippingKes,
  };
}

/**
 * Called right after sign-in. Moves this browser's guest cart into the account's cart:
 * quantities are added together, then capped at stock and MAX_QTY, and the guest cart is
 * deleted. Everything happens in one transaction, so a failure leaves both carts as they were.
 */
export async function mergeGuestCart(req, res, userId) {
  const token = guestToken(req);
  if (!token) return;
  res.clearCookie(GUEST_COOKIE, cookieOptions());   // either way, this browser is no longer a guest

  await db.transaction(async (tx) => {
    const [guest] = await tx.select({ id: carts.id }).from(carts).where(eq(carts.guestToken, sha256(token)));
    if (!guest) return;
    const [{ n }] = (await tx.execute(sql`select count(*)::int as n from cart_items where cart_id = ${guest.id}`)).rows;
    if (n > 0) {
      await tx.insert(carts).values({ userId }).onConflictDoNothing();
      const [mine] = await tx.select({ id: carts.id }).from(carts).where(eq(carts.userId, userId));
      // Add each guest line to the account's line for the same size (or create it)...
      await tx.execute(sql`
        insert into cart_items (cart_id, variant_id, qty)
        select ${mine.id}, g.variant_id, g.qty from cart_items g where g.cart_id = ${guest.id}
        on conflict (cart_id, variant_id) do update set qty = cart_items.qty + excluded.qty`);
      // ...then cap those lines at what's in stock and at MAX_QTY. A sold-out size keeps qty 1
      // so the shopper sees "Sold out in this size" instead of the item silently vanishing.
      await tx.execute(sql`
        update cart_items ci set qty = least(ci.qty, ${MAX_QTY}, greatest(v.stock, 1))
        from product_variants v
        where v.id = ci.variant_id and ci.cart_id = ${mine.id}
          and ci.variant_id in (select variant_id from cart_items where cart_id = ${guest.id})`);
      await touch(mine.id, tx);
    }
    await tx.delete(carts).where(eq(carts.id, guest.id));   // its lines go with it (cascade)
  });
}

/** One line of this cart (with its variant's stock), or null if the id isn't in this cart. */
export async function findLine(cartId, lineId) {
  const [line] = await db
    .select({ id: cartItems.id, qty: cartItems.qty, stock: productVariants.stock, size: productVariants.size })
    .from(cartItems)
    .innerJoin(productVariants, eq(cartItems.variantId, productVariants.id))
    .where(and(eq(cartItems.id, lineId), eq(cartItems.cartId, cartId)));
  return line ?? null;
}
