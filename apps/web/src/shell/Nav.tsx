import { cn } from '@khalta/ui';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { NavItem } from '../lib/nav';

export function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('nav.label')} data-testid="main-nav">
      <ul className="flex flex-col gap-1">
        {items.map(({ id, path, icon: Icon }) => (
          <li key={id}>
            <Link
              to={path}
              onClick={onNavigate}
              activeOptions={{ exact: path === '/' }}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-heading hover:bg-primary-tint',
              )}
              activeProps={{
                className: 'bg-primary-tint font-semibold text-primary',
                'aria-current': 'page',
              }}
              data-nav={id}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {t(`nav.${id}`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
