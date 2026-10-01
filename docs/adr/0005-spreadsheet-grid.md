# ADR 0005 — Spreadsheet grid for the price matrix

Status: accepted (2026-10-01, approved with the M1.2 plan defaults)

## Context

The price matrix (materials × up to 20 plants, ~200 rows) must feel like a spreadsheet to procurement: inline edit, range paste from Excel, keyboard navigation, undo, stale hatching, and it must work in Arabic (RTL) and pass axe. Licences must be MIT/Apache/BSD/ISC (`CLAUDE.md` rule 4).

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Hand-built ARIA grid with TanStack Virtual for row windowing | Approved library family; full control of RTL, logical CSS, keyboard model, paste and a11y; money cells are decimal strings, not grid-library values; no new licence | We write selection, paste, staging/undo and key handling (kept in a pure, tested model) |
| B. AG Grid Community (MIT) | Mature editing | Range selection and Excel clipboard are Enterprise features; heavy bundle; RTL/ARIA customization is costly |
| C. Glide Data Grid (MIT) | Canvas speed for huge grids | Canvas text defeats Arabic shaping review, axe and screen readers; weak RTL |

## Decision

Option A. `01-domain.md §9` lists TanStack Table; for a fixed matrix its column model adds nothing, so only TanStack Virtual is used. Behaviour lives in a pure `PriceStaging` model and a paste parser in `packages/engine` (tested without a DOM); the React grid is a thin renderer.

## Evidence

Spreadsheet behaviour needed is small: single and range selection, edit, paste block, clear, undo/redo, copy. 200 rows × 20 columns is 4,000 cells, which windowed rows render comfortably. The 4,000-cell paste budget (< 2 s) is a server-side bulk insert, measured by an API test.

## Risks

Hand-written keyboard handling can regress; mitigated by keyboard e2e in both directions and axe on the grid.

## Reversal path

The renderer is replaceable: the model, API and tests do not depend on it.
