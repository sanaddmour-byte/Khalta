-- Rules integrity, enforced in the database independent of application code.

-- 1. Verification history is append-only (same pattern as audit_log).
CREATE TRIGGER rule_verifications_no_update_delete BEFORE UPDATE OR DELETE ON rule_verifications
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER rule_verifications_no_truncate BEFORE TRUNCATE ON rule_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint

-- 2. Rules and rulesets are never hard-deleted (supersede instead).
CREATE TRIGGER rules_no_delete BEFORE DELETE ON rules FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER rulesets_no_delete BEFORE DELETE ON rulesets FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER rule_import_batches_no_delete BEFORE DELETE ON rule_import_batches FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint

-- 3. A rule version's CONTENT is immutable: a checked value can never be silently altered.
--    Only bookkeeping may change in place (is_current, superseded_at, verified, verified_by, verified_at).
CREATE FUNCTION khalta_rule_content_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.ruleset_id IS DISTINCT FROM OLD.ruleset_id
     OR NEW.requirement IS DISTINCT FROM OLD.requirement
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.requirement_class IS DISTINCT FROM OLD.requirement_class
     OR NEW.applies_to IS DISTINCT FROM OLD.applies_to
     OR NEW.prerequisites IS DISTINCT FROM OLD.prerequisites
     OR NEW.value IS DISTINCT FROM OLD.value
     OR NEW.definition IS DISTINCT FROM OLD.definition
     OR NEW.inherits IS DISTINCT FROM OLD.inherits
     OR NEW.units IS DISTINCT FROM OLD.units
     OR NEW.clause_ref IS DISTINCT FROM OLD.clause_ref
     OR NEW.origin IS DISTINCT FROM OLD.origin
  THEN
    RAISE EXCEPTION 'rule % v% content is immutable; insert a new version instead', OLD.key, OLD.version
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rules_content_immutable BEFORE UPDATE ON rules FOR EACH ROW EXECUTE FUNCTION khalta_rule_content_immutable();
--> statement-breakpoint

-- 4. Nothing without a value can be marked verified.
ALTER TABLE rules ADD CONSTRAINT rules_verified_needs_value
  CHECK (NOT verified OR value IS NOT NULL OR definition IS NOT NULL OR inherits IS NOT NULL);
