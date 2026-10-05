// Phase 8: product pages and the sitemap, rendered by the API.
// The rules: the page arrives complete (title, preview tags, product data) for WhatsApp and
// Google, which run no JavaScript; database text can never become markup or script; hidden or
// unknown products are a 404 that search engines drop; the page carries the storefront's own
// security policy (the same as frontend/_headers).
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { config } from '../src/config.js';
import { SITE_CSP } from '../src/lib/siteHeaders.js';
import { recommend } from '../src/routes/pages.js';
import { seed } from '../src/db/seed.js';

const app = createApp();
// seed() puts back prices and stock; visibility it leaves alone, so restore that here too.
afterAll(async () => {
  await db.execute(sql`update products set is_active = true where sku = 'nura-005'`);
  await seed({ log: () => {} }); await pool.end();
});

const page = (slug) => request(app).get(`/p/${slug}`);
const ldOf = (html) => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
const dataOf = (html) => JSON.parse(/<script type="application\/json" id="pdData">([\s\S]*?)<\/script>/.exec(html)[1]);

describe('a product page', () => {
  it('arrives complete: title, preview card, schema.org offer, sizes', async () => {
    const res = await page('linen-oversized-blazer');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const h = res.text;
    expect(h).toContain('<title>Linen Oversized Blazer by KikoRomeo — NURA</title>');
    expect(h).toContain(`<link rel="canonical" href="${config.SITE_URL}/p/linen-oversized-blazer" />`);
    expect(h).toMatch(/<meta property="og:title" content="Linen Oversized Blazer — KSh [\d,]+" \/>/);
    expect(h).toContain(`<meta property="og:image" content="${config.SITE_URL}/images/linen_blazer.webp" />`);
    expect(h).toContain('<h1 class="pd__name" id="pdTitle" tabindex="-1">Linen Oversized Blazer</h1>');
    const ld = ldOf(h);
    expect(ld).toMatchObject({ '@type': 'Product', sku: 'nura-002', offers: { priceCurrency: 'KES', availability: 'https://schema.org/InStock' } });
    expect(h.match(/name="variant"/g)).toHaveLength(5);
    expect(dataOf(h)).toMatchObject({ sku: 'nura-002', slug: 'linen-oversized-blazer' });
    expect(h).not.toContain('<!--nura:');                       // both regions were filled
    expect(h).toContain('<script src="js/product.js" defer></script>');
  });

  it('a one-size product has its size chosen already; a sold-out size is disabled and says so', async () => {
    const one = (await page('pearl-chain-bracelet')).text;
    expect(one).toMatch(/<fieldset class="pd__sizes" hidden>/);
    expect(one).toMatch(/name="variant" value="[^"]+" data-stock="\d+" data-size="ONE SIZE" checked>/);
    await db.execute(sql`update product_variants set stock = 0 where size = 'M' and product_id = (select id from products where sku = 'nura-002')`);
    const h = (await page('linen-oversized-blazer')).text;
    expect(h).toMatch(/data-size="M" disabled><span>M<\/span><span class="visually-hidden">, sold out<\/span>/);
  });

  it('entirely sold out: the button says so and Google is told OutOfStock', async () => {
    await db.execute(sql`update product_variants set stock = 0 where product_id = (select id from products where sku = 'nura-004')`);
    const h = (await page('handwoven-bucket-hat')).text;
    expect(h).toMatch(/<button type="submit" class="pd__add" id="pdAdd" disabled>Sold out<\/button>/);
    expect(ldOf(h).offers.availability).toBe('https://schema.org/OutOfStock');
  });

  it('carries the storefront’s security policy, identical to frontend/_headers; cached briefly, by browsers only', async () => {
    const res = await page('linen-oversized-blazer');
    expect(res.headers['content-security-policy']).toBe(SITE_CSP);
    const headersFile = readFileSync(new URL('../../frontend/_headers', import.meta.url), 'utf8');
    expect(/^\s+Content-Security-Policy: (.*)$/m.exec(headersFile)[1].trim()).toBe(SITE_CSP);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('private, max-age=30');
    expect(res.headers['netlify-cdn-cache-control']).toBe('no-store');
  });
});

describe('text from the database stays text', () => {
  it('a hostile product name can’t close a tag, start a script, or use replacement patterns', async () => {
    const evil = `Evil </script><script>alert(1)</script> "quote" $& $1 <img src=x onerror=alert(2)>`;
    // Casual, KikoRomeo, the blazer's price, in stock: so it's also the blazer page's first suggestion.
    await db.execute(sql`insert into products (sku, slug, name, brand_id, department, style, price_kes, image_url, description, image_focus, card_bg)
      select 'nura-990', 'evil-test', ${evil}, id, 'WOMEN', 'Casual', 14200, 'images/x.webp', ${'Line one\n\n</p><script>alert(3)</script>'}, '1%;background:url(x)', 'red;}' from brands where name = 'KikoRomeo'`);
    await db.execute(sql`insert into product_variants (product_id, size, stock) select id, 'M', 3 from products where sku = 'nura-990'`);
    try {
      const blazer = (await page('linen-oversized-blazer')).text;
      expect(blazer).toContain('<a class="pd-rec" href="/p/evil-test">');
      expect(blazer).not.toContain('<script>alert');
      expect(blazer).not.toContain('<img src=x');
      const h = (await page('evil-test')).text;
      // Exactly the layout's own scripts, plus our two data blocks: nothing from the name.
      expect(h).not.toContain('<script>alert');
      expect(h).not.toContain('<img src=x');
      expect(h).toContain('Evil &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &quot;quote&quot; $&amp; $1');
      expect(dataOf(h).name).toBe(evil);                       // the JSON still reads back exactly
      expect(ldOf(h).name).toBe(evil);
      expect(h).toContain('object-position:50% 50%');           // a malformed focus isn't pasted into style=""
      expect(h).toContain('background-color:#efefed');          // nor a malformed colour
    } finally {
      await db.execute(sql`delete from products where sku = 'nura-990'`);
    }
  });
});

describe('not found', () => {
  it('unknown, malformed, or hidden: 404 with noindex, never cached', async () => {
    await db.execute(sql`update products set is_active = false where sku = 'nura-005'`);
    for (const slug of ['no-such-thing', 'neverfull-tote-bag', 'UPPER', '..%2F..%2Fetc', 'a'.repeat(101)]) {
      const res = await page(slug);
      expect(res.status, slug).toBe(404);
      expect(res.text).toContain('<meta name="robots" content="noindex" />');
      expect(res.text).toContain('We couldn’t find that product');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('the sitemap', () => {
  it('lists the shop pages and every visible product, not hidden ones', async () => {
    const res = await request(app).get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/xml/);
    expect(res.text).toContain(`<loc>${config.SITE_URL}/</loc>`);
    expect(res.text).toContain(`<loc>${config.SITE_URL}/sale.html</loc>`);
    expect(res.text).toMatch(new RegExp(`<loc>${config.SITE_URL}/p/linen-oversized-blazer</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
    expect(res.text).not.toContain('/p/neverfull-tote-bag');       // hidden in the test above
    await db.execute(sql`update products set is_active = true where sku = 'nura-005'`);
    expect((await request(app).get('/sitemap.xml')).text).toContain('/p/neverfull-tote-bag');
  });
});

const recsOf = (html) => [...html.matchAll(/<a class="pd-rec" href="\/p\/([a-z0-9-]+)">/g)].map((m) => m[1]);
const deptOf = async (slug) => (await db.execute(sql`select department from products where slug = ${slug}`)).rows[0].department;

describe('descriptions', () => {
  it('the page shows the description as paragraphs, and previews use its opening', async () => {
    const h = (await page('linen-oversized-blazer')).text;
    expect(h).toContain('<p>An off-white blazer with a relaxed, oversized cut');
    expect(h.match(/<section class="pd__section" aria-labelledby="pdDetails">.*?<\/section>/s)[0].match(/<p>/g)).toHaveLength(2);
    const meta = /<meta name="description" content="([^"]*)" \/>/.exec(h)[1];
    expect(meta.startsWith('An off-white blazer')).toBe(true);
    expect(meta.length).toBeLessThanOrEqual(156);
    expect(meta.endsWith('…')).toBe(true);
  });
});

describe('you may also like', () => {
  it('four others, most similar first, never the product itself or another department', async () => {
    const recs = recsOf((await page('linen-oversized-blazer')).text);   // WOMEN, Casual, KikoRomeo
    expect(recs).toHaveLength(4);
    expect(recs[0]).toBe('cotton-wrap-skirt');                         // WOMEN + Casual + KikoRomeo
    expect(recs).not.toContain('linen-oversized-blazer');
    for (const r of recs) expect(['WOMEN', 'UNISEX']).toContain(await deptOf(r));
    const men = recsOf((await page('slim-tapered-trousers')).text);
    for (const r of men) expect(['MEN', 'UNISEX']).toContain(await deptOf(r));
  });

  it('never suggests something sold out or hidden', async () => {
    await db.execute(sql`update product_variants set stock = 0 where product_id = (select id from products where sku = 'nura-010')`);
    await db.execute(sql`update products set is_active = false where sku = 'nura-007'`);
    try {
      const recs = recsOf((await page('linen-oversized-blazer')).text);
      expect(recs).not.toContain('cotton-wrap-skirt');
      expect(recs).not.toContain('tailored-column-dress');
      expect(recs).toHaveLength(4);
    } finally {
      await db.execute(sql`update products set is_active = true where sku = 'nura-007'`);
    }
  });

  it('the rules on their own: fills from other departments only when it must; the same page, the same suggestions', () => {
    const mk = (sku, department, style, priceKes, totalStock = 5, brand = 'X') => ({ sku, department, style, priceKes, totalStock, brand: { name: brand } });
    const p = mk('a', 'MEN', 'Formal', 10000);
    const all = [p, mk('b', 'MEN', 'Formal', 50000), mk('c', 'MEN', null, 9000), mk('d', 'WOMEN', 'Formal', 10000), mk('e', 'WOMEN', null, 10000), mk('f', 'UNISEX', null, 10000, 0)];
    expect(recommend(p, all).map((o) => o.sku)).toEqual(['b', 'c', 'd', 'e']);   // MEN first (style beats price), WOMEN only to fill; f is sold out
    expect(recommend(p, [...all].reverse()).map((o) => o.sku)).toEqual(['b', 'c', 'd', 'e']);
  });
});
