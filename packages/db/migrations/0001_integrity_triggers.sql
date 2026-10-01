-- Integrity rules enforced in the database, independent of application code.

-- 1. audit_log is append-only.
CREATE FUNCTION khalta_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% not allowed)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint

-- 2. No hard deletes on business tables (CLAUDE.md rule 6): soft-delete via deleted_at instead.
CREATE FUNCTION khalta_no_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hard delete on % is not allowed; set deleted_at instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenants_no_delete BEFORE DELETE ON tenants FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER users_no_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER plants_no_delete BEFORE DELETE ON plants FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER user_plants_no_delete BEFORE DELETE ON user_plants FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER suppliers_no_delete BEFORE DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER tenant_settings_no_delete BEFORE DELETE ON tenant_settings FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
