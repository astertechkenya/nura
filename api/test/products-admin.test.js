// Phase 7: adding products in the admin, with photos on Cloudinary (a fake one here).
// The rules: only a photo that really is in NURA's Cloudinary folder, in an allowed format and
// size, can be attached; the image address is built by the API, never taken from the browser;
// a new product is on the shop (and in New In) immediately; every change is audited.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { sessionStore } from '../src/middleware/session.js';
import { seed } from '../src/db/seed.js';
import { codeAt, newSecret } from '../src/lib/totp.js';
import { createProduct, listProducts } from '../src/services/admin.js';
import { netlifyToken } from './helpers.js';
import { startFakeCloudinary, TEST_CLOUD } from './fakeCloudinary.js';

const app = createApp();
const PW = 'admin password long enough';
let fake, closeFake, SECRET, admin, looker;

let ip = 0;
const as = (agent) => {
  const addr = `10.12.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`;
  const wrap = (m) => (url) => agent[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', addr);
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch') };
};
async function signIn(email, withCode) {
  const b = request.agent(app);
  expect((await as(b).post('/api/auth/login').send({ email, password: PW })).status).toBe(200);
  if (withCode) expect((await as(b).post('/api/admin/totp').send({ code: codeAt(SECRET, Math.floor(Date.now() / 30000)) })).status).toBe(200);
  return b;
}

beforeAll(async () => {
  ({ fake, close: closeFake } = await startFakeCloudinary());
  SECRET = newSecret();
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  await db.insert(users).values([
    { email: 'maker@nura.test', name: 'Maker Admin', role: 'ADMIN', passwordHash: hash, totpSecret: SECRET },
    { email: 'peeker@nura.test', name: 'Demo Peeker', role: 'DEMO_ADMIN', passwordHash: hash },
  ]).onConflictDoNothing();
  admin = await signIn('maker@nura.test', true);
  looker = await signIn('peeker@nura.test', false);
});
afterAll(async () => {
  // Other test files count the catalogue (21 products): remove what this file created.
  await db.execute(sql`delete from products where sku ~ '^nura-0(2[2-9]|[3-9][0-9])$'`);
  await db.execute(sql`delete from brands b where not exists (select 1 from products p where p.brand_id = b.id)`);
  await closeFake(); await seed({ log: () => {} }); sessionStore.close(); await pool.end();
});
beforeEach(() => { fake.resources.clear(); fake.deleted.length = 0; });

const uploaded = (id, r = {}) => { fake.resources.set(`nura/products/${id}`, { format: 'webp', bytes: 180_000, version: 1790000000, ...r }); return { publicId: `nura/products/${id}` }; };
const body = (over = {}) => ({
  name: 'Kitenge Wrap Top', brand: 'KikoRomeo', department: 'WOMEN', style: 'Casual', priceKes: 4500,
  sizes: [{ size: 'S', stock: 3 }, { size: 'M', stock: 5 }], image: uploaded('kitenge1'), imageFocus: 'top', ...over,
});
const count = async () => (await db.execute(sql`select count(*)::int as n from products`)).rows[0].n;

describe('signing an upload', () => {
  it('signs exactly: NURA’s folder, four formats, a timestamp; the secret never leaves', async () => {
    const res = await as(admin).post('/api/admin/uploads/sign');
    expect(res.status).toBe(200);
    const f = res.body.fields;
    expect(res.body.uploadUrl).toBe(`https://api.cloudinary.com/v1_1/${TEST_CLOUD.name}/image/upload`);
    expect(f).toMatchObject({ folder: 'nura/products', allowed_formats: 'jpg,png,webp,avif', api_key: TEST_CLOUD.key });
    const expected = createHash('sha1')
      .update(`allowed_formats=${f.allowed_formats}&folder=${f.folder}&timestamp=${f.timestamp}${TEST_CLOUD.secret}`).digest('hex');
    expect(f.signature).toBe(expected);
    expect(JSON.stringify(res.body)).not.toContain(TEST_CLOUD.secret);
    expect(Math.abs(f.timestamp - Date.now() / 1000)).toBeLessThan(5);
  });

  it('the demo admin can’t sign (it would let them upload into the account)', async () => {
    expect((await as(looker).post('/api/admin/uploads/sign')).status).toBe(403);
  });
});

describe('creating a product', () => {
  it('is on the shop at once, in New In, with the photo address built by the API; audited', async () => {
    const res = await as(admin).post('/api/admin/products').send(body());
    expect(res.status).toBe(201);
    const { sku, slug } = res.body.product;
    expect(sku).toMatch(/^nura-0\d\d$/);
    expect(slug).toBe('kitenge-wrap-top');
    const shop = (await request(app).get(`/api/products/${slug}`)).body.product;
    expect(shop).toMatchObject({
      sku, name: 'Kitenge Wrap Top', department: 'WOMEN', style: 'Casual', priceKes: 4500, isNew: true, onSale: false,
      imageFocus: '50% 15%', brand: { name: 'KikoRomeo' },
      imageUrl: `https://res.cloudinary.com/${TEST_CLOUD.name}/image/upload/f_auto,q_auto,c_limit,w_1200/v1790000000/nura/products/kitenge1`,
    });
    expect(shop.variants.map((v) => [v.size, v.stock])).toEqual([['S', 3], ['M', 5]]);
    expect((await request(app).get('/api/products?new=true')).body.products[0].sku).toBe(sku);   // newest first
    const [log] = (await db.execute(sql`select action, after from admin_actions where action = 'product.create' order by created_at desc limit 1`)).rows;
    expect(log.after).toMatchObject({ sku, name: 'Kitenge Wrap Top', priceKes: 4500 });
  });

  it('a new brand is created; an existing one is matched whatever the capitals', async () => {
    await as(admin).post('/api/admin/products').send(body({ name: 'Beaded Clutch', brand: 'Maasai Craft Co', image: uploaded('clutch') }));
    await as(admin).post('/api/admin/products').send(body({ name: 'Beaded Choker', brand: 'maasai craft co', image: uploaded('choker') }));
    expect((await db.execute(sql`select count(*)::int as n from brands where lower(name) = 'maasai craft co'`)).rows[0].n).toBe(1);
    expect((await as(admin).get('/api/admin/brands')).body.brands).toContain('Maasai Craft Co');
  });

  it('the same name twice gets its own address, and codes keep counting up', async () => {
    const a = (await as(admin).post('/api/admin/products').send(body({ name: 'Linen Shirt Dress', image: uploaded('l1') }))).body.product;
    const b = (await as(admin).post('/api/admin/products').send(body({ name: 'Linen Shirt Dress', image: uploaded('l2') }))).body.product;
    expect([a.slug, b.slug]).toEqual(['linen-shirt-dress', 'linen-shirt-dress-2']);
    expect(Number(b.sku.slice(5))).toBe(Number(a.sku.slice(5)) + 1);
  });

  it('eight products created at the same moment get eight different codes', async () => {
    // Straight to the service, all at once: over HTTP they'd arrive spread out and never collide.
    const [{ id: adminId }] = (await db.execute(sql`select id from users where email = 'maker@nura.test'`)).rows;
    const made = await Promise.all([...Array(8).keys()].map((i) =>
      createProduct({ id: adminId }, { ...body({ name: `Race ${i}`, image: uploaded(`race${i}`) }) })));
    expect(new Set(made.map((m) => m.sku)).size).toBe(8);
  });

  it('the products list sorts codes by number: nura-101 before nura-1000', async () => {
    const [{ id: adminId }] = (await db.execute(sql`select id from users where email = 'maker@nura.test'`)).rows;
    const [x, y] = await Promise.all(['Sort A', 'Sort B'].map((name, i) => createProduct({ id: adminId }, body({ name, image: uploaded(`sort${i}`) }))));
    // As text, "nura-1000" < "nura-101" (it compares "0" with "1" at the 8th character).
    await db.execute(sql`update products set sku = 'nura-1000' where sku = ${x.sku}`);
    await db.execute(sql`update products set sku = 'nura-101' where sku = ${y.sku}`);
    try {
      const skus = (await listProducts()).map((p) => p.sku);
      expect(skus.indexOf('nura-101')).toBeLessThan(skus.indexOf('nura-1000'));
      expect(skus.slice(0, 3)).toEqual(['nura-001', 'nura-002', 'nura-003']);
      const numbers = skus.map((k) => Number(k.slice(5)));
      expect(numbers).toEqual([...numbers].sort((m, n) => m - n));
    } finally {
      await db.execute(sql`delete from products where sku in ('nura-1000', 'nura-101')`);
    }
  });
});

describe('photos that are refused (and nothing is created)', () => {
  const refused = async (over, message) => {
    const before = await count();
    const res = await as(admin).post('/api/admin/products').send(body(over));
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(await count()).toBe(before);
  };

  it('a photo from outside NURA’s folder, or any image address, is refused', async () => {
    fake.resources.set('someone/else/x', { format: 'png', bytes: 100, version: 1 });
    await refused({ image: { publicId: 'someone/else/x' } }, /isn’t one uploaded through the admin/);
    await refused({ image: { publicId: 'https://evil.example/cat.png' } }, /isn’t one uploaded/);
    await refused({ image: { url: 'https://evil.example/cat.png' } }, /.+/);                    // no such field
  });

  it('a photo that was never uploaded is refused', async () => {
    await refused({ image: { publicId: 'nura/products/neveruploaded' } }, /wasn’t found/);
  });

  it('too big, or the wrong format: refused AND deleted from Cloudinary', async () => {
    await refused({ image: uploaded('huge', { bytes: 6 * 1024 * 1024 }) }, /5 MB or smaller/);
    await refused({ image: uploaded('anim', { format: 'gif' }) }, /JPEG, PNG, WebP or AVIF/);
    expect(fake.deleted).toEqual(['nura/products/huge', 'nura/products/anim']);
  });

  it('bad details are refused too', async () => {
    await refused({ compareAtKes: 4000 }, /“was” price must be higher/);
    await refused({ sizes: [{ size: 'M', stock: 1 }, { size: 'M', stock: 2 }] }, /Each size only once/);
    await refused({ sizes: [] }, /at least one size/);
    await refused({ sizes: [{ size: 'XXXL', stock: 1 }] }, /.+/);
    await refused({ name: ' ' }, /product name/);
  });

  it('the demo admin can’t create', async () => {
    expect((await as(looker).post('/api/admin/products').send(body({ image: uploaded('demo') }))).status).toBe(403);
  });
});

describe('changing a photo', () => {
  it('a new photo and crop for an existing product; audited', async () => {
    const [p] = (await db.execute(sql`select id from products where sku = 'nura-002'`)).rows;
    const res = await as(admin).put(`/api/admin/products/${p.id}/image`).send({ ...uploaded('blazer2'), imageFocus: 'bottom' });
    expect(res.status).toBe(200);
    const shop = (await request(app).get('/api/products/linen-oversized-blazer')).body.product;
    expect(shop.imageUrl).toMatch(/\/v1790000000\/nura\/products\/blazer2$/);
    expect(shop.imageFocus).toBe('50% 85%');
    const [log] = (await db.execute(sql`select before, after from admin_actions where action = 'product.image' order by created_at desc limit 1`)).rows;
    expect(log.before.imageUrl).toBe('images/linen_blazer.webp');
  });

  it('refused photos leave the old one in place', async () => {
    const [p] = (await db.execute(sql`select id, image_url from products where sku = 'nura-003'`)).rows;
    expect((await as(admin).put(`/api/admin/products/${p.id}/image`).send({ publicId: 'nura/products/missing' })).status).toBe(400);
    expect((await db.execute(sql`select image_url from products where id = ${p.id}`)).rows[0].image_url).toBe(p.image_url);
  });
});

describe('editing a description', () => {
  it('saves, shows on the product page, clears with an empty box; too long is refused; audited; not for the demo', async () => {
    const [p] = (await db.execute(sql`select id, description from products where sku = 'nura-012'`)).rows;
    const text = 'A navy shirt.\n\nWear it loose.';
    const res = await as(admin).patch(`/api/admin/products/${p.id}`).send({ description: `  ${text}  ` });
    expect(res.status).toBe(200);
    expect(res.body.products.find((x) => x.id === p.id).description).toBe(text);   // trimmed
    expect((await request(app).get('/p/relaxed-linen-shirt')).text).toContain('<p>A navy shirt.</p><p>Wear it loose.</p>');
    const [log] = (await db.execute(sql`select before, after from admin_actions where action = 'product.update' order by created_at desc limit 1`)).rows;
    expect(log).toMatchObject({ before: { description: p.description }, after: { description: text } });
    await as(admin).patch(`/api/admin/products/${p.id}`).send({ description: '   ' });
    expect((await db.execute(sql`select description from products where id = ${p.id}`)).rows[0].description).toBeNull();
    expect((await as(admin).patch(`/api/admin/products/${p.id}`).send({ description: 'x'.repeat(1001) })).body.error).toMatch(/under 1,000/);
    expect((await as(looker).patch(`/api/admin/products/${p.id}`).send({ description: 'demo was here' })).status).toBe(403);
    await db.execute(sql`update products set description = ${p.description} where id = ${p.id}`);
  });
});
