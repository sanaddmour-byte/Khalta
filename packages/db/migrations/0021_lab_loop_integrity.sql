-- Lab loop integrity (M4.2): records are append-only; a batch instance only exists with a passing validator
-- (weights are never stored from a conversion the independent check disagreed with).
CREATE TRIGGER strength_results_append_only BEFORE UPDATE OR DELETE ON strength_results
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER batch_instances_append_only BEFORE UPDATE OR DELETE ON batch_instances
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
ALTER TABLE strength_results ADD CONSTRAINT strength_results_positive CHECK (result_mpa >= 0 AND age_days > 0);
--> statement-breakpoint
ALTER TABLE batch_instances ADD CONSTRAINT batch_instances_validator_passed CHECK (validator_status = 'pass');
