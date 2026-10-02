// routes/admin.js: the admin API. Every route sits behind adminGate (see middleware/adminGate.js).
//
//   GET   /api/admin/me                         who am I, and do I still need my 6-digit code?
//   POST  /api/admin/totp        { code }       enter the code from the authenticator app
//   GET   /api/admin/summary                    counts for the dashboard
//   GET   /api/admin/orders?status=&q=&page=    the order list (status TODO = everything to act on)
//   GET   /api/admin/orders/:id                 one order, its payments, history and next actions
//   POST  /api/admin/orders/:id/transition      { to, note? }  move it one allowed step
//   POST  /api/admin/orders/:id/cod-collected   { note? }      COD: cash in hand → DELIVERED + PAID
//   POST  /api/admin/orders/:id/refunded        { note? }      a due refund has been paid back
//   GET   /api/admin/products                   every product, hidden ones too, with stock per size
//   PATCH /api/admin/products/:id               { priceKes?, compareAtKes?, isActive? }
//   PATCH /api/admin/variants/:id               { stock }
//   GET   /api/admin/brands                     brand names, for the new-product form
//   POST  /api/admin/uploads/sign               a signed Cloudinary upload (see services/cloudinary.js)
//   POST  /api/admin/products                   a new product (photo already uploaded: { image: { publicId } })
//   PUT   /api/admin/products/:id/image         { publicId?, imageFocus? }  a new photo and/or crop
//   GET   /api/admin/customers?q=&page=          shopper accounts, with orders, spend and newsletter status
//   GET   /api/admin/newsletter.csv             confirmed subscribers as CSV (not for the demo admin)
//   GET   /api/admin/activity                   the audit log: who changed what, before and after
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { httpError } from '../middleware/errors.js';
import { adminGate, needsTotp } from '../middleware/adminGate.js';
import { verifyCode } from '../lib/totp.js';
import { ORDER_STATUSES } from '../services/orderStates.js';
import {
  activity, codCollected, createProduct, FOCUS, listBrands, listCustomers, listOrders, newsletterCsv, listProducts, markRefunded, orderDetail,
  setProductImage, setStock, SIZES, summary, transitionOrder, updateProduct,
} from '../services/admin.js';
import { signUpload } from '../services/cloudinary.js';

export const adminRouter = Router();
adminRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
adminRouter.use(adminGate);

adminRouter.get('/me', (req, res) => {
  res.json({ name: req.admin.name, role: req.admin.role, masked: req.masked, needsTotp: needsTotp(req.admin, req.session) });
});

adminRouter.post(
  '/totp',
  // 5 WRONG codes per 15 minutes per ACCOUNT, from wherever they come. Per connection+account (as it
  // was) let someone who has the password sign in once and spread guesses over many IP addresses.
  limit({ windowMs: 15 * 60 * 1000, max: 5, by: (req) => req.session?.userId, ipToo: false, failuresOnly: true, message: 'Too many codes tried. Wait 15 minutes.' }),
  validate(z.strictObject({ code: z.string().regex(/^\d{6}$/, 'The code is 6 digits.') })),
  async (req, res) => {
    if (!req.admin.totpSecret || !verifyCode(req.admin.totpSecret, req.valid.body.code)) {
      throw httpError(401, 'That code isn’t right. Codes change every 30 seconds; try the current one.');
    }
    req.session.totpVerifiedAt = Date.now();
    res.json({ ok: true });
  },
);

adminRouter.get('/summary', async (req, res) => res.json(await summary()));

const listQuery = z.strictObject({
  status: z.enum([...ORDER_STATUSES, 'TODO', 'REFUND_DUE']).optional(),
  q: z.string().trim().min(1).max(60).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
adminRouter.get('/orders', validate(listQuery, 'query'), async (req, res) => {
  const { status, q, page } = req.valid.query;
  res.json({ orders: await listOrders({ status, q, limit: 50, offset: (page - 1) * 50 }, req.masked) });
});

const idParams = z.strictObject({ id: z.uuid() });
adminRouter.get('/orders/:id', validate(idParams, 'params'), async (req, res) => {
  const o = await orderDetail(req.valid.params.id, req.masked);
  if (!o) throw httpError(404, 'Order not found.');
  res.json({ order: o });
});

const note = z.string().trim().max(300).optional();
adminRouter.post('/orders/:id/transition', validate(idParams, 'params'),
  validate(z.strictObject({ to: z.enum(ORDER_STATUSES), note })), async (req, res) => {
    await transitionOrder(req.admin, req.valid.params.id, req.valid.body.to, req.valid.body.note);
    res.json({ order: await orderDetail(req.valid.params.id, false) });
  });

adminRouter.post('/orders/:id/cod-collected', validate(idParams, 'params'), validate(z.strictObject({ note })), async (req, res) => {
  await codCollected(req.admin, req.valid.params.id, req.valid.body.note);
  res.json({ order: await orderDetail(req.valid.params.id, false) });
});

adminRouter.post('/orders/:id/refunded', validate(idParams, 'params'), validate(z.strictObject({ note })), async (req, res) => {
  await markRefunded(req.admin, req.valid.params.id, req.valid.body.note);
  res.json({ order: await orderDetail(req.valid.params.id, false) });
});

adminRouter.get('/products', async (req, res) => res.json({ products: await listProducts() }));

const kes = z.number().int().positive().max(10_000_000);
const productPatch = z.strictObject({
  priceKes: kes.optional(),
  compareAtKes: kes.nullable().optional(),                  // null removes the sale
  isActive: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, 'Nothing to change.');
adminRouter.patch('/products/:id', validate(idParams, 'params'), validate(productPatch), async (req, res) => {
  await updateProduct(req.admin, req.valid.params.id, req.valid.body);
  res.json({ products: await listProducts() });
});

adminRouter.patch('/variants/:id', validate(idParams, 'params'),
  validate(z.strictObject({ stock: z.number().int().min(0).max(9999) })), async (req, res) => {
    await setStock(req.admin, req.valid.params.id, req.valid.body.stock);
    res.json({ ok: true });
  });

adminRouter.get('/brands', async (req, res) => res.json({ brands: (await listBrands()).map((b) => b.name) }));

// Signing is a write in disguise (it lets the browser upload to our account), so like every
// non-GET route it's refused for the demo admin by adminGate. 30 an hour is plenty for one shop.
adminRouter.post('/uploads/sign', limit({ windowMs: 60 * 60 * 1000, max: 30, by: (req) => req.session?.userId, ipToo: false,
  message: 'Too many uploads this hour.' }), (req, res) => res.json(signUpload()));

const text = (min, max, what) => z.string().trim().min(min, `Please enter ${what}.`).max(max, `${what[0].toUpperCase()}${what.slice(1)} is too long.`);
const photo = z.strictObject({ publicId: z.string().max(140) });
const focus = z.enum(Object.keys(FOCUS));
const newProduct = z.strictObject({
  name: text(2, 80, 'a product name'),
  brand: text(1, 40, 'a brand'),
  department: z.enum(['WOMEN', 'MEN', 'UNISEX']),
  style: z.enum(['Casual', 'Formal', 'Streetwear', 'Evening']).nullable().optional(),
  description: z.string().trim().max(1000).optional(),
  priceKes: kes,
  compareAtKes: kes.nullable().optional(),
  sizes: z.array(z.strictObject({ size: z.enum(SIZES), stock: z.number().int().min(0).max(9999) }))
    .min(1, 'Add at least one size.').max(SIZES.length)
    .refine((list) => new Set(list.map((s) => s.size)).size === list.length, 'Each size only once.'),
  image: photo,
  imageFocus: focus.optional(),
});
adminRouter.post('/products', validate(newProduct), async (req, res) => {
  const created = await createProduct(req.admin, req.valid.body);
  res.status(201).json({ product: created, products: await listProducts() });
});

adminRouter.put('/products/:id/image', validate(idParams, 'params'),
  validate(z.strictObject({ publicId: z.string().max(140).optional(), imageFocus: focus.optional() })
    .refine((b) => b.publicId || b.imageFocus, 'Nothing to change.')),
  async (req, res) => {
    await setProductImage(req.admin, req.valid.params.id, req.valid.body);
    res.json({ products: await listProducts() });
  });

const customerQuery = z.strictObject({
  q: z.string().trim().min(1).max(60).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
adminRouter.get('/customers', validate(customerQuery, 'query'), async (req, res) => {
  const { q, page } = req.valid.query;
  res.json({ ...(await listCustomers({ q, limit: 50, offset: (page - 1) * 50 }, req.masked)), page });
});

adminRouter.get('/newsletter.csv', async (req, res) => {
  // A GET, which the demo admin may otherwise use: but this is a list of real email addresses.
  if (req.masked) throw httpError(403, 'The demo admin can’t download the subscriber list.');
  const csv = await newsletterCsv(req.admin);
  const day = new Date().toISOString().slice(0, 10);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="nura-newsletter-${day}.csv"` });
  res.send(csv);
});

adminRouter.get('/activity', async (req, res) => res.json({ activity: await activity() }));
