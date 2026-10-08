-- 0008 (Oct 2026): two indexes, nothing else. Postgres doesn't index foreign keys on its own, so
-- every order page, admin order list and restock looked through ALL order items and payments.
-- Creating them takes a moment on today's tables and changes no data.
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_order_created_idx" ON "payments" USING btree ("order_id","created_at");