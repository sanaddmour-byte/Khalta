-- Backup runs (M6.2): never hard-deleted; a finished run has a finish time, an ok one carries its object and hash.
CREATE TRIGGER backup_runs_no_delete BEFORE DELETE ON backup_runs
  FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_finished_has_time CHECK (status = 'running' OR finished_at IS NOT NULL);
--> statement-breakpoint
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_ok_has_object CHECK (status <> 'ok' OR (object_key IS NOT NULL AND manifest_key IS NOT NULL AND sha256 IS NOT NULL AND bytes IS NOT NULL));
--> statement-breakpoint
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_failed_has_error CHECK (status <> 'failed' OR error IS NOT NULL);
