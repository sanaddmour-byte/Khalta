# ADR 0024 — Savings attribution, alert ownership, cement classification, role dashboards

Status: accepted. Nothing here adds an engineering value.

## Savings attribution

The ledger keeps three states apart (theoretical, approved, realized). Each booked entry now shows what it stands on: the attribution period (the month, from–to), the **volume source** of that month (batch tickets, import, hand-entered, demo, none) and a **reconciliation** status that never rounds up: only a ticket or imported volume under **verified** rules is "reconciled"; rules are unverified until QC verifies them, so today nothing is. Corrections are rows, not edits (entries are append-only): `savings_adjustments` holds a **reversal** (one per entry) or a **trial / implementation / extra cost**. The API returns gross, costs and net; a reversal withdraws the gross, real costs stand, and the original figure is never hidden. Duplicates remain prevented by the existing partial unique indexes. Theoretical figures cannot be reversed or charged.

## Alert ownership and escalation

High and critical alerts can be given a named owner (QC manager; the owner must hold a suitable role and access to the alert's plant), acknowledged, and escalated. The acknowledgement deadline is a tenant setting per severity (`alertAckHoursCritical`, `alertAckHoursHigh`) that ships **unset**: with none, nothing escalates by itself and the screen says so. An hourly job escalates an overdue, unacknowledged assignment once, naming the assignment; a reassignment restarts the clock. Escalation records an event and an audit row and changes nothing else.

## Cement classification: type, class and colour

Type (OPC, PPC, SRC, low alkali), strength class and colour (white, grey) are separate values. `white` was recorded as a type; it remains readable as a **legacy** value, read as colour white with the type unstated, and flagged. The migration is **reviewed, not automatic**: `GET /api/materials/cement-label-review` lists legacy and incomplete cements with suggestions from the market name, applies nothing, and a person records type, class and colour as a new test version (history kept). A legacy record keeps exactly its old strength-group string, so reclassifying the vocabulary never invalidates an approved model by itself; the colour joins the group once it is recorded on its own. Labels still decide no compliance check.

## Role dashboards, identity, guards

`GET /api/dashboard` returns role-appropriate counts and short worklists for the caller's plants (no cost figures). The design sheet carries a sticky identity strip (version, hash, plant, frozen requirements and whether they were superseded). Switching plant with unsaved Studio work (generated candidates or a typed mix not saved or sent to trial) asks first. Disabled actions that depend on input say what is missing. A phone-width check found the Library tabs forcing a sideways page scroll; they now scroll inside themselves.

## Outstanding

Reconciliation will read "reconciled" only after QC verifies the rules and volumes come from tickets or an import. The acknowledgement deadlines need QC's values. Escalation notifies in-app only (no email/SMS channel yet).
