CREATE TABLE "batch_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"design_version" integer NOT NULL,
	"plant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"moisture" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"validator" jsonb NOT NULL,
	"validator_status" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strength_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"trial_batch_id" uuid,
	"design_id" uuid NOT NULL,
	"cast_date" date NOT NULL,
	"age_days" integer NOT NULL,
	"specimen_type" text NOT NULL,
	"set_id" text NOT NULL,
	"result_mpa" numeric(6, 2) NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trial_batches" ADD COLUMN "water_added_kg_m3" numeric(6, 1);--> statement-breakpoint
ALTER TABLE "trial_batches" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "batch_instances" ADD CONSTRAINT "batch_instances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_instances" ADD CONSTRAINT "batch_instances_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_instances" ADD CONSTRAINT "batch_instances_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_instances" ADD CONSTRAINT "batch_instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_results" ADD CONSTRAINT "strength_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_results" ADD CONSTRAINT "strength_results_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_results" ADD CONSTRAINT "strength_results_trial_batch_id_trial_batches_id_fk" FOREIGN KEY ("trial_batch_id") REFERENCES "public"."trial_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_results" ADD CONSTRAINT "strength_results_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_results" ADD CONSTRAINT "strength_results_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_instances_design_idx" ON "batch_instances" USING btree ("design_id","created_at");--> statement-breakpoint
CREATE INDEX "strength_results_design_idx" ON "strength_results" USING btree ("design_id","age_days");--> statement-breakpoint
ALTER TABLE "trial_batches" ADD CONSTRAINT "trial_batches_supersedes_id_trial_batches_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."trial_batches"("id") ON DELETE no action ON UPDATE no action;