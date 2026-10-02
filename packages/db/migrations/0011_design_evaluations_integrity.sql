-- Evaluation integrity, enforced in the database independent of application code.

-- 1. A stored evaluation is a record of what was computed from what: never updated, never deleted.
CREATE TRIGGER design_evaluations_append_only BEFORE UPDATE OR DELETE ON design_evaluations
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint

-- 2. The three documents are JSON objects, and the denormalized "latest" columns move together.
ALTER TABLE design_evaluations ADD CONSTRAINT design_evaluations_documents_are_objects
  CHECK (jsonb_typeof(snapshot) = 'object' AND jsonb_typeof(report) = 'object' AND jsonb_typeof(validator) = 'object');
--> statement-breakpoint
ALTER TABLE mix_designs ADD CONSTRAINT mix_designs_last_evaluation_consistent
  CHECK ((last_evaluation_id IS NULL) = (last_verdict IS NULL) AND (last_evaluation_id IS NULL) = (last_evaluated_at IS NULL));
