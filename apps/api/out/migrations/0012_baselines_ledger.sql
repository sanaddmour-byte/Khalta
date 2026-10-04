CREATE TABLE "cost_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"price_snapshot_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"cost_jod_per_m3" numeric(12, 3) NOT NULL,
	"monthly_volume_m3" numeric(12, 2),
	"volume_source" text,
	"annual_jod" numeric(16, 3),
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"baseline_design_id" uuid NOT NULL,
	"variant_design_id" uuid NOT NULL,
	"variant_evaluation_id" uuid NOT NULL,
	"price_snapshot_id" uuid NOT NULL,
	"state" text DEFAULT 'theoretical' NOT NULL,
	"reason_code" text NOT NULL,
	"saving_jod_per_m3" numeric(12, 3) NOT NULL,
	"monthly_volume_m3" numeric(12, 2),
	"annual_jod" numeric(16, 3),
	"provisional" boolean NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_evaluations" ADD COLUMN "summary" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "design_evaluations" ADD COLUMN "test_versions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_baselines" ADD CONSTRAINT "cost_baselines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_baselines" ADD CONSTRAINT "cost_baselines_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_baselines" ADD CONSTRAINT "cost_baselines_evaluation_id_design_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."design_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_baselines" ADD CONSTRAINT "cost_baselines_price_snapshot_id_price_snapshots_id_fk" FOREIGN KEY ("price_snapshot_id") REFERENCES "public"."price_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_baselines" ADD CONSTRAINT "cost_baselines_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_baselines" ADD CONSTRAINT "cost_baselines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_baseline_id_cost_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."cost_baselines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_baseline_design_id_mix_designs_id_fk" FOREIGN KEY ("baseline_design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_variant_design_id_mix_designs_id_fk" FOREIGN KEY ("variant_design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_variant_evaluation_id_design_evaluations_id_fk" FOREIGN KEY ("variant_evaluation_id") REFERENCES "public"."design_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_price_snapshot_id_price_snapshots_id_fk" FOREIGN KEY ("price_snapshot_id") REFERENCES "public"."price_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_baselines_design_snapshot_uq" ON "cost_baselines" USING btree ("design_id","price_snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "savings_entries_variant_eval_uq" ON "savings_entries" USING btree ("baseline_id","variant_evaluation_id");