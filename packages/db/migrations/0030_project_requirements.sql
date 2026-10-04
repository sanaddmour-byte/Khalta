CREATE TABLE "project_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_ref" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"supersedes_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"verification" jsonb,
	"superseded_at" timestamp with time zone,
	"superseded_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "mix_designs" ADD COLUMN "requirements_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "mix_designs" ADD COLUMN "requirements_frozen" jsonb;--> statement-breakpoint
ALTER TABLE "project_requirements" ADD CONSTRAINT "project_requirements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requirements" ADD CONSTRAINT "project_requirements_supersedes_id_project_requirements_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."project_requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requirements" ADD CONSTRAINT "project_requirements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requirements" ADD CONSTRAINT "project_requirements_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requirements" ADD CONSTRAINT "project_requirements_superseded_by_id_project_requirements_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."project_requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_requirements_rev_uq" ON "project_requirements" USING btree ("tenant_id","project_ref","revision");--> statement-breakpoint
CREATE INDEX "project_requirements_ref_idx" ON "project_requirements" USING btree ("tenant_id","project_ref","status");--> statement-breakpoint
ALTER TABLE "mix_designs" ADD CONSTRAINT "mix_designs_requirements_revision_id_project_requirements_id_fk" FOREIGN KEY ("requirements_revision_id") REFERENCES "public"."project_requirements"("id") ON DELETE no action ON UPDATE no action;