-- Materials integrity, enforced in the database independent of application code.

-- 1. Never hard-deleted.
CREATE TRIGGER materials_no_delete BEFORE DELETE ON materials FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER material_tests_no_delete BEFORE DELETE ON material_tests FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint

-- 2. Evidence files are immutable and never deleted.
CREATE TRIGGER attachments_no_update_delete BEFORE UPDATE OR DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint

-- 3. A test version's CONTENT is immutable: a correction is a new version. Only bookkeeping
--    (is_current, superseded_at) may change in place.
CREATE FUNCTION khalta_material_test_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.material_id IS DISTINCT FROM OLD.material_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.field_sources IS DISTINCT FROM OLD.field_sources
     OR NEW.properties IS DISTINCT FROM OLD.properties
     OR NEW.tested_at IS DISTINCT FROM OLD.tested_at
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.lab_ref IS DISTINCT FROM OLD.lab_ref
     OR NEW.attachment_id IS DISTINCT FROM OLD.attachment_id
     OR NEW.declared_reason IS DISTINCT FROM OLD.declared_reason
     OR NEW.declared_by IS DISTINCT FROM OLD.declared_by
     OR NEW.declared_at IS DISTINCT FROM OLD.declared_at
     OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'material test v% content is immutable; insert a new version instead', OLD.version
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER material_tests_content_immutable BEFORE UPDATE ON material_tests FOR EACH ROW EXECUTE FUNCTION khalta_material_test_immutable();
--> statement-breakpoint

-- 4. Evidence rules: a lab report needs its file; anything user-declared records who declared it.
ALTER TABLE material_tests ADD CONSTRAINT material_tests_lab_needs_attachment
  CHECK (source <> 'lab_report' OR attachment_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE material_tests ADD CONSTRAINT material_tests_declared_needs_author
  CHECK (source <> 'user_declared' OR (declared_by IS NOT NULL AND declared_at IS NOT NULL));
--> statement-breakpoint
ALTER TABLE attachments ADD CONSTRAINT attachments_size_limit CHECK (size_bytes > 0 AND size_bytes <= 10485760);
