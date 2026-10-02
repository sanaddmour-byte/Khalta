import { describe, expect, it } from 'vitest';
import {
  ACTIVE_MILESTONE,
  canTransition,
  DESIGN_STATES,
  EDGES,
  isTerminal,
  MILESTONE_ORDER,
  type EvidenceKind,
} from '../src/lifecycle';

const allEvidence = [...new Set(EDGES.flatMap((e) => e.evidence))] as EvidenceKind[];
const LATEST = MILESTONE_ORDER[MILESTONE_ORDER.length - 1]!;

describe('lifecycle graph (01-domain §14.1)', () => {
  it('has a verdict for every ordered pair of states', () => {
    for (const from of DESIGN_STATES)
      for (const to of DESIGN_STATES) {
        const legal = EDGES.some((e) => e.from === from && e.to === to);
        const v = canTransition(from, to, allEvidence, LATEST);
        expect(v.ok, `${from} → ${to}`).toBe(legal);
        if (!v.ok) expect(v.code).toBe('no_such_transition');
      }
  });

  it('every state can be reached from draft', () => {
    const seen = new Set<string>(['draft']);
    for (let i = 0; i < DESIGN_STATES.length; i++)
      for (const e of EDGES) if (seen.has(e.from)) seen.add(e.to);
    expect([...seen].sort()).toEqual([...DESIGN_STATES].sort());
  });

  it('terminal states have no way out', () => {
    for (const s of DESIGN_STATES.filter(isTerminal))
      for (const to of DESIGN_STATES)
        expect(canTransition(s, to, allEvidence, LATEST).ok).toBe(false);
    expect(isTerminal('retired')).toBe(true);
    expect(isTerminal('draft')).toBe(false);
  });

  it('there is no path from the optimizer to approved without a trial, except legacy attestation', () => {
    const toApproved = EDGES.filter((e) => e.to === 'approved');
    expect(toApproved.map((e) => `${e.from}:${e.evidence.join('+')}`).sort()).toEqual([
      'draft:legacy_attestation',
      'evaluated:legacy_attestation',
      'suspended:reinstatement_decision',
      'trial_passed:four_eyes_approval',
    ]);
    expect(canTransition('trial_candidate', 'approved', allEvidence, LATEST).ok).toBe(false);
  });

  it('turns on only the edges that exist in this milestone', () => {
    expect(ACTIVE_MILESTONE).toBe('M4.1');
    const v = canTransition('draft', 'evaluated', ['evaluation_verified']);
    expect(v.ok).toBe(true);
    expect(canTransition('evaluated', 'evaluated', ['evaluation_verified']).ok).toBe(true);
    expect(canTransition('draft', 'approved', ['legacy_attestation']).ok).toBe(true);
    expect(canTransition('evaluated', 'approved', ['legacy_attestation']).ok).toBe(true);
    expect(canTransition('approved', 'in_production', ['release']).ok).toBe(true);
    // M3.1: the optimizer's candidates may become trial candidates, on validator evidence only.
    expect(canTransition('evaluated', 'trial_candidate', ['validated_candidate']).ok).toBe(true);
    expect(canTransition('draft', 'trial_candidate', ['validated_candidate']).ok).toBe(true);
    expect(canTransition('evaluated', 'trial_candidate', []).ok).toBe(false);
    expect(canTransition('evaluated', 'draft', ['edit']).ok).toBe(true);
    // M4.1: the trial path, approval, supersede and retire
    expect(canTransition('trial_candidate', 'trial_in_progress', ['trial_batch']).ok).toBe(true);
    expect(canTransition('trial_in_progress', 'trial_passed', ['trial_review']).ok).toBe(true);
    expect(canTransition('trial_passed', 'approved', ['four_eyes_approval']).ok).toBe(true);
    expect(canTransition('approved', 'superseded', ['new_version_approved']).ok).toBe(true);
    expect(canTransition('approved', 'retired', ['qc_decision']).ok).toBe(true);
    for (const [from, to, ev, at] of [
      ['approved', 'suspended', ['suspension_decision'], 'M5.1'],
      ['in_production', 'suspended', ['suspension_decision'], 'M5.1'],
      ['suspended', 'approved', ['reinstatement_decision'], 'M5.1'],
    ] as const) {
      const r = canTransition(from, to, ev);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('not_yet_available');
        expect(r.availableFrom).toBe(at);
        expect(r.reason).toContain(at);
      }
      expect(canTransition(from, to, ev, at).ok).toBe(true);
    }
  });

  it('every legal edge names its evidence and refuses to move without it', () => {
    for (const e of EDGES) {
      expect(e.evidence.length).toBeGreaterThan(0);
      const none = canTransition(e.from, e.to, [], LATEST);
      expect(none.ok).toBe(false);
      if (!none.ok) {
        expect(none.code).toBe('evidence_missing');
        expect(none.missing).toEqual([...e.evidence]);
      }
      const wrong = canTransition(
        e.from,
        e.to,
        ['trial_review', 'release'].filter((k) => !e.evidence.includes(k as EvidenceKind)),
        LATEST,
      );
      expect(wrong.ok).toBe(false);
      expect(canTransition(e.from, e.to, e.evidence, LATEST).ok).toBe(true);
    }
  });

  it('rejects unknown states', () => {
    const r = canTransition('draft', 'flying');
    expect(r).toMatchObject({ ok: false, code: 'unknown_state' });
    expect(canTransition('nope', 'draft')).toMatchObject({ ok: false, code: 'unknown_state' });
  });

  it('a milestone it does not know never counts as reached', () => {
    expect(canTransition('draft', 'evaluated', ['evaluation_verified'], 'M0.0').ok).toBe(false);
    expect(
      EDGES.every((e) => (MILESTONE_ORDER as readonly string[]).includes(e.availableFrom)),
    ).toBe(true);
  });

  it('no legal sequence reaches approved without trial_passed, except legacy attestation', () => {
    // Breadth-first over every reachable (state, "has been trial_passed", "has been attested") triple.
    type N = { s: string; trial: boolean; legacy: boolean };
    const seen = new Set<string>();
    const queue: N[] = [{ s: 'draft', trial: false, legacy: false }];
    while (queue.length) {
      const n = queue.shift()!;
      const key = JSON.stringify(n);
      if (seen.has(key)) continue;
      seen.add(key);
      if (n.s === 'approved') expect(n.trial || n.legacy).toBe(true);
      for (const e of EDGES) {
        if (e.from !== n.s || !canTransition(e.from, e.to, e.evidence, LATEST).ok) continue;
        queue.push({
          s: e.to,
          trial: n.trial || e.to === 'trial_passed',
          legacy: n.legacy || e.evidence.includes('legacy_attestation'),
        });
      }
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});
