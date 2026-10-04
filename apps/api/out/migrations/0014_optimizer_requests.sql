CREATE TABLE "design_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"configuration" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"overrides" jsonb NOT NULL,
	"guardrails" jsonb NOT NULL,
	"margins" jsonb NOT NULL,
	"binding" jsonb NOT NULL,
	"characteristics" jsonb NOT NULL,
	"deviations" jsonb NOT NULL,
	"notes" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"requires_authorization" boolean NOT NULL,
	"cost_jod_per_m3" numeric(12, 3),
	"objective_value" numeric(14, 6) NOT NULL,
	"validator" jsonb NOT NULL,
	"validator_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"objective" text NOT NULL,
	"request" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"optimizer_version" text NOT NULL,
	"solver" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mix_designs" ADD COLUMN "source_candidate_id" uuid;--> statement-breakpoint
ALTER TABLE "design_candidates" ADD CONSTRAINT "design_candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_candidates" ADD CONSTRAINT "design_candidates_request_id_design_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."design_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_requests" ADD CONSTRAINT "design_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_requests" ADD CONSTRAINT "design_requests_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_requests" ADD CONSTRAINT "design_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "design_candidates_request_rank_uq" ON "design_candidates" USING btree ("request_id","rank");--> statement-breakpoint
CREATE INDEX "design_requests_plant_idx" ON "design_requests" USING btree ("tenant_id","plant_id","created_at");--> statement-breakpoint
ALTER TABLE "mix_designs" ADD CONSTRAINT "mix_designs_source_candidate_id_design_candidates_id_fk" FOREIGN KEY ("source_candidate_id") REFERENCES "public"."design_candidates"("id") ON DELETE no action ON UPDATE no action;