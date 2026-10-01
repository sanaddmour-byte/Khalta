import { EmptyState } from '@khalta/ui';
import { ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../lib/auth';
import { NAV, visibleNav } from '../lib/nav';

/** Placeholder for a section whose real screen arrives in a later milestone (teaching empty state). */
export function SectionPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const item = NAV.find((n) => n.id === id);
  if (!item || !me) return null;

  // Direct URL access for a role that cannot see the section: absent from nav, explained here.
  if (!visibleNav(me.capabilities).some((n) => n.id === id))
    return (
      <EmptyState
        icon={<ShieldOff className="size-8" aria-hidden />}
        title={t('errors.forbidden')}
        description={t('errors.forbiddenHint')}
      />
    );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold text-heading">{t(`nav.${id}`)}</h1>
      <EmptyState
        icon={<item.icon className="size-8" aria-hidden />}
        title={t(`sections.${id}.milestone`)}
        description={t(`sections.${id}.description`)}
      />
    </div>
  );
}
