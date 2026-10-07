// salePrice.js: what a product costs right now (Oct 2026: sale windows).
//
// A product on sale has two prices: priceKes (the sale price) and compareAtKes (the "was"
// price). A sale can be given a start and/or an end. Outside that window the sale isn't on:
// the product sells at its "was" price, and no "was" price is shown.
//
// Every place that shows or charges a price goes through here: the catalogue (and so the
// product pages and the wishlist), the cart, and checkout. One rule, one place, so the price
// a shopper sees on a card is the price checkout charges.
//
// Computed when read, rather than by a job that flips prices at midnight: nothing has to wake
// the free database on a schedule, and a price can never be "late" because a job didn't run.

/** The sale window contains `now` (no start = already started, no end = never ends). */
export function saleIsOn(p, now = new Date()) {
  if (p.compareAtKes == null) return false;
  if (p.saleStartsAt && now < new Date(p.saleStartsAt)) return false;
  if (p.saleEndsAt && now >= new Date(p.saleEndsAt)) return false;
  return true;
}

/** { priceKes, compareAtKes, onSale } as of `now`. compareAtKes is null when not on sale. */
export function livePrice(p, now = new Date()) {
  if (saleIsOn(p, now)) return { priceKes: p.priceKes, compareAtKes: p.compareAtKes, onSale: true };
  // Outside its window, a product with a sale set up sells at its regular ("was") price.
  return { priceKes: p.compareAtKes ?? p.priceKes, compareAtKes: null, onSale: false };
}
