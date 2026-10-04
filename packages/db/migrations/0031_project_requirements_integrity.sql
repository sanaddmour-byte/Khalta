-- Project requirements (a versioned record): never deleted; a verified revision is immutable and was verified by
-- someone other than its author; a design's frozen requirements are immutable with the design version.
CREATE TRIGGER project_requirements_no_delete BEFORE DELETE ON project_requirements
  FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE FUNCTION khalta_project_requirements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_ref IS DISTINCT FROM OLD.project_ref
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
  THEN
    RAISE EXCEPTION 'project requirements revision identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'verified' THEN
      IF NEW.verified_by IS NULL OR NEW.verified_at IS NULL OR NEW.verification IS NULL THEN
        RAISE EXCEPTION 'a verified revision records who verified it, when, and the signature'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.verified_by = OLD.created_by THEN
        RAISE EXCEPTION 'four-eyes: the author of a revision cannot verify it' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a draft revision can only be verified' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- verified or superseded: the content is frozen; only verified -> superseded is allowed
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verification IS DISTINCT FROM OLD.verification
  THEN
    RAISE EXCEPTION 'a verified revision is immutable; create a new revision' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'verified' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'a % revision cannot become %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_requirements_guard BEFORE UPDATE ON project_requirements
  FOR EACH ROW EXECUTE FUNCTION khalta_project_requirements_guard();
--> statement-breakpoint
ALTER TABLE project_requirements ADD CONSTRAINT project_requirements_revision_positive CHECK (revision >= 1);
--> statement-breakpoint
ALTER TABLE project_requirements ADD CONSTRAINT project_requirements_verified_has_signer
  CHECK (status = 'draft' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND verification IS NOT NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION khalta_design_inputs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.plant_id IS DISTINCT FROM OLD.plant_id
     OR NEW.requirements IS DISTINCT FROM OLD.requirements
     OR NEW.requirements_revision_id IS DISTINCT FROM OLD.requirements_revision_id
     OR NEW.requirements_frozen IS DISTINCT FROM OLD.requirements_frozen
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
