-- Lifecycle integrity, enforced in the database independent of application code (M4.1).

-- 1. A design's status may only change along an edge of the §14.1 graph. The service decides gates and
--    evidence; this refuses everything the graph does not contain, whatever code asks.
CREATE FUNCTION khalta_design_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('draft','evaluated'), ('evaluated','draft'),
      ('evaluated','trial_candidate'), ('draft','trial_candidate'),
      ('trial_candidate','trial_in_progress'), ('trial_in_progress','trial_passed'),
      ('trial_passed','approved'), ('draft','approved'), ('evaluated','approved'),
      ('approved','in_production'),
      ('approved','suspended'), ('in_production','suspended'),
      ('suspended','approved'), ('suspended','in_production'),
      ('approved','superseded'), ('in_production','superseded'), ('suspended','superseded'),
      ('draft','retired'), ('evaluated','retired'), ('trial_candidate','retired'),
      ('trial_in_progress','retired'), ('trial_passed','retired'), ('approved','retired'),
      ('in_production','retired'), ('suspended','retired')
    ) AS edge(f, t) WHERE edge.f = OLD.status AND edge.t = NEW.status
  ) THEN
    RAISE EXCEPTION 'design % cannot move from % to %', OLD.code, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mix_designs_status_guard BEFORE UPDATE ON mix_designs
  FOR EACH ROW EXECUTE FUNCTION khalta_design_status_guard();
--> statement-breakpoint

-- 2. Approval through Khalta is four-eyes: the approver is named, dated, and is not the author.
ALTER TABLE mix_designs ADD CONSTRAINT mix_designs_khalta_approval_four_eyes
  CHECK (approval_source IS DISTINCT FROM 'khalta'
         OR (approved_by IS NOT NULL AND approved_at IS NOT NULL
             AND approved_by IS DISTINCT FROM created_by));
--> statement-breakpoint

-- 3. Trial batches and acceptances are records: never edited or deleted.
CREATE TRIGGER trial_batches_append_only BEFORE UPDATE OR DELETE ON trial_batches
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER design_acceptances_append_only BEFORE UPDATE OR DELETE ON design_acceptances
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
