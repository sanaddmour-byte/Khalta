CREATE TABLE "change_impact_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"impact_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"design_version" integer NOT NULL,
	"class" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disposition" text,
	"disposition_by" text,
	"disposition_at" timestamp with time zone,
	"disposition_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_impacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"subject" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"job_state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "change_impact_items" ADD CONSTRAINT "change_impact_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_impact_items" ADD CONSTRAINT "change_impact_items_impact_id_change_impacts_id_fk" FOREIGN KEY ("impact_id") REFERENCES "public"."change_impacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_impact_items" ADD CONSTRAINT "change_impact_items_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_impact_items" ADD CONSTRAINT "change_impact_items_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_impact_items" ADD CONSTRAINT "change_impact_items_disposition_by_users_id_fk" FOREIGN KEY ("disposition_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_impacts" ADD CONSTRAINT "change_impacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_impact_items_uq" ON "change_impact_items" USING btree ("impact_id","design_id");--> statement-breakpoint
CREATE INDEX "change_impact_items_open_idx" ON "change_impact_items" USING btree ("tenant_id","class");--> statement-breakpoint
CREATE UNIQUE INDEX "change_impacts_dedupe_uq" ON "change_impacts" USING btree ("tenant_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "change_impacts_state_idx" ON "change_impacts" USING btree ("tenant_id","job_state","created_at");--> statement-breakpoint
-- A disposition is recorded once, with who, when and why, and never for a no-op row.
ALTER TABLE "change_impact_items" ADD CONSTRAINT "change_impact_items_disposition_chk"
  CHECK (("disposition" IS NULL AND "disposition_by" IS NULL AND "disposition_at" IS NULL AND "disposition_note" IS NULL)
      OR ("disposition" IS NOT NULL AND "disposition_by" IS NOT NULL AND "disposition_at" IS NOT NULL AND length(trim("disposition_note")) >= 10));--> statement-breakpoint
-- Items are append-only apart from the one-time disposition.
CREATE FUNCTION change_impact_items_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'change_impact_items is append-only (DELETE not allowed)'; END IF;
  IF OLD.disposition IS NOT NULL THEN RAISE EXCEPTION 'a disposition is final'; END IF;
  IF NEW.impact_id <> OLD.impact_id OR NEW.design_id <> OLD.design_id OR NEW."class" <> OLD."class"
     OR NEW.reasons::text <> OLD.reasons::text OR NEW.design_version <> OLD.design_version THEN
    RAISE EXCEPTION 'only the disposition of a change-impact item can be set';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER change_impact_items_guard BEFORE UPDATE OR DELETE ON "change_impact_items"
  FOR EACH ROW EXECUTE FUNCTION change_impact_items_guard();
