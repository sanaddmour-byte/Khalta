ALTER TABLE "strength_models" ADD COLUMN "chronological" jsonb;--> statement-breakpoint
ALTER TABLE "strength_models" ADD COLUMN "validation_report" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "strength_models" ADD COLUMN "fit_version" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "trial_batches" ADD COLUMN "retained_slump_mm" numeric(8, 1);--> statement-breakpoint
ALTER TABLE "trial_batches" ADD COLUMN "retention_minutes" integer;--> statement-breakpoint
ALTER TABLE "trial_batches" ADD COLUMN "stability" text;--> statement-breakpoint
ALTER TABLE "trial_batches" ADD COLUMN "placement_acceptable" boolean;