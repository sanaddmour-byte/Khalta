CREATE TABLE "material_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"price" numeric(12, 3) NOT NULL,
	"unit" text NOT NULL,
	"includes_delivery" boolean DEFAULT true NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"superseded_at" timestamp with time zone,
	"reason" text,
	"import_batch_id" uuid,
	"entered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"filename" text,
	"rows" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "price_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "price_snapshot_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"supplier_id" uuid,
	"price_id" uuid,
	"status" text NOT NULL,
	"price" numeric(12, 3),
	"unit" text,
	"includes_delivery" boolean,
	"effective_from" date,
	"jod_per_kg" numeric(18, 9),
	"note" text
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"as_of" date NOT NULL,
	"plant_ids" jsonb NOT NULL,
	"line_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_import_batches" ADD CONSTRAINT "price_import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_import_batches" ADD CONSTRAINT "price_import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_preferences" ADD CONSTRAINT "price_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_preferences" ADD CONSTRAINT "price_preferences_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_preferences" ADD CONSTRAINT "price_preferences_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_preferences" ADD CONSTRAINT "price_preferences_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_preferences" ADD CONSTRAINT "price_preferences_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshot_lines" ADD CONSTRAINT "price_snapshot_lines_snapshot_id_price_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."price_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "material_prices_cell_idx" ON "material_prices" USING btree ("tenant_id","material_id","plant_id");--> statement-breakpoint
CREATE INDEX "material_prices_plant_idx" ON "material_prices" USING btree ("tenant_id","plant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_preferences_cell_uq" ON "price_preferences" USING btree ("material_id","plant_id");--> statement-breakpoint
CREATE INDEX "price_snapshot_lines_snapshot_idx" ON "price_snapshot_lines" USING btree ("snapshot_id");