-- Design integrity, enforced in the database independent of application code.

-- 1. Never hard-deleted; transitions, lines and volumes are append-only.
CREATE TRIGGER mix_designs_no_delete BEFORE DELETE ON mix_designs FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER legacy_import_batches_no_delete BEFORE DELETE ON legacy_import_batches FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER design_transitions_append_only BEFORE UPDATE OR DELETE ON design_transitions
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER mix_design_lines_append_only BEFORE UPDATE OR DELETE ON mix_design_lines
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER production_volumes_no_delete BEFORE DELETE ON production_volumes FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint

-- 2. A design's imported inputs are immutable: only status/approval bookkeeping may change.
CREATE FUNCTION khalta_design_inputs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'design % inputs are immutable; create a new version instead', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mix_designs_inputs_immutable BEFORE UPDATE ON mix_designs FOR EACH ROW EXECUTE FUNCTION khalta_design_inputs_immutable();
--> statement-breakpoint

-- 3. A legacy-attested design always names who attested it and which external approval it rests on.
ALTER TABLE mix_designs ADD CONSTRAINT mix_designs_attested_needs_evidence
  CHECK (approval_source IS DISTINCT FROM 'legacy_attested'
         OR (external_approval_ref IS NOT NULL AND length(trim(external_approval_ref)) > 0
             AND approved_by IS NOT NULL AND approved_at IS NOT NULL));
--> statement-breakpoint
-- 4. Approved or in-production states always carry an approval source.
ALTER TABLE mix_designs ADD CONSTRAINT mix_designs_approved_needs_source
  CHECK (status NOT IN ('approved', 'in_production') OR approval_source IS NOT NULL);
