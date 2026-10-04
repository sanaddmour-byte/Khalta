CREATE TABLE "design_request_supersessions" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"superseded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_candidates" ADD COLUMN "solve" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "design_request_supersessions" ADD CONSTRAINT "design_request_supersessions_request_id_design_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."design_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_request_supersessions" ADD CONSTRAINT "design_request_supersessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_request_supersessions" ADD CONSTRAINT "design_request_supersessions_superseded_by_design_requests_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."design_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_request_supersessions_by_idx" ON "design_request_supersessions" USING btree ("superseded_by");--> statement-breakpoint
-- Append-only like the requests themselves; a request cannot replace itself.
ALTER TABLE "design_request_supersessions" ADD CONSTRAINT "design_request_supersessions_distinct_chk"
  CHECK ("request_id" <> "superseded_by");--> statement-breakpoint
CREATE TRIGGER design_request_supersessions_append_only BEFORE UPDATE OR DELETE ON "design_request_supersessions"
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
