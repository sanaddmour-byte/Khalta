CREATE TABLE "daily_digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insight_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"insight_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"plant_id" uuid,
	"design_id" uuid,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"saving_jod_per_m3" numeric(12, 3),
	"annual_jod" numeric(16, 3),
	"provisional" boolean DEFAULT true NOT NULL,
	"snoozed_until" timestamp with time zone,
	"resolved_reason" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"draft_design_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "production_volumes_uq";--> statement-breakpoint
DROP INDEX "savings_entries_variant_eval_uq";--> statement-breakpoint
ALTER TABLE "savings_entries" ALTER COLUMN "variant_evaluation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "production_volumes" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "production_volumes" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "production_volumes" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD COLUMN "period" date;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD COLUMN "produced_volume_m3" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "savings_entries" ADD COLUMN "baseline_cost_jod_per_m3" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "savings_entries" ADD COLUMN "replacement_cost_jod_per_m3" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "savings_entries" ADD COLUMN "total_jod" numeric(16, 3);--> statement-breakpoint
ALTER TABLE "savings_entries" ADD COLUMN "insight_id" uuid;--> statement-breakpoint
ALTER TABLE "daily_digests" ADD CONSTRAINT "daily_digests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_events" ADD CONSTRAINT "insight_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_events" ADD CONSTRAINT "insight_events_insight_id_insights_id_fk" FOREIGN KEY ("insight_id") REFERENCES "public"."insights"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_events" ADD CONSTRAINT "insight_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_draft_design_id_mix_designs_id_fk" FOREIGN KEY ("draft_design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_digests_day_uq" ON "daily_digests" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE INDEX "insight_events_insight_idx" ON "insight_events" USING btree ("insight_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_open_dedupe_uq" ON "insights" USING btree ("tenant_id","dedupe_key") WHERE "insights"."status" in ('open', 'snoozed');--> statement-breakpoint
CREATE INDEX "insights_inbox_idx" ON "insights" USING btree ("tenant_id","status","severity");--> statement-breakpoint
ALTER TABLE "production_volumes" ADD CONSTRAINT "production_volumes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_insight_id_insights_id_fk" FOREIGN KEY ("insight_id") REFERENCES "public"."insights"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_volumes_design_month_idx" ON "production_volumes" USING btree ("design_id","month","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "savings_entries_theoretical_uq" ON "savings_entries" USING btree ("baseline_id","variant_evaluation_id") WHERE "savings_entries"."state" = 'theoretical';--> statement-breakpoint
CREATE UNIQUE INDEX "savings_entries_approved_uq" ON "savings_entries" USING btree ("baseline_id","variant_design_id") WHERE "savings_entries"."state" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "savings_entries_realized_uq" ON "savings_entries" USING btree ("baseline_id","variant_design_id","period") WHERE "savings_entries"."state" = 'realized';