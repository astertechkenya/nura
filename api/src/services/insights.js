// insights.js: the admin's Insights page (Oct 2026). Read-only: nothing here changes data.
//
// Four questions, all answered from data the shop already keeps:
//   1. How much came in, day by day, and how was it paid?           (orders)
//   2. What sells?                                                  (order_items)
//   3. What do people want, including what we can't sell them?     (wishlists)
//   4. How much is sitting in carts that never reached checkout?    (carts)
//
// Days are Nairobi days: a sale at 01:00 in Nairobi is 22:00 UTC the day before.
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { livePrice } from '../lib/salePrice.js';

export const INSIGHT_DAYS = 30;
const TZ = 'Africa/Nairobi';

// Money that is actually in: paid by M-Pesa or card (and not cancelled since), or cash on
// delivery that has been delivered. The same rule as the dashboard's 7-day takings.
const MONEY_IN = sql`status in ('PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED') and (payment_method <> 'COD' or status = 'DELIVERED')`;
// Orders that count as "sold" for best sellers: everything placed and not abandoned, including
// cash orders still on their way (their stock is gone either way).
const SOLD = sql`o.status in ('AWAITING_COD', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED')`;

/** The last INSIGHT_DAYS Nairobi dates, oldest first, as YYYY-MM-DD. */
function lastDays(now = new Date()) {
  const today = new Date(now.toLocaleString('en-CA', { timeZone: TZ }).slice(0, 10) + 'T00:00:00Z');
  return Array.from({ length: INSIGHT_DAYS }, (_, i) =>
    new Date(today.getTime() - (INSIGHT_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

export async function insights(now = new Date()) {
  const days = lastDays(now);
  const since = days[0];

  // 1. Takings per day and payment method.
  const rows = (await db.execute(sql`
    select to_char(created_at at time zone ${TZ}, 'YYYY-MM-DD') as day, payment_method as method,
           sum(total_kes)::int as kes, count(*)::int as n
    from orders
    where ${MONEY_IN} and (created_at at time zone ${TZ})::date >= ${since}::date
    group by 1, 2`)).rows;
  const daily = days.map((day) => {
    const d = { day, MPESA: 0, CARD: 0, COD: 0 };
    rows.filter((r) => r.day === day).forEach((r) => { d[r.method] = r.kes; });
    return d;
  });
  const takingsKes = rows.reduce((s, r) => s + r.kes, 0);
  const orderCount = rows.reduce((s, r) => s + r.n, 0);

  // 2. Best sellers: units and revenue over the same days, with what's left in stock.
  const bestSellers = (await db.execute(sql`
    select oi.sku, oi.name, sum(oi.qty)::int as units, sum(oi.qty * oi.unit_price_kes)::int as revenue_kes,
           coalesce((select sum(v.stock) from product_variants v join products p on p.id = v.product_id
                     where p.sku = oi.sku), 0)::int as stock_left
    from order_items oi join orders o on o.id = oi.order_id
    where ${SOLD} and (o.created_at at time zone ${TZ})::date >= ${since}::date
    group by oi.sku, oi.name
    order by units desc, revenue_kes desc
    limit 8`)).rows;

  // 3. Wishlists. Only signed-in shoppers' wishlists are on the server; a guest's lives in
  //    their own browser, so these counts are a floor, not the whole picture.
  const wanted = (await db.execute(sql`
    select p.sku, p.name, count(*)::int as wants,
           coalesce((select sum(v.stock) from product_variants v where v.product_id = p.id), 0)::int as stock
    from wishlist_items w join products p on p.id = w.product_id
    where p.is_active
    group by p.id
    order by wants desc, p.name
    limit 20`)).rows;
  const mostWanted = wanted.slice(0, 8);
  const wantedSoldOut = wanted.filter((p) => p.stock === 0);   // a ready-made restock list

  // 4. Carts left alone for over an hour (and touched within the period), priced as of now.
  const cartLines = (await db.execute(sql`
    select c.id as cart_id, ci.qty, p.price_kes, p.compare_at_kes, p.sale_starts_at, p.sale_ends_at
    from carts c join cart_items ci on ci.cart_id = c.id
    join product_variants v on v.id = ci.variant_id join products p on p.id = v.product_id
    where p.is_active and c.updated_at < now() - interval '1 hour'
      and (c.updated_at at time zone ${TZ})::date >= ${since}::date`)).rows;
  const carts = new Set(cartLines.map((l) => l.cart_id));
  const cartValueKes = cartLines.reduce((s, l) => s + l.qty * livePrice({
    priceKes: l.price_kes, compareAtKes: l.compare_at_kes, saleStartsAt: l.sale_starts_at, saleEndsAt: l.sale_ends_at,
  }, now).priceKes, 0);

  return {
    days: INSIGHT_DAYS,
    takingsKes, orderCount, averageOrderKes: orderCount ? Math.round(takingsKes / orderCount) : 0,
    daily,
    bestSellers: bestSellers.map((r) => ({ sku: r.sku, name: r.name, units: r.units, revenueKes: r.revenue_kes, stockLeft: r.stock_left })),
    mostWanted, wantedSoldOut,
    abandoned: { carts: carts.size, valueKes: cartValueKes },
  };
}
