ALTER TABLE "orders" ADD COLUMN "customer_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_notes" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_key" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_key_unique" UNIQUE("checkout_key");