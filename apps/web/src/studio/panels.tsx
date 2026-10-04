import { Button, Ltr } from '@khalta/ui';
import { CircleAlert, Gauge, OctagonAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Blocker, Dof, Outcome } from './api';

/** "3 quantities left for the optimizer" / fully specified / over-specified (07 §6). Icon + text, never colour alone. */
export function DofMeter({
  dof,
}: {
  dof: Pick<Dof, 'dof' | 'state' | 'quantities' | 'equalities'>;
}) {
  const { t } = useTranslation();
  const tone =
    dof.state === 'free'
      ? 'border-line text-body'
      : dof.state === 'fully_specified'
        ? 'border-warn bg-warn-bg text-warn-text'
        : 'border-fail bg-fail-bg text-fail-text';
  return (
    <p
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${tone}`}
      data-testid="dof-meter"
      data-state={dof.state}
      role="status"
    >
      <Gauge className="size-4" aria-hidden />
      {dof.state === 'free'
        ? t('studio.dof.free', { n: dof.dof })
        : dof.state === 'fully_specified'
          ? t('studio.dof.fixed')
          : t('studio.dof.over', { n: Math.abs(dof.dof) })}
    </p>
  );
}

/** What stops the optimizer, by name, with the place to fix it. Never an empty state. */
export function BlockedPanel({ blockers }: { blockers: Blocker[] }) {
  const { t } = useTranslation();
  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-warn bg-warn-bg p-4 text-warn-text"
      aria-labelledby="blocked-title"
      data-testid="blocked-panel"
    >
      <h3 id="blocked-title" className="flex items-center gap-2 font-semibold">
        <OctagonAlert className="size-4" aria-hidden />
        {t('studio.blocked.title')}
      </h3>
      <p className="text-sm">{t('studio.blocked.intro')}</p>
      <ul className="flex flex-col gap-2 text-sm">
        {blockers.map((b, i) => (
          <li key={i} data-testid="blocker" data-subject={b.subject}>
            <Ltr mono>{b.subject}</Ltr>: {b.detail}
          </li>
        ))}
      </ul>
      <a href="/rules" className="text-sm font-medium underline">
        {t('studio.blocked.rules')}
      </a>
    </section>
  );
}

/**
 * Conflicts: the user-specified values that cannot hold together (each with the value that would work and a
 * Release button), or the hard rows that bind (named, nothing to release, no saving attached).
 */
export function ConflictPanel({
  conflicts,
  onRelease,
  label,
}: {
  conflicts: NonNullable<Outcome['conflicts']>;
  onRelease: (id: string) => void;
  label: (id: string) => string;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-fail bg-fail-bg p-4 text-fail-text"
      aria-labelledby="conflict-title"
      data-testid="conflict-panel"
      data-kind={conflicts.kind}
    >
      <h3 id="conflict-title" className="flex items-center gap-2 font-semibold">
        <CircleAlert className="size-4" aria-hidden />
        {conflicts.kind === 'user_specified'
          ? t('studio.conflict.title')
          : t('studio.conflict.hardTitle')}
      </h3>
      <p className="text-sm">
        {conflicts.kind === 'user_specified'
          ? t('studio.conflict.intro')
          : t('studio.conflict.hardIntro')}
      </p>
      {conflicts.items.length === 0 && <p className="text-sm">{t('studio.conflict.none')}</p>}
      <ul className="flex flex-col gap-2 text-sm">
        {conflicts.items.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center gap-3"
            data-testid="conflict-item"
            data-id={c.id}
          >
            <span className="min-w-48 flex-1">
              {conflicts.kind === 'user_specified' ? label(c.id) : <Ltr mono>{c.id}</Ltr>}
              {c.relaxBy !== null && (
                <span className="ms-2">
                  {t('studio.conflict.relax', { n: c.relaxBy, unit: c.unit })}
                </span>
              )}
              {conflicts.kind === 'hard_rows' && (
                <span className="ms-2">{t('studio.conflict.binding')}</span>
              )}
              {c.category && (
                <span className="ms-2 text-muted" data-testid="conflict-category">
                  {t(`studio.conflict.category.${c.category}`)}
                </span>
              )}
            </span>
            {conflicts.kind === 'user_specified' && c.adjustable !== false && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onRelease(c.id)}
                data-testid={`release-${c.id}`}
              >
                {t('studio.conflict.release')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
