# ADR 0018 — Cement classification: labels, never rules

Status: accepted (2026-10-03, approved with the M7.1 plan defaults)

## Context

Jordanian cement is bought by market name: a strength class (32.5, 42.5, 52.5) and a type (OPC, PPC, SRC, low alkali) and, separately, white cement in the same three classes. Until now a cement was one free-text `cement_type`. Nothing could filter, show or group by what plant staff actually call it.

## Decisions

1. **Labels, not rules.** `cement_kind` (`opc`, `ppc`, `src`, `low_alkali`, `white`) and `cement_strength_class` (32.5, 42.5, 52.5) are optional properties of a cement's test. No compliance check reads them. Sulfate resistance is still judged from C₃A, alkali limits from the measured alkali, pozzolan content from `pozzolan_pct`, strength from tested mortar strength.
2. **Consistency warnings.** When a label and the tested values disagree (SRC with C₃A above the SHARED limit or missing; low alkali with alkali above the limit, missing, or no limit on file; PPC without a pozzolan content; a class whose 28-day mortar strength is below the class minimum) the evaluation carries a `cement_label_check` data-quality warning. A warning never fails or passes a check.
3. **Kind is single-valued.** SRC that is also low alkali is recorded as SRC. White is its own kind with the same three classes.
4. **Group key.** A strength model's group key includes kind and class, so a model is never applied across, for example, OPC 42.5 and PPC 32.5.
5. **Colour option.** A design request has `cementColour`: any (default), white, or grey. Grey excludes white cement; white excludes every cement not recorded as white (unlabelled included). The excluded cements are named in the pool with the reason. Proactive re-optimization follows the design's own colour: a design on white cement is offered only white; others never get white.
6. **Seeds.** Class minimums are SHARED parameter rules (EN 197-1, unverified). The low-alkali Na₂O limit is an engineering parameter left empty for QC.
7. **Suggestions.** A market name (English or Arabic) can suggest a label in the material form; a person applies it. Nothing is filled silently.

## Consequences

Old cements without labels keep working; they show "not recorded". The market-to-standard mapping is a code constant for display and hints, not a rule.
