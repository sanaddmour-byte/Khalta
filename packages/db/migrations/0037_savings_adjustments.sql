CREATE TABLE "savings_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_jod" numeric(16, 3) NOT NULL,
	"note" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "savings_adjustments" ADD CONSTRAINT "savings_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_adjustments" ADD CONSTRAINT "savings_adjustments_entry_id_savings_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."savings_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_adjustments" ADD CONSTRAINT "savings_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "savings_adjustments_one_reversal_uq" ON "savings_adjustments" USING btree ("entry_id") WHERE "savings_adjustments"."kind" = 'reversal';--> statement-breakpoint
CREATE INDEX "savings_adjustments_entry_idx" ON "savings_adjustments" USING btree ("entry_id");--> statement-breakpoint
ALTER TABLE "savings_adjustments" ADD CONSTRAINT "savings_adjustments_amount_chk" CHECK ("amount_jod" > 0 AND length(trim("note")) >= 10);--> statement-breakpoint
CREATE TRIGGER savings_adjustments_append_only BEFORE UPDATE OR DELETE ON "savings_adjustments"
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
