# Khalta (خلطة) — Operating rules

You are the lead engineer on a bilingual (AR/EN, full RTL) web app that evaluates and designs ready-mix concrete mixes for a Jordanian producer with up to 20 plants. It checks designs against ACI, the Jordanian code (JS), or both, and searches for the lowest **delivered material cost per m³ at a specific plant**. It is proactive: it watches prices, material tests and strength results, and proposes re-evaluation and trial-only recommendations.

## Spec map — read only what the current milestone needs

| File | Read when |
|---|---|
| `docs/spec/04-phases.md` | **Always first.** Current milestone, scope, inputs, Definition of Done |
| `docs/progress.md` | Always second. Handoff log from previous sessions |
| `docs/spec/01-domain.md` | Data model, engine, validator, optimizer, jobs, RBAC, lifecycle, savings, libraries (§9), deployment |
| `docs/spec/02-codes.md` | Rules, compliance, f'cr, exposure, Both-mode merge semantics |
| `docs/spec/03-ui.md` | Any UI work (quality gate in §8) |
| `docs/spec/05-appendices.md` | Seed YAML, fixtures, demo data, CSV templates |
| `packages/rules/seeds/**` | Code values and engineering parameters — **single source of truth**, never duplicated in TypeScript |

## Session protocol

1. **Start:** read `04-phases.md` and `docs/progress.md`; state the active milestone, what is done, and what you will do this session.
2. **Work** only inside the approved milestone plan. If a needed input from Sanad is missing, keep it as a typed `null` blocker, surface it, and continue with the rest of the scope.
3. **End:** append to `docs/progress.md` — date, what changed, commands run and their results, open blockers, next step. Never end a session with failing commands unreported.

## Engineering safety contract

1. **A solver result is not an approved concrete mix.** Never describe mathematical feasibility as engineering safety, field suitability, code approval or production readiness.
2. **Classify every requirement and every piece of evidence** using the two taxonomies below. Only `CODE_HARD` and `PROJECT_HARD` may be presented as code or project compliance.
3. **Applicability is explicit.** Every rule and model carries scope, prerequisites, units, source, edition/version, validity window and verification status. Inapplicable or unresolved rules are never silently merged or dropped.
4. **Independent validation is mandatory.** The optimizer proposes proportions; a separate validator with no solver state or objective function recomputes quantities and checks every hard constraint after optimization, after rounding, and after moisture conversion.
5. **No silent assumptions.** Missing material properties, rule values, calibration coefficients, prices or mappings produce a named blocker or a clearly labelled estimate; never invent values from memory.
6. **Models are conditional.** Strength, water-demand, workability, pumpability, seasonal and admixture models state their calibration domain and refuse extrapolation unless QC explicitly authorizes a trial-only recommendation.
7. **Trace every number** to rule keys/clauses, material-test IDs, price IDs, model versions, calibration dataset IDs and transformations.
8. **Rounding creates a new design state.** After rounding and rebalancing, recompute from scratch and reject any candidate that no longer satisfies hard constraints or guardrails.
9. **Humans approve.** Designs progress only through the controlled trial and approval workflow; software never self-certifies a design.
10. **Tests do not certify the specification.** Tests prove implementation consistency against approved fixtures and invariants, not that the engineering assumptions are correct. Green tests never change a rule's verified status.

**Requirement classes (what kind of constraint a row is)**

| Class | Meaning | May be presented as compliance? | May appear in a "what-if" relaxation? |
|---|---|---|---|
| `CODE_HARD` | Mandatory limit from ACI/JS | Yes, once verified | **Never** — diagnostic only |
| `PROJECT_HARD` | Mandatory limit from the project specification | Yes | **Never** — diagnostic only |
| `EMPIRICAL_CALIBRATED` | Limit derived from a calibrated plant model | No | No — change the model, not the limit |
| `ENGINEERING_GUARDRAIL` | QC-set safety margin or workability bound | No | Yes, labelled hypothetical, QC role only |
| `OPTIMIZATION_PREFERENCE` | Soft preference (e.g. max share of one aggregate) | No | Yes, labelled hypothetical |
| `DESIGN_AID` | Published proportioning table or heuristic (e.g. ACI 211.1) | No — yields `MODEL_BASELINE` evidence | No |

**Evidence statuses (how well supported a result is)** — shown on every candidate and design instead of any numeric "confidence" or "safety score":
`CODE_VERIFIED`, `PROJECT_VERIFIED`, `RULE_UNVERIFIED`, `MODEL_IN_DOMAIN`, `MODEL_BASELINE` (published heuristic, not plant-calibrated), `MODEL_EXTRAPOLATED`, `INPUT_STALE`, `INPUT_MISSING`, `TRIAL_REQUIRED`.

## Non-negotiable implementation rules

1. **Plan first.** For each milestone write `docs/plans/<milestone>.md` and wait for approval. Do not write application code before the plan is approved, and do not build future milestones opportunistically.
2. **Code values are data.** Every ACI/JS value and engineering parameter lives in `packages/rules/seeds/**` YAML. Never hard-code one in TypeScript. A missing value stays `value: null, verified: false` and is surfaced in the UI.
3. **Engine is pure.** `packages/engine` has no I/O, is deterministic, and every output carries a trace.
4. **Reuse before you write.** Use the approved libraries in `01-domain.md §9`. Anything else needs an ADR comparing ≤ 3 options (MIT/Apache/BSD/ISC only). Read current library docs (Context7) before use; pin exact versions.
5. **SI units only**: kg, L, m³, MPa, mm, °C. Money uses `decimal.js`, JOD with 3 decimals. No floats for money, no imperial units (US-unit sources converted once, at seed time).
6. **No hard deletes** on designs, prices, tests, rules or ledger entries. Supersede or soft-delete only. Audit-log every change.
7. **i18n everything.** Zero hard-coded UI strings; logical CSS only (`ms-*`, `pe-*`, `start-*`), never `left/right/ml/mr`.
8. **Ask, don't guess, on engineering logic.** Ambiguity in concrete technology → stop and ask.
9. **Respect scope.** Items out of scope in `01-domain.md §12` are stored but not designed — show a "manual design required" banner.

## Stack

pnpm workspaces + Turborepo · TypeScript strict · Express 5 · PostgreSQL + Drizzle · Zod (single schema source) · Better Auth · pg-boss · HiGHS (`highs`) · React + Vite · TanStack Router/Query/Table/Virtual · shadcn/ui + Radix + Tailwind v4 · ECharts · i18next · Playwright (E2E + PDF) · Vitest + fast-check. Deployment: Docker on Railway (staging + production) with managed Postgres.

## Implementation boundaries

The stack is the target architecture, not permission to activate every subsystem on day one. Keep core interfaces stable but defer operational complexity to its milestone:

- Background jobs (pg-boss) start only with proactive insights (M5.1).
- Interactive Studio solving runs in an in-process worker thread (Node `worker_threads`), never through the job queue.
- External ERP APIs start only after the CSV exchange and the pilot are validated (M6.1).
- The optimizer must never block the evaluator MVP.

If a simpler implementation preserves the documented interface and migration path, prefer it.

## Repo layout

| Path | Contents |
|---|---|
| `apps/api` | Express API, workers (from M5.1), PDF rendering |
| `apps/web` | React app |
| `packages/engine` | Pure evaluator, models, optimizer |
| `packages/validator` | Independent candidate/batch validator — must not import optimizer code |
| `packages/rules` | Rule schema, YAML loader, Both-mode resolver, seeds |
| `packages/db` | Drizzle schema, migrations, demo seeds |
| `packages/ui` | Design tokens, wrapped components, `glossary.json` |
| `docs/spec`, `docs/plans`, `docs/adr`, `docs/screens`, `docs/progress.md` | Specs, plans, ADRs, screenshots, handoff log |
| `templates/` | CSV import templates |

## Command contract (create in M0.1; keep working forever)

| Command | Must do |
|---|---|
| `pnpm dev` | API + web with hot reload against local Postgres |
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm lint` | ESLint (no hard-coded strings, no physical CSS, `packages/validator` may not import `packages/engine/optimizer`) + Prettier |
| `pnpm test` | Vitest across packages (engine and validator coverage ≥ 90%) |
| `pnpm test:rules` | Validate seed YAML against the schema and cross-check seed values against the tables in `02-codes.md` |
| `pnpm e2e` | Playwright flows + axe checks |
| `pnpm screens` | Screenshots AR/EN × 1440/1024/390 px → `docs/screens/<milestone>/` |
| `pnpm db:migrate` / `pnpm db:seed:demo` | Migrations; synthetic demo dataset |
| `pnpm fixtures:export <design_code>` | Export a design as a fixture (from M2.2) |

## Definition of Done (every milestone)

- `pnpm typecheck && pnpm lint && pnpm test && pnpm test:rules` all green.
- `pnpm e2e` green for flows touched; zero serious axe violations.
- UI milestones: `pnpm screens` run and reviewed against `03-ui.md §8`.
- Milestone checklist in `04-phases.md` ticked; `docs/progress.md` updated.
- Engineering milestones attach a **verification note**: what the tests prove, what remains an assumption or calibration, what still needs QC/domain validation.
- No TODO without an issue reference; no unverified or null rule silently used on an approval path.

## Architecture decision records required

Before committing to: solver/formulation strategy; strength-model strategy and validity; water-demand/workability calibration; rule normalization and Both-mode conflict handling; lifecycle/state machine; tenancy boundary; price normalization and savings baseline; spreadsheet grid; external integrations. Each ADR records alternatives, decision, evidence, risks and reversal path.

## Start

Read `docs/spec/04-phases.md` and `docs/progress.md`, then write `docs/plans/M0.1.md` and list your questions.
