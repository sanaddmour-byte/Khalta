-- Proactive engine integrity (M5.1): history is append-only; ledger entries carry what their state needs.
CREATE TRIGGER insight_events_append_only BEFORE UPDATE OR DELETE ON insight_events
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER insights_no_delete BEFORE DELETE ON insights
  FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER daily_digests_append_only BEFORE UPDATE OR DELETE ON daily_digests
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER savings_entries_no_delete BEFORE DELETE ON savings_entries
  FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
-- M2.2 allowed only theoretical entries; M5.1 adds approved and realized (replaced by the stronger check below).
ALTER TABLE savings_entries DROP CONSTRAINT savings_entries_theoretical_only;
--> statement-breakpoint
-- A theoretical entry must save something; an approved or realized one may be negative (it is a measurement).
ALTER TABLE savings_entries DROP CONSTRAINT savings_entries_positive_saving;
--> statement-breakpoint
ALTER TABLE savings_entries ADD CONSTRAINT savings_entries_theoretical_positive CHECK (state <> 'theoretical' OR saving_jod_per_m3 > 0);
--> statement-breakpoint
-- A theoretical entry stands on a stored evaluation; an approved or realized one on two costs at ONE snapshot;
-- a realized one also on a month and a produced volume.
ALTER TABLE savings_entries ADD CONSTRAINT savings_entries_state_evidence CHECK (
  (state = 'theoretical' AND variant_evaluation_id IS NOT NULL)
  OR (state = 'approved' AND baseline_cost_jod_per_m3 IS NOT NULL AND replacement_cost_jod_per_m3 IS NOT NULL)
  OR (state = 'realized' AND baseline_cost_jod_per_m3 IS NOT NULL AND replacement_cost_jod_per_m3 IS NOT NULL
      AND total_jod IS NOT NULL AND period IS NOT NULL AND produced_volume_m3 IS NOT NULL)
);
