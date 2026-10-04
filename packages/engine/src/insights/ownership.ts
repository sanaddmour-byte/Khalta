// Alert ownership. A high or critical alert should have a named owner, an acknowledgement and (when the tenant has set
// a deadline) an escalation if nobody acknowledges in time. The deadline is a tenant setting and ships unset: with no
// deadline nothing escalates by itself, and the screen says so. Pure; built from the insight's append-only events.

export interface OwnershipEvent {
  kind: string;
  at: string; // ISO
  detail: Record<string, unknown>;
}

export type OwnershipState = 'unassigned' | 'assigned' | 'acknowledged' | 'overdue' | 'escalated';

export interface Ownership {
  state: OwnershipState;
  ownerId: string | null;
  ownerName: string | null;
  assignedAt: string | null;
  dueAt: string | null;
  acknowledgedAt: string | null;
  escalatedAt: string | null;
}

/** The deadline for an assignment made `assignedAt`, or null when the tenant set none for the severity. */
export function dueAtFor(assignedAt: string, hours: number | null): string | null {
  return hours === null ? null : new Date(Date.parse(assignedAt) + hours * 3_600_000).toISOString();
}

/**
 * The current ownership. The LATEST assignment counts (a reassignment restarts the clock, and clears an earlier
 * acknowledgement or escalation because they answered the previous owner).
 */
export function ownershipOf(events: readonly OwnershipEvent[], now: string): Ownership {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const lastAssign = [...ordered].reverse().find((e) => e.kind === 'assigned');
  if (!lastAssign)
    return {
      state: 'unassigned',
      ownerId: null,
      ownerName: null,
      assignedAt: null,
      dueAt: null,
      acknowledgedAt: null,
      escalatedAt: null,
    };
  const after = ordered.filter((e) => e.at >= lastAssign.at);
  const ack = after.find((e) => e.kind === 'acknowledged');
  // an escalation answers ONE assignment (it names it); a later reassignment starts clean
  const esc = after.find(
    (e) =>
      e.kind === 'escalated' &&
      ((e.detail['assignmentAt'] as string | undefined) ?? lastAssign.at) === lastAssign.at,
  );
  const dueAt = (lastAssign.detail['dueAt'] as string | null | undefined) ?? null;
  const state: OwnershipState = esc
    ? 'escalated'
    : ack
      ? 'acknowledged'
      : dueAt !== null && dueAt < now
        ? 'overdue'
        : 'assigned';
  return {
    state,
    ownerId: String(lastAssign.detail['ownerId'] ?? ''),
    ownerName: (lastAssign.detail['ownerName'] as string | undefined) ?? null,
    assignedAt: lastAssign.at,
    dueAt,
    acknowledgedAt: ack?.at ?? null,
    escalatedAt: esc?.at ?? null,
  };
}

/** True when an assigned alert passed its deadline unacknowledged and was not escalated yet. */
export const needsEscalation = (o: Ownership) => o.state === 'overdue';
