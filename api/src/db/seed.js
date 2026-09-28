// seed.js: fills the database with NURA's catalogue and two demo accounts.
//
// The catalogue is NOT retyped. It is read from the storefront's own product list
// (frontend/js/search.js) and combined with seed-overrides.json, which holds what the
// pages never modelled: departments, styles, sale prices, arrival dates, sizes and stock.
//
// Safe to run again and again: every write is an upsert (insert, or update if it exists),
// so a second run changes nothing unless you edited the source files. Stock is reset to the
// values in seed-overrides.json each run, which is what you want for a demo database.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from './client.js';
import { brands, products, productVariants, users } from './schema.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const slugify = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** 'KSh 14,200' → 14200 */
export const parseKsh = (s) => {
  const n = Number(String(s).replace(/[^0-9]/g, ''));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Not a price: ${s}`);
  return n;
};

/** Reads the NURA_PRODUCTS array out of the storefront script without running the page. */
export function readStorefrontProducts(file = here('../../../frontend/js/search.js')) {
  const src = readFileSync(file, 'utf8');
  const match = src.match(/NURA_PRODUCTS\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error(`NURA_PRODUCTS not found in ${file}`);
  // Evaluate ONLY the array literal, in an empty sandbox with no access to anything else.
  // This is our own file, but there is no reason to give it more power than it needs.
  return vm.runInNewContext(match[1], Object.create(null), { timeout: 1000 });
}

export function buildCatalogue(storefront, overrides, now = new Date()) {
  return storefront.map((p) => {
    const o = overrides.products[p.id];
    if (!o) throw new Error(`${p.id} (${p.name}) has no entry in seed-overrides.json`);
    return {
      product: {
        sku: p.id,
        slug: slugify(p.name),
        name: p.name,
        brandName: p.brand,
        department: o.department,
        style: o.style ?? null,
        priceKes: parseKsh(p.price),
        compareAtKes: o.compareAtKes ?? null,
        imageUrl: p.img,
        imageFocus: o.imageFocus ?? '50% 50%',
        cardBg: p.bg,
        arrivedAt: new Date(now.getTime() - o.arrivedDaysAgo * 24 * 60 * 60 * 1000),
      },
      stock: o.stock,
    };
  });
}

export async function seed({ log = console.log } = {}) {
  const overrides = JSON.parse(readFileSync(here('./seed-overrides.json'), 'utf8'));
  const catalogue = buildCatalogue(readStorefrontProducts(), overrides);

  // One transaction: the seed either lands completely or not at all.
  await db.transaction(async (tx) => {
    // Brands
    const brandIds = {};
    for (const name of [...new Set(catalogue.map((c) => c.product.brandName))]) {
      const [row] = await tx.insert(brands).values({ name, slug: slugify(name) })
        .onConflictDoUpdate({ target: brands.name, set: { slug: slugify(name) } })
        .returning({ id: brands.id });
      brandIds[name] = row.id;
    }

    // Products and their sizes
    for (const { product, stock } of catalogue) {
      const { brandName, ...values } = product;
      values.brandId = brandIds[brandName];
      const [row] = await tx.insert(products).values(values)
        .onConflictDoUpdate({ target: products.sku, set: { ...values, updatedAt: new Date() } })
        .returning({ id: products.id });

      for (const [size, qty] of Object.entries(stock)) {
        await tx.insert(productVariants).values({ productId: row.id, size, stock: qty })
          .onConflictDoUpdate({ target: [productVariants.productId, productVariants.size], set: { stock: qty } });
      }
    }

    // Demo accounts. These are meant to be shared on the /demo page. DEMO_ADMIN can open
    // the admin screens but every change is refused (Phase 7), so sharing it is safe.
    // The real ADMIN is never seeded: it is created by a command on the server (Phase 7).
    const password = process.env.SEED_DEMO_PASSWORD || 'nura-demo-2026';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const demoUsers = [
      { email: 'demo@nura.test', name: 'Demo Customer', role: 'CUSTOMER' },
      { email: 'demo-admin@nura.test', name: 'Demo Admin', role: 'DEMO_ADMIN' },
    ];
    for (const u of demoUsers) {
      // Emails are unique on lower(email). Drizzle's upsert can't target an expression
      // index, so look the account up first, then update or insert.
      const [existing] = await tx.select({ id: users.id }).from(users)
        .where(sql`lower(${users.email}) = ${u.email.toLowerCase()}`);
      if (existing) {
        await tx.update(users).set({ name: u.name, role: u.role, passwordHash })
          .where(eq(users.id, existing.id));
      } else {
        await tx.insert(users).values({ ...u, passwordHash });
      }
    }
  });

  log(`Seeded ${catalogue.length} products, ` +
      `${new Set(catalogue.map((c) => c.product.brandName)).size} brands, 2 demo accounts.`);
  return catalogue.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await seed();
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
