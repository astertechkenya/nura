// slug.js: "Linen Oversized Blazer" → "linen-oversized-blazer". Used for product and brand
// addresses, by the seed script and by the admin when it creates a product.
export const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
