# CSV exchange contract

Versions: `khalta.designs.v1`, `khalta.batch-weights.v1`. The header rows below are **frozen**: any change of a header, a column's meaning, or the units is a new schema version, and a test fails if a header changes without it.

## Format (both files)

- UTF-8 **with a byte-order mark** (so Excel reads Arabic), comma delimiter, CRLF line ends, one header row.
- RFC 4180 quoting: a cell with a comma, a double quote, a CR or an LF is quoted; a double quote inside is doubled. Arabic and line breaks inside a quoted cell are preserved.
- `.` is the decimal point; no thousands separators; no exponent notation. Numbers are written exactly as stored (at most six places).
- Dates `YYYY-MM-DD`; timestamps ISO 8601 UTC (`2026-10-02T06:00:00.000Z`). Booleans `true` / `false`. Empty cell = not applicable or not stated.
- Text cells that start with `=`, `+`, `-`, `@`, a tab or a CR (and are not plain numbers) are written with a leading apostrophe so a spreadsheet keeps them as text. Numbers are never altered.
- Rows are ordered deterministically (plant, design code, version, line; batches by time then id): two exports of the same data are byte-identical.
- **No cost, price, margin or saving** appears in any column of either file.
- Each export is returned by an audited `POST` with the file's SHA-256 in `X-Khalta-Sha256` and its first eight characters in the file name.

## `khalta.designs.v1` — approved designs

One row per material line of every design that is **`approved` or `in_production`** at the plants the caller may see (`POST /api/exports/designs.csv`, body `{plantId?, designId?}`; capability `export.csv`). Suspended, retired, superseded, draft, evaluated and trial designs are never written.

| #    | Column                                | Meaning                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–17 | `design_code … avg_monthly_volume_m3` | The Appendix D columns, in order, so the legacy importer reads the shared fields (`approval_reference` is `Khalta v<n> <status> <date>`; `currently_in_production` is true for `in_production`; the average volume is the stored one). An import of this file is a **legacy, unattested** import, never an approval. |
| 18   | `schema`                              | `khalta.designs.v1`                                                                                                                                                                                                                                                                                                  |
| 19   | `version`                             | Design version                                                                                                                                                                                                                                                                                                       |
| 20   | `status`                              | `approved` or `in_production`                                                                                                                                                                                                                                                                                        |
| 21   | `approved_at`                         | UTC timestamp of the approval (or attestation)                                                                                                                                                                                                                                                                       |
| 22   | `approved_by`                         | Name of the approver                                                                                                                                                                                                                                                                                                 |
| 23   | `design_hash`                         | SHA-256 of the design version (code, version, plant, requirements, proportions): the same hash the e-signature binds to                                                                                                                                                                                              |
| 24   | `ruleset_mode`                        | `ACI`, `JS` or `BOTH`                                                                                                                                                                                                                                                                                                |
| 25   | `material_id`                         | Stable Khalta material id                                                                                                                                                                                                                                                                                            |
| 26   | `line_no`                             | 1-based line number in the design                                                                                                                                                                                                                                                                                    |
| 27   | `quantity_basis`                      | `kg/m3 SSD` (design quantities are SSD kg per m³; `unit` is always `kg/m3`)                                                                                                                                                                                                                                          |

Header: `design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3,schema,version,status,approved_at,approved_by,design_hash,ruleset_mode,material_id,line_no,quantity_basis`

`exposure_classes` is semicolon-separated. `material_name` is the plant's market name (English as stored).

## `khalta.batch-weights.v1` — saved production batch weights

One row per material line of a saved **production** batch instance whose independent check passed, for a design that is **still approved or in production** (`POST /api/exports/batch-weights.csv`, body `{instanceId}` or `{plantId, from?, to?}`). Trial instances are never written.

Header: `schema,batch_instance_id,design_code,design_version,plant_code,kind,created_at,created_by,check_verdict,check_version,material_id,material_name,material_category,line_no,kg_ssd,kg_oven_dry,kg_batch,free_water_kg,solution_water_kg,total_moisture_pct,absorption_pct,moisture_measured_at,design_water_kg,batch_water_kg,design_hash,basis`

- All masses are **per m³ of concrete**; the batching system scales to its batch size (`basis` says so).
- `kg_batch` is the mass to weigh (for the water line, the adjusted batch water). `free_water_kg` is negative when an aggregate is drier than SSD. `kg_oven_dry`, `free_water_kg`, `solution_water_kg`, and the moisture columns are filled only where they apply.
- `check_verdict` is always `pass` (the database refuses a batch instance without a passing independent check); `check_version` names the checker.
- `design_hash` ties the batch to the exact approved version.

## What the file is not

A copy for a batching system. It is not an approval, it does not carry prices, and a plant that loads an old file keeps what it loaded: compare `design_hash` and the audited SHA-256 with a fresh export.
