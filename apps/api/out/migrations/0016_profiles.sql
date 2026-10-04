CREATE TABLE "characteristic_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"applies_to" jsonb NOT NULL,
	"characteristics" jsonb NOT NULL,
	"materials" jsonb NOT NULL,
	"objective" text,
	"ruleset_mode" text,
	"change_note" text,
	"check" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "characteristic_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"plant_id" uuid,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"family" text,
	"owner_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "design_requests" ADD COLUMN "profile_versions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "design_requests" ADD COLUMN "profile_origins" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "characteristic_profile_versions" ADD CONSTRAINT "characteristic_profile_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characteristic_profile_versions" ADD CONSTRAINT "characteristic_profile_versions_profile_id_characteristic_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."characteristic_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characteristic_profile_versions" ADD CONSTRAINT "characteristic_profile_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characteristic_profile_versions" ADD CONSTRAINT "characteristic_profile_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characteristic_profiles" ADD CONSTRAINT "characteristic_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characteristic_profiles" ADD CONSTRAINT "characteristic_profiles_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characteristic_profiles" ADD CONSTRAINT "characteristic_profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "characteristic_profile_versions_uq" ON "characteristic_profile_versions" USING btree ("profile_id","version");--> statement-breakpoint
CREATE INDEX "characteristic_profiles_tenant_idx" ON "characteristic_profiles" USING btree ("tenant_id","scope");