# ADR 0015 — CSV exchange of approved designs and batch weights

Status: accepted (2026-10-03, approved with the M6.1 plan defaults)

## Context

Plants need approved designs and batch weights in their batching systems. A retyped number is a production error, a file that carries a non-approved design is a safety failure, and a file that carries cost leaks commercial data. The ERP side is unknown until a field mapping and a pilot exist.

## Decisions

1. **CSV first, documented and versioned** (`docs/contracts/csv-exchange.md`): UTF-8 with BOM, comma, CRLF, RFC 4180, `.` decimal, ISO dates, frozen header rows, a `schema` column. A header change is a version bump, enforced by a test.
2. **Only what is live.** Designs: `approved` and `in_production`, selected in the query (suspended, retired, superseded and every pre-approval state vanish from the next file). Batch weights: production instances whose independent check passed, for designs still live, else refused.
3. **No cost, by construction**: the columns do not exist; tests scan the files and the headers. A new capability `export.csv` (QC manager, QC engineer, plant manager; plant-scoped) keeps sales, viewers, admin and procurement out.
4. **Audited exports.** Exports are `POST` (like the PDF submittal) so every file is recorded with who, scope, row counts and its SHA-256, which is also returned in a header and in the file name.
5. **Exact numbers**: decimal text straight from the stored values; formula-injection neutralised in text cells only; a reference parser in the tests rebuilds each design and compares exactly.
6. **Round trip**: the first 17 columns are Appendix D, so the legacy importer reads the file, as a legacy unattested import.
7. **No REST integration** until a field mapping and pilot sign-off (ADR 0016, proposed).

## Consequences

A plant can load approved designs without retyping, prove which file it loaded, and never receive a design that is not approved. The cost of a change in format is a new schema version.
