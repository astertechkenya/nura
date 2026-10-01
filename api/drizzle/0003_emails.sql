CREATE TABLE "order_emails" (
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_emails_order_id_kind_pk" PRIMARY KEY("order_id","kind")
);
--> statement-breakpoint
ALTER TABLE "order_emails" ADD CONSTRAINT "order_emails_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;