ALTER TABLE "batch_instances" ADD COLUMN "batch_size_m3" numeric(8, 3);--> statement-breakpoint
ALTER TABLE "batch_instances" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "batch_instances" ADD COLUMN "plan_validator" jsonb;--> statement-breakpoint
ALTER TABLE "batch_instances" ADD COLUMN "design_version_hash" text;--> statement-breakpoint
ALTER TABLE "batch_instances" ADD COLUMN "calc_version" jsonb;--> statement-breakpoint
ALTER TABLE "batch_instances" ADD COLUMN "material_test_versions" jsonb;--> statement-breakpoint
ALTER TABLE "batch_instances" ADD COLUMN "rounding" jsonb;