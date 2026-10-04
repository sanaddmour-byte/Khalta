-- A stored batch plan always carries its independent check, its design-version hash and its materials' test versions,
-- and the plan check passed. (Instances saved before batch preparation have none of these and are v1-only.)
ALTER TABLE batch_instances ADD CONSTRAINT batch_instances_plan_complete
  CHECK (
    plan IS NULL
    OR (
      batch_size_m3 IS NOT NULL AND batch_size_m3 > 0
      AND plan_validator IS NOT NULL AND plan_validator->>'status' = 'pass'
      AND design_version_hash IS NOT NULL AND length(design_version_hash) = 64
      AND calc_version IS NOT NULL AND material_test_versions IS NOT NULL AND rounding IS NOT NULL
    )
  );
