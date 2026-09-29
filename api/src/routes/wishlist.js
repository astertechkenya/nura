// routes/wishlist.js: saved items, for signed-in shoppers only.
//
//   GET    /api/wishlist                    newest first, as full product objects
//   POST   /api/wishlist   { skus: [...] }  save one or many (many = moving a guest's list in)
//   DELETE /api/wishlist/:sku               unsave one
//   DELETE /api/wishlist                    clear
//
// Guests keep their wishlist in the browser (it's only a list of product codes, nothing
// private). On sign-in the browser sends it here once, then forgets its copy.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { products, wishlistItems } from '../db/schema.js';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { requireAuth } from './auth.js';
import { toPublicProduct } from './products.js';

export const wishlistRouter = Router();
wishlistRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
wishlistRouter.use(requireAuth);

const MAX_ITEMS = 200;
const sku = z.string().regex(/^[a-z0-9-]{1,40}$/, 'must be a product code');
const writeLimit = limit({ windowMs: 60 * 1000, max: 60, message: 'Too many changes. Wait a moment and try again.' });

async function sendList(req, res) {
  const saved = await db.select({ productId: wishlistItems.productId }).from(wishlistItems)
    .where(eq(wishlistItems.userId, req.user.id)).orderBy(desc(wishlistItems.createdAt));
  const ids = saved.map((s) => s.productId);
  const rows = ids.length ? await db.query.products.findMany({
    where: and(inArray(products.id, ids), eq(products.isActive, true)),   // hidden products drop out
    with: { brand: true, variants: true },
  }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = ids.filter((id) => byId.has(id)).map((id) => toPublicProduct(byId.get(id)));
  res.json({ items, count: items.length });
}

wishlistRouter.get('/', sendList);

wishlistRouter.post('/', writeLimit, validate(z.strictObject({ skus: z.array(sku).min(1).max(50) })), async (req, res) => {
  const found = await db.select({ id: products.id }).from(products)
    .where(and(inArray(products.sku, req.valid.body.skus), eq(products.isActive, true)));
  if (found.length) {
    // Unknown codes are skipped rather than failing the batch: a guest's old list may name
    // a product that has since been removed, and the rest should still be saved.
    await db.insert(wishlistItems).values(found.map((p) => ({ userId: req.user.id, productId: p.id })))
      .onConflictDoNothing();
    // Keep the newest MAX_ITEMS. Stops one account growing the table without limit.
    const extra = await db.select({ productId: wishlistItems.productId }).from(wishlistItems)
      .where(eq(wishlistItems.userId, req.user.id)).orderBy(desc(wishlistItems.createdAt)).offset(MAX_ITEMS);
    if (extra.length) {
      await db.delete(wishlistItems).where(and(eq(wishlistItems.userId, req.user.id),
        inArray(wishlistItems.productId, extra.map((e) => e.productId))));
    }
  }
  await sendList(req, res);
});

wishlistRouter.delete('/:sku', writeLimit, validate(z.strictObject({ sku }), 'params'), async (req, res) => {
  const [p] = await db.select({ id: products.id }).from(products).where(eq(products.sku, req.valid.params.sku));
  if (p) await db.delete(wishlistItems).where(and(eq(wishlistItems.userId, req.user.id), eq(wishlistItems.productId, p.id)));
  await sendList(req, res);
});

wishlistRouter.delete('/', writeLimit, async (req, res) => {
  await db.delete(wishlistItems).where(eq(wishlistItems.userId, req.user.id));
  await sendList(req, res);
});
