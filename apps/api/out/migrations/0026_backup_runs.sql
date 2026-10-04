CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"storage" text NOT NULL,
	"object_key" text,
	"manifest_key" text,
	"bytes" bigint,
	"sha256" text,
	"pg_version" text,
	"app_version" text,
	"migration_count" integer,
	"retention_deleted" integer,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "backup_runs_started_idx" ON "backup_runs" USING btree ("started_at");