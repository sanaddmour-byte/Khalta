# ADR 0011 — The approval gate, typed e-signatures and versioned supersede

Status: accepted (2026-10-02, approved with the M4.1 plan defaults)

## Context

"Approved" must mean that a person other than the author, looking at current evidence, accepted a design that passed a trial. The safety contract applies: no path from the optimizer to `approved` without a trial (legacy attestation aside), every move names its evidence, humans approve, no silent assumptions.

## Options

| Option                                                     | For                                                     | Against                                        |
| ---------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| A. Status field edited by the API only                     | Simple                                                  | Any code path or SQL can skip a gate           |
| B. Graph in the engine, gates as a pure function, DB guard | One definition, testable, the database refuses the rest | Graph edges are listed twice (engine, trigger) |
| C. External workflow engine                                | Rich                                                    | Out of proportion; another system to trust     |

## Decision

1. **Option B.** `canTransition` (engine) decides legality and evidence; `checkApprovalGates` and `evaluateTrialAcceptance` are pure and return **every** unmet gate. The server gathers facts and stores the answer in `design_transitions` (append-only) with the typed e-signature. A trigger (`khalta_design_status_guard`) refuses any status change that is not an edge of the §14.1 graph, and a CHECK refuses a Khalta approval whose approver is missing or is the author.
2. **Gates for `approved`:** trial passed; approver ≠ author; the independent validator agrees on a fresh evaluation; the verdict is `pass`; every governing rule verified and nothing provisional; evidence current (rule and test versions equal those of the stored evaluation); declared key values accepted or absent (`approval_requires_lab_source`, now **on by default** as the spec says).
3. **Trial acceptance** is judged on the latest batch against QC-configured parameters seeded **unset**; a missing parameter is named and blocks `trial_passed`. Batch _entry_ is M4.2; the table (`trial_batches`) exists now so the gates are real and testable, written only by test fixtures until then.
4. **E-signature** = signer, role, meaning, reason, time and a SHA-256 of the design's identity, requirements and proportions. It binds the act to the exact version and claims no legal validity.
5. **Versions** reuse M2.2 (`POST /designs/:id/versions`, diff). Approving a version supersedes its parent (approved / in production / suspended) with `new_version_approved` evidence. The diff carries the §14.3 change class; proportion and admixture changes require a trial (minor-adjustment policy: none).
6. **Declared values:** a QC manager's e-signed acceptance is stored per design (`design_acceptances`, append-only) and covers the materials declared at that moment; a new declaration needs a new acceptance.

## Consequences

- A design cannot be approved by editing a row; the database says no.
- Until M4.2 no real design can enter `trial_in_progress`; the UI says so.
- A typed version (not an optimizer candidate) cannot become a trial candidate (the graph requires validator evidence from a candidate); this is the M3.2 limitation, unchanged.
