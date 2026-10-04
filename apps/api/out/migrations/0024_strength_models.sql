CREATE TABLE "strength_model_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"wcm" numeric(8, 6),
	"mpa" numeric(8, 2) NOT NULL,
	"included" boolean NOT NULL,
	"exclusion" text
);
--> statement-breakpoint
CREATE TABLE "strength_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"group_key" text NOT NULL,
	"grp" jsonb NOT NULL,
	"age_days" integer NOT NULL,
	"basis" text NOT NULL,
	"a" numeric(14, 6) NOT NULL,
	"b" numeric(14, 6) NOT NULL,
	"se_a" numeric(14, 6) NOT NULL,
	"se_b" numeric(14, 6) NOT NULL,
	"n" integer NOT NULL,
	"levels" integer NOT NULL,
	"wcm_min" numeric(8, 6) NOT NULL,
	"wcm_max" numeric(8, 6) NOT NULL,
	"s_mpa" numeric(14, 6) NOT NULL,
	"r2" numeric(10, 6) NOT NULL,
	"held_out" jsonb,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"fitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fitted_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"approval_signature" jsonb,
	"retired_at" timestamp with time zone,
	"retired_by" text,
	"retired_reason" text
);
--> statement-breakpoint
ALTER TABLE "strength_model_points" ADD CONSTRAINT "strength_model_points_model_id_strength_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."strength_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_model_points" ADD CONSTRAINT "strength_model_points_result_id_strength_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."strength_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_models" ADD CONSTRAINT "strength_models_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_models" ADD CONSTRAINT "strength_models_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_models" ADD CONSTRAINT "strength_models_fitted_by_users_id_fk" FOREIGN KEY ("fitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_models" ADD CONSTRAINT "strength_models_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_models" ADD CONSTRAINT "strength_models_retired_by_users_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strength_model_points_model_idx" ON "strength_model_points" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "strength_models_group_idx" ON "strength_models" USING btree ("tenant_id","group_key","fitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "strength_models_in_force_uq" ON "strength_models" USING btree ("tenant_id","group_key") WHERE "strength_models"."approved_at" is not null and "strength_models"."retired_at" is null;