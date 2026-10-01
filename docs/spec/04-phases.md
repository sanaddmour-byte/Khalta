# Milestones and Definition of Done

Each milestone: write `docs/plans/<id>.md` → wait for approval → build → meet the global Definition of Done plus the milestone checks → update `docs/progress.md` → summarize and stop.

Every plan contains: business objective; in-scope and explicit exclusions; assumptions; dependencies and inputs; engineering-correctness risks; schema/API/UI impact; verification strategy; rollback/migration strategy.

| ID | Milestone | Scope | Milestone-specific Done | Needs from Sanad |
|---|---|---|---|---|
| M0.1 | Repo and tooling | Monorepo, TS strict, ESLint rules (strings, physical CSS, validator import boundary), Prettier, Vitest, Playwright, command contract, `docs/progress.md` | Every contract command runs (placeholder tests allowed) | — |
| M0.2 | Database, auth, RBAC, audit | Drizzle base schema, Better Auth, roles + plant scoping, audit log, four-eyes guard | RBAC matrix covered by API tests; audit row for every mutation | — |
| M0.3 | Design system and app shell | Tokens (light/dark), wrapped components, `/dev/components`, nav, plant switcher, palette, i18n + RTL, glossary | Quality gate passed on shell + component page | — |
| M0.4 | Rules package | Rule schema (`kind`, `requirement_class`, applicability), YAML loader, seeds from `02-codes.md`, Both/PROJECT resolver, Rules screen, verify flow, JS CSV import | `pnpm test:rules` validates schema and cross-checks seeds vs `02-codes.md`; resolver tests for every merge kind; ADR: rule normalization | Verify ACI seeds; JS values CSV; B-grade mapping |
| M1.1 | Materials and tests | Plants, suppliers, materials, tests (incl. admixture dosage tables, test expiry), gradation charts | FM computed and tested; drift detection tested | Test-age limits |
| M1.2 | Price matrix | Grid ADR, price history, price snapshots, bulk tools, Excel import/export, stale flags | Paste 20 × 200 from Excel < 2 s; history never overwritten | Approve grid ADR |
| M1.3 | Demo data, legacy import, staging | Demo generator (Appendix C), legacy import into `evaluated` + attestation queue, first Railway staging deploy | Staging live with demo data; legacy import round-trip test | Pilot plant; legacy designs file |
| M2.1 | Evaluator, compliance kernel, validator | Pure evaluate pipeline, f'cr, rule applicability, strength-evidence reporting, traces, `packages/validator` | Evaluate fixtures reproduce exactly; validator catches all corruption tests; property tests green; ≥ 90% coverage; ADR: lifecycle | 3–5 approved designs (Appendix B) |
| M2.2 | Mix intelligence pilot | Manual editor, legacy portfolio evaluation, attestation flow, cost baselines with price snapshots, data-quality blockers, theoretical entries in the ledger | E2E: import → evaluate → attest → baseline; pilot report lists opportunities as theoretical only; ADR: savings baseline | Attest pilot designs; volumes |
| M3.1 | Controlled optimizer | Baseline ACI 211.1 path, enumeration, documented formulation, model applicability, rounding + validator, hard-row diagnostics, guardrail shadow prices | ACI 211.1 golden test; adversarial tests pass; no hard-rule relaxation output anywhere; every candidate trial-only; ADR: solver + strength model | ACI 211.1 example; engineering parameters |
| M3.2 | Trial recommendation UX | Four-stage Studio with Evaluate/Generate paths, compare, evidence chips, traceability, validator report, request-trial | E2E: request → candidates → validator pass → `trial_candidate`; no optimizer-to-approved path | — |
| M4.1 | Library and lifecycle | Versioned library, diff, full §14.1 state machine, trial acceptance, change classes, e-signatures | Every illegal transition rejected (tested); approval blocked by unverified/null rules and four-eyes | Trial acceptance criteria; minor-adjustment policy |
| M4.2 | Lab loop and PDF | Trial batches, strength results, `batch_instances` + `validateBatch`, bilingual PDF with watermark rule | Moisture tests pass; PDF renders correct Arabic (visual snapshot) | Letterhead; moisture limits |
| M5.1 | Savings pilot + proactive insights | pg-boss workers, triggers (§8), debounce/dedupe, inbox, Savings screen, approved/realized states | One controlled pilot reconciles baseline → approval → actual volume → realized saving | Pilot production volumes |
| M5.2 | Strength intelligence | Model fitting with validity and held-out checks, s refit, low-strength alerts, β calibration proposal | Alert fires on the seeded low-strength sequence; model invalidation tests pass | — |
| M6.1 | Integration | Approved-design/batch-weight CSV exchange first; REST/OpenAPI ERP integration only after field mapping and pilot sign-off | CSV contract tests; API contract tests once the integration ADR is approved | ERP field mapping |
| M6.2 | Production | Production environment, backups, restore drill, runbooks | Restore drill executed and documented | Go-live approval |

(Section references such as §8 and §14.1 above point to `01-domain.md`.)
