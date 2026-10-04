CREATE TABLE "design_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"materials" jsonb NOT NULL,
	"esignature" jsonb NOT NULL,
	"accepted_by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trial_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"batched_on" date NOT NULL,
	"slump_mm" numeric(8, 1),
	"air_pct" numeric(5, 2),
	"temperature_c" numeric(5, 1),
	"fresh_density_kg_m3" numeric(8, 1),
	"yield_m3" numeric(6, 3),
	"strength_mpa" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_transitions" ADD COLUMN "esignature" jsonb;--> statement-breakpoint
ALTER TABLE "design_acceptances" ADD CONSTRAINT "design_acceptances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_acceptances" ADD CONSTRAINT "design_acceptances_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_acceptances" ADD CONSTRAINT "design_acceptances_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_batches" ADD CONSTRAINT "trial_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_batches" ADD CONSTRAINT "trial_batches_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_batches" ADD CONSTRAINT "trial_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_acceptances_design_idx" ON "design_acceptances" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "trial_batches_design_idx" ON "trial_batches" USING btree ("design_id","batched_on");