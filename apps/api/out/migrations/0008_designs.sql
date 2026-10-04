CREATE TABLE "design_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"actor_id" text,
	"evidence" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"filename" text,
	"rows" jsonb NOT NULL,
	"header" jsonb NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mix_design_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"quantity_kg_m3" numeric(12, 3) NOT NULL,
	"original_quantity" numeric(12, 3) NOT NULL,
	"original_unit" text NOT NULL,
	"original_name" text NOT NULL,
	"source_line" integer,
	"match_method" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mix_designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"plant_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approval_source" text,
	"external_approval_ref" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"ruleset_mode" text,
	"requirements" jsonb NOT NULL,
	"inputs_snapshot" jsonb NOT NULL,
	"imported_approval_ref" text,
	"imported_in_production" boolean,
	"avg_monthly_volume_m3" numeric(12, 2),
	"evaluation_pending" boolean DEFAULT true NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"import_batch_id" uuid,
	"synthetic" boolean DEFAULT false NOT NULL,
	"parent_design_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "production_volumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"month" date NOT NULL,
	"volume_m3" numeric(12, 2) NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_transitions" ADD CONSTRAINT "design_transitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_transitions" ADD CONSTRAINT "design_transitions_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_transitions" ADD CONSTRAINT "design_transitions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_import_batches" ADD CONSTRAINT "legacy_import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_import_batches" ADD CONSTRAINT "legacy_import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_design_lines" ADD CONSTRAINT "mix_design_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_design_lines" ADD CONSTRAINT "mix_design_lines_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_design_lines" ADD CONSTRAINT "mix_design_lines_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_designs" ADD CONSTRAINT "mix_designs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_designs" ADD CONSTRAINT "mix_designs_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_designs" ADD CONSTRAINT "mix_designs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_designs" ADD CONSTRAINT "mix_designs_import_batch_id_legacy_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."legacy_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_designs" ADD CONSTRAINT "mix_designs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_volumes" ADD CONSTRAINT "production_volumes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_volumes" ADD CONSTRAINT "production_volumes_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_volumes" ADD CONSTRAINT "production_volumes_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_transitions_design_idx" ON "design_transitions" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "mix_design_lines_design_idx" ON "mix_design_lines" USING btree ("design_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mix_designs_code_uq" ON "mix_designs" USING btree ("tenant_id","code","version") WHERE "mix_designs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "mix_designs_plant_idx" ON "mix_designs" USING btree ("tenant_id","plant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "production_volumes_uq" ON "production_volumes" USING btree ("design_id","month");