-- Strength models (M5.2): a model in force carries its approver and e-signature; the fit's points are append-only;
-- models are never hard-deleted (a retired one keeps its history).
ALTER TABLE strength_models ADD CONSTRAINT strength_models_approved_has_signature CHECK (
  approved_at IS NULL OR (approved_by IS NOT NULL AND approval_signature IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE strength_models ADD CONSTRAINT strength_models_retired_has_reason CHECK (
  retired_at IS NULL OR (retired_by IS NOT NULL AND retired_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TRIGGER strength_models_no_delete BEFORE DELETE ON strength_models
  FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint
CREATE TRIGGER strength_model_points_append_only BEFORE UPDATE OR DELETE ON strength_model_points
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
