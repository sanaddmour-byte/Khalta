-- Price integrity, enforced in the database independent of application code.

-- 1. Live price periods for one (material, plant, supplier) never overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE material_prices ADD CONSTRAINT material_prices_no_overlap
  EXCLUDE USING gist (
    material_id WITH =, plant_id WITH =, supplier_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (superseded_at IS NULL);
--> statement-breakpoint
ALTER TABLE material_prices ADD CONSTRAINT material_prices_period_valid
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
--> statement-breakpoint
ALTER TABLE material_prices ADD CONSTRAINT material_prices_positive CHECK (price >= 0);
--> statement-breakpoint

-- 2. History is never overwritten: only closing a period (effective_to) and superseding it may change.
CREATE FUNCTION khalta_price_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.material_id IS DISTINCT FROM OLD.material_id
     OR NEW.plant_id IS DISTINCT FROM OLD.plant_id
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.price IS DISTINCT FROM OLD.price
     OR NEW.unit IS DISTINCT FROM OLD.unit
     OR NEW.includes_delivery IS DISTINCT FROM OLD.includes_delivery
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.entered_by IS DISTINCT FROM OLD.entered_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
     OR (OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to)
  THEN
    RAISE EXCEPTION 'a price record is immutable; enter a new price instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER material_prices_immutable BEFORE UPDATE ON material_prices FOR EACH ROW EXECUTE FUNCTION khalta_price_immutable();
--> statement-breakpoint
CREATE TRIGGER material_prices_no_delete BEFORE DELETE ON material_prices FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
--> statement-breakpoint

-- 3. Snapshots are append-only.
CREATE TRIGGER price_snapshots_append_only BEFORE UPDATE OR DELETE ON price_snapshots
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER price_snapshot_lines_append_only BEFORE UPDATE OR DELETE ON price_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION khalta_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER price_import_batches_no_delete BEFORE DELETE ON price_import_batches FOR EACH ROW EXECUTE FUNCTION khalta_no_hard_delete();
