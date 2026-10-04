-- Optimizer requests and candidates are records: append-only, never deleted. A candidate stored for a
-- request always passed the independent candidate validator; the source candidate of a design is set once.
CREATE TRIGGER design_requests_append_only BEFORE UPDATE OR DELETE ON design_requests
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER design_candidates_append_only BEFORE UPDATE OR DELETE ON design_candidates
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
ALTER TABLE design_candidates ADD CONSTRAINT design_candidates_validated CHECK (validator_status = 'pass');
--> statement-breakpoint
ALTER TABLE design_candidates ADD CONSTRAINT design_candidates_rank_positive CHECK (rank >= 1);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION khalta_design_inputs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.plant_id IS DISTINCT FROM OLD.plant_id
     OR NEW.requirements IS DISTINCT FROM OLD.requirements
     OR NEW.inputs_snapshot IS DISTINCT FROM OLD.inputs_snapshot
     OR NEW.imported_approval_ref IS DISTINCT FROM OLD.imported_approval_ref
     OR NEW.imported_in_production IS DISTINCT FROM OLD.imported_in_production
     OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id
     OR NEW.source_candidate_id IS DISTINCT FROM OLD.source_candidate_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'design % inputs are immutable; create a new version instead', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
