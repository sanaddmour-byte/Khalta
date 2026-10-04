import { describe, expect, it } from 'vitest';
import { dueAtFor, needsEscalation, ownershipOf, type OwnershipEvent } from '../src';

const ev = (kind: string, at: string, detail: Record<string, unknown> = {}): OwnershipEvent => ({
  kind,
  at,
  detail,
});
const NOW = '2026-10-04T12:00:00.000Z';

describe('alert ownership', () => {
  it('no deadline configured means no automatic escalation, however old', () => {
    expect(dueAtFor('2026-01-01T00:00:00.000Z', null)).toBeNull();
    const o = ownershipOf(
      [ev('assigned', '2026-01-01T00:00:00.000Z', { ownerId: 'u1', dueAt: null })],
      NOW,
    );
    expect(o.state).toBe('assigned');
    expect(needsEscalation(o)).toBe(false);
  });
  it('goes unassigned → assigned → overdue → escalated, and acknowledgement stops the clock', () => {
    expect(ownershipOf([], NOW).state).toBe('unassigned');
    const due = dueAtFor('2026-10-04T08:00:00.000Z', 2)!;
    expect(due).toBe('2026-10-04T10:00:00.000Z');
    const assigned = [ev('assigned', '2026-10-04T08:00:00.000Z', { ownerId: 'u1', dueAt: due })];
    expect(ownershipOf(assigned, '2026-10-04T09:00:00.000Z').state).toBe('assigned');
    const overdue = ownershipOf(assigned, NOW);
    expect(overdue.state).toBe('overdue');
    expect(needsEscalation(overdue)).toBe(true);
    const escalated = ownershipOf([...assigned, ev('escalated', '2026-10-04T10:30:00.000Z')], NOW);
    expect(escalated.state).toBe('escalated');
    expect(needsEscalation(escalated)).toBe(false);
    const acked = ownershipOf([...assigned, ev('acknowledged', '2026-10-04T09:30:00.000Z')], NOW);
    expect(acked.state).toBe('acknowledged');
    expect(needsEscalation(acked)).toBe(false);
  });
  it('a reassignment restarts the clock and clears the earlier acknowledgement and escalation', () => {
    const events = [
      ev('assigned', '2026-10-04T06:00:00.000Z', {
        ownerId: 'u1',
        dueAt: '2026-10-04T07:00:00.000Z',
      }),
      ev('escalated', '2026-10-04T07:30:00.000Z', { assignmentAt: '2026-10-04T06:00:00.000Z' }),
      ev('assigned', '2026-10-04T11:00:00.000Z', {
        ownerId: 'u2',
        dueAt: '2026-10-04T15:00:00.000Z',
      }),
    ];
    const o = ownershipOf(events, NOW);
    expect(o).toMatchObject({ state: 'assigned', ownerId: 'u2', escalatedAt: null });
    // even an escalation stamped AFTER the reassignment belongs to the earlier one when it names it
    const odd = ownershipOf(
      [
        ...events,
        ev('escalated', '2026-10-04T13:00:00.000Z', { assignmentAt: '2026-10-04T06:00:00.000Z' }),
      ],
      NOW,
    );
    expect(odd.state).toBe('assigned');
  });
});
