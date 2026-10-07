-- An optional sale window on each product (Oct 2026). Outside it the product sells at its
-- "was" price and shows no sale. Additive: existing rows stay null, which means "no limit",
-- so every sale running today carries on exactly as before.
ALTER TABLE "products" ADD COLUMN "sale_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "sale_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_sale_window_order" CHECK ("products"."sale_starts_at" IS NULL OR "products"."sale_ends_at" IS NULL OR "products"."sale_ends_at" > "products"."sale_starts_at");