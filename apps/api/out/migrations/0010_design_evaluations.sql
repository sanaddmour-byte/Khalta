CREATE TABLE "design_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"validator" jsonb NOT NULL,
	"validator_status" text NOT NULL,
	"verdict" text NOT NULL,
	"provisional" boolean NOT NULL,
	"minimum_data_ok" boolean NOT NULL,
	"cost_jod_per_m3" numeric(12, 3),
	"price_basis" jsonb NOT NULL,
	"rule_versions" jsonb NOT NULL,
	"evaluator_version" text NOT NULL,
	"validator_version" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mix_designs" ADD COLUMN "needs_revalidation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mix_designs" ADD COLUMN "last_evaluation_id" uuid;--> statement-breakpoint
ALTER TABLE "mix_designs" ADD COLUMN "last_verdict" text;--> statement-breakpoint
ALTER TABLE "mix_designs" ADD COLUMN "last_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "design_evaluations" ADD CONSTRAINT "design_evaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_evaluations" ADD CONSTRAINT "design_evaluations_design_id_mix_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."mix_designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_evaluations" ADD CONSTRAINT "design_evaluations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_evaluations_design_idx" ON "design_evaluations" USING btree ("design_id","created_at");--> statement-breakpoint
ALTER TABLE "mix_designs" ADD CONSTRAINT "mix_designs_last_evaluation_id_design_evaluations_id_fk" FOREIGN KEY ("last_evaluation_id") REFERENCES "public"."design_evaluations"("id") ON DELETE no action ON UPDATE no action;