-- Baselines and the savings ledger are records: append-only, never deleted, and the ledger can only hold
-- what has been established so far (theoretical, with a positive saving).
CREATE TRIGGER cost_baselines_append_only BEFORE UPDATE OR DELETE ON cost_baselines
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER savings_entries_append_only BEFORE UPDATE OR DELETE ON savings_entries
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
ALTER TABLE savings_entries ADD CONSTRAINT savings_entries_positive_saving CHECK (saving_jod_per_m3 > 0);
--> statement-breakpoint
ALTER TABLE savings_entries ADD CONSTRAINT savings_entries_theoretical_only CHECK (state = 'theoretical');
--> statement-breakpoint
ALTER TABLE cost_baselines ADD CONSTRAINT cost_baselines_cost_not_negative CHECK (cost_jod_per_m3 >= 0);
