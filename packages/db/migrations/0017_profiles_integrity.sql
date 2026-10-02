-- Profiles are records. Versions never change except that a draft may be approved once, by someone other than
-- its author; nothing is deleted.
CREATE TRIGGER characteristic_profiles_no_delete BEFORE DELETE ON characteristic_profiles
  FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE FUNCTION khalta_profile_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'profile versions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'approved profile version % is immutable; create a new version', OLD.version
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.applies_to IS DISTINCT FROM OLD.applies_to
     OR NEW.characteristics IS DISTINCT FROM OLD.characteristics
     OR NEW.materials IS DISTINCT FROM OLD.materials
     OR NEW.objective IS DISTINCT FROM OLD.objective
     OR NEW.ruleset_mode IS DISTINCT FROM OLD.ruleset_mode
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'profile version content is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER characteristic_profile_versions_guard BEFORE UPDATE OR DELETE ON characteristic_profile_versions
  FOR EACH ROW EXECUTE FUNCTION khalta_profile_version_guard();
--> statement-breakpoint
ALTER TABLE characteristic_profile_versions ADD CONSTRAINT profile_version_four_eyes
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by IS DISTINCT FROM created_by));
