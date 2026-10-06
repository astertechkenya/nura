-- What actually arrived for a FLAGGED payment (paid, but not the amount we asked for), so a
-- refund or an accepted underpayment uses the real figure. Additive: existing rows stay null,
-- which means "the same as amount_kes".
ALTER TABLE "payments" ADD COLUMN "received_kes" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_positive" CHECK ("payments"."received_kes" is null or "payments"."received_kes" > 0);