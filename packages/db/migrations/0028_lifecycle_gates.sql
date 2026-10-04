ALTER TABLE "design_acceptances" ADD COLUMN "kind" text DEFAULT 'declared_values' NOT NULL;--> statement-breakpoint
ALTER TABLE "design_acceptances" ADD COLUMN "assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "design_transitions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "design_transitions_idem_uq" ON "design_transitions" USING btree ("tenant_id","design_id","idempotency_key") WHERE "design_transitions"."idempotency_key" is not null;