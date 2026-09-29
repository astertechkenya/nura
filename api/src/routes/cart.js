// routes/cart.js: the shopping cart, for guests and signed-in shoppers alike.
//
//   GET    /api/cart                  the cart with live prices, totals and shipping
//   POST   /api/cart/items            { variantId, qty }  add a size (adds to an existing line)
//   PATCH  /api/cart/items/:id        { qty }             set a line's quantity
//   DELETE /api/cart/items/:id                            remove a line
//   DELETE /api/cart                                      empty the cart
//
// Every write answers with the whole cart, so the drawer re-renders from one source of truth.
// No request body ever carries a price: the strict schemas reject a "price" field outright.
import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cartItems, productVariants, products } from '../db/schema.js';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { httpError } from '../middleware/errors.js';
import { MAX_QTY, cartIdFor, findLine, loadCart, touch } from '../services/cart.js';

export const cartRouter = Router();

// The cart is personal: never let a browser or CDN cache it or show it to someone else.
cartRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Generous for a person clicking + and −, tight for a script creating thousands of guest carts.
const writeLimit = limit({ windowMs: 60 * 1000, max: 60, message: 'Too many cart changes. Wait a moment and try again.' });

const qty = z.coerce.number().int().min(1, 'qty must be at least 1').max(MAX_QTY, `You can add at most ${MAX_QTY} of one item.`);
const addBody = z.strictObject({ variantId: z.uuid('variantId must be a valid id'), qty: qty.default(1) });
const setBody = z.strictObject({ qty });
const lineParams = z.strictObject({ id: z.uuid('Unknown cart line') });

// Writes pass the cart id they worked on. Looking it up again from the request would miss a
// cart created a moment ago: its guest cookie is in this response, not in the request.
async function sendCart(res, cartId, status = 200) {
  res.status(status).json({ cart: await loadCart(cartId) });
}

cartRouter.get('/', async (req, res) => sendCart(res, await cartIdFor(req, res)));

cartRouter.post('/items', writeLimit, validate(addBody), async (req, res) => {
  const { variantId, qty: adding } = req.valid.body;
  const [variant] = await db
    .select({ id: productVariants.id, size: productVariants.size, stock: productVariants.stock })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(eq(productVariants.id, variantId), eq(products.isActive, true)));
  if (!variant) throw httpError(404, 'That item is no longer available.');

  const cartId = await cartIdFor(req, res, { create: true });
  const [existing] = await db.select({ qty: cartItems.qty }).from(cartItems)
    .where(and(eq(cartItems.cartId, cartId), eq(cartItems.variantId, variantId)));
  const already = existing?.qty ?? 0;
  const wanted = already + adding;

  if (variant.stock === 0) throw httpError(409, 'Sorry, that size just sold out.');
  if (wanted > variant.stock) {
    throw httpError(409, `Only ${variant.stock} left in size ${variant.size}` +
      (already ? `, and ${already} ${already === 1 ? 'is' : 'are'} already in your cart.` : '.'));
  }
  if (wanted > MAX_QTY) throw httpError(409, `You can add at most ${MAX_QTY} of one item.`);

  await db.insert(cartItems).values({ cartId, variantId, qty: wanted })
    .onConflictDoUpdate({ target: [cartItems.cartId, cartItems.variantId], set: { qty: wanted } });
  await touch(cartId);
  await sendCart(res, cartId, existing ? 200 : 201);
});

cartRouter.patch('/items/:id', writeLimit, validate(lineParams, 'params'), validate(setBody), async (req, res) => {
  const cartId = await cartIdFor(req, res);
  // Looking the line up *inside this cart* is what stops one shopper editing another's cart.
  const line = cartId && await findLine(cartId, req.valid.params.id);
  if (!line) throw httpError(404, 'That item is no longer in your cart.');
  const want = req.valid.body.qty;
  if (want > line.stock) {
    throw httpError(409, line.stock === 0 ? 'Sorry, that size just sold out.' : `Only ${line.stock} left in size ${line.size}.`);
  }
  await db.update(cartItems).set({ qty: want }).where(eq(cartItems.id, line.id));
  await touch(cartId);
  await sendCart(res, cartId);
});

cartRouter.delete('/items/:id', writeLimit, validate(lineParams, 'params'), async (req, res) => {
  const cartId = await cartIdFor(req, res);
  // Removing something that's already gone is not an error (a double click, or two tabs).
  if (cartId) {
    await db.delete(cartItems).where(and(eq(cartItems.id, req.valid.params.id), eq(cartItems.cartId, cartId)));
    await touch(cartId);
  }
  await sendCart(res, cartId);
});

cartRouter.delete('/', writeLimit, async (req, res) => {
  const cartId = await cartIdFor(req, res);
  if (cartId) await db.delete(cartItems).where(eq(cartItems.cartId, cartId));
  await sendCart(res, cartId);
});
