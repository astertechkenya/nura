// routes/products.js: the catalogue, read-only and public.
//
// Phase 0: list every active product. Phase 1 adds filters (?department=WOMEN, ?sale=true,
// ?new=true, ?q=) and GET /api/products/:slug.
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { products } from '../db/schema.js';
import { config } from '../config.js';

export const productsRouter = Router();

// Sizes in the order a shopper expects, not alphabetical (which would put L before M).
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11', 'ONE SIZE'];
const sizeRank = (s) => (SIZE_ORDER.indexOf(s) + 1) || SIZE_ORDER.length + 1;

/** Turns a database row into the public shape. Nothing internal leaks by accident:
 *  only fields named here are sent. */
export function toPublicProduct(p, now = new Date()) {
  const newSince = now.getTime() - config.NEW_IN_DAYS * 24 * 60 * 60 * 1000;
  const variants = [...p.variants]
    .sort((a, b) => sizeRank(a.size) - sizeRank(b.size))
    .map((v) => ({ id: v.id, size: v.size, stock: v.stock }));
  return {
    id: p.id,
    sku: p.sku,
    slug: p.slug,
    name: p.name,
    brand: { name: p.brand.name, slug: p.brand.slug },
    department: p.department,
    style: p.style,
    priceKes: p.priceKes,
    compareAtKes: p.compareAtKes,
    onSale: p.compareAtKes !== null,
    isNew: p.arrivedAt.getTime() >= newSince,
    imageUrl: p.imageUrl,
    imageFocus: p.imageFocus,
    cardBg: p.cardBg,
    totalStock: variants.reduce((sum, v) => sum + v.stock, 0),
    variants,
  };
}

productsRouter.get('/', async (req, res) => {
  const rows = await db.query.products.findMany({
    where: eq(products.isActive, true),
    with: { brand: true, variants: true },
    orderBy: (p, { asc }) => [asc(p.sku)],
  });
  res.json({ count: rows.length, products: rows.map((r) => toPublicProduct(r)) });
});
