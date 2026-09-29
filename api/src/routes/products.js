// routes/products.js: the catalogue, read-only and public.
//
//   GET /api/products                 every active product
//   GET /api/products?department=MEN  one department (WOMEN | MEN | UNISEX)
//   GET /api/products?sale=true       products with a "was" price
//   GET /api/products?new=true        arrived within NEW_IN_DAYS
//   GET /api/products?brand=nike      one brand, by slug
//   GET /api/products?q=blazer        name or brand contains the words
//   GET /api/products?limit=4         at most N (the homepage rows)
//   GET /api/products/:slug           one product, 404 if missing or hidden
//
// Filters combine: ?department=WOMEN&sale=true is women's sale items.
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, gte, ilike, inArray, isNotNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { brands, products } from '../db/schema.js';
import { config } from '../config.js';
import { validate } from '../middleware/validate.js';
import { httpError } from '../middleware/errors.js';

export const productsRouter = Router();

// Sizes in the order a shopper expects, not alphabetical (which would put L before M).
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11', 'ONE SIZE'];
const sizeRank = (s) => (SIZE_ORDER.indexOf(s) + 1) || SIZE_ORDER.length + 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Turns a database row into the public shape. Only fields named here are ever sent. */
export function toPublicProduct(p, now = new Date()) {
  const newSince = now.getTime() - config.NEW_IN_DAYS * DAY_MS;
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

// "true" is the only accepted value for flags; ?sale=false or ?sale=yes is a mistake worth reporting.
const flag = z.literal('true').transform(() => true);

const listQuery = z.strictObject({                       // strict: unknown parameters are a 400
  department: z.enum(['WOMEN', 'MEN', 'UNISEX']).optional(),
  sale: flag.optional(),
  new: flag.optional(),
  brand: z.string().regex(/^[a-z0-9-]{1,60}$/, 'must be a brand slug').optional(),
  q: z.string().trim().min(2, 'must be at least 2 characters').max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// In a LIKE pattern, % and _ are wildcards. A shopper searching "50%" means the characters,
// so escape them before wrapping the words in %...%.
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// Each shopper's browser may reuse a catalogue response for 30 seconds, so moving between
// pages doesn't wait on Render. Shared caches may NOT keep it:
//   - `private` is the standard way to say "only the end user's browser may store this".
//   - Netlify-CDN-Cache-Control is read only by Netlify's CDN (and stripped before the browser
//     sees it). Belt and braces: an earlier `public, stale-while-revalidate` let Netlify serve
//     a copy 18 minutes out of date to every visitor after a quiet spell.
// So a price change shows within 30 seconds, and at once on a hard refresh. Checkout re-prices
// on the server regardless, so a stale card can never change what anyone pays.
function cacheBriefly(res) {
  res.set('Cache-Control', 'private, max-age=30');
  res.set('Netlify-CDN-Cache-Control', 'no-store');
}

productsRouter.get('/', validate(listQuery, 'query'), async (req, res) => {
  const f = req.valid.query;
  const conditions = [eq(products.isActive, true)];

  if (f.department) conditions.push(eq(products.department, f.department));
  if (f.sale) conditions.push(isNotNull(products.compareAtKes));
  if (f.new) conditions.push(gte(products.arrivedAt, new Date(Date.now() - config.NEW_IN_DAYS * DAY_MS)));
  if (f.brand) {
    conditions.push(inArray(products.brandId, db.select({ id: brands.id }).from(brands).where(eq(brands.slug, f.brand))));
  }
  if (f.q) {
    const pattern = `%${likeEscape(f.q)}%`;
    conditions.push(or(
      ilike(products.name, pattern),
      inArray(products.brandId, db.select({ id: brands.id }).from(brands).where(ilike(brands.name, pattern))),
    ));
  }

  const rows = await db.query.products.findMany({
    where: and(...conditions),
    with: { brand: true, variants: true },
    // Newest first when browsing New In; otherwise the stable catalogue order.
    orderBy: (p, { asc, desc }) => (f.new ? [desc(p.arrivedAt)] : [asc(p.sku)]),
    limit: f.limit,
  });

  cacheBriefly(res);
  res.json({ count: rows.length, products: rows.map((r) => toPublicProduct(r)) });
});

const slugParams = z.strictObject({ slug: z.string().regex(/^[a-z0-9-]{1,100}$/) });

productsRouter.get('/:slug', validate(slugParams, 'params'), async (req, res) => {
  const row = await db.query.products.findFirst({
    where: and(eq(products.slug, req.valid.params.slug), eq(products.isActive, true)),
    with: { brand: true, variants: true },
  });
  if (!row) throw httpError(404, 'Product not found');
  cacheBriefly(res);
  res.json({ product: toPublicProduct(row) });
});
