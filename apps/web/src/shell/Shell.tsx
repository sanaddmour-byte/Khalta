import {
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
  SheetContent,
  Tooltip,
  Toaster,
  Ltr,
} from '@khalta/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { Menu, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { signOut } from '../lib/api';
import { useMe } from '../lib/auth';
import { visibleNav } from '../lib/nav';
import { PlantProvider } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import { LanguageToggle, NotificationsButton, ThemeToggle, UserMenu } from './Controls';
import { NavList } from './Nav';
import { Palette } from './Palette';
import { PlantSwitcher } from './PlantSwitcher';
import { Wordmark } from './Wordmark';

export function Shell() {
  const { t } = useTranslation();
  const { theme } = usePrefs();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  if (!me) return null;

  const items = visibleNav(me.capabilities);
  const unscoped = me.scope.all;
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

  const doSignOut = async () => {
    try {
      await signOut();
    } finally {
      queryClient.clear();
      void navigate({ to: '/login' });
    }
  };

  return (
    <>
      <PlantProvider unscoped={unscoped}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:p-2"
        >
          {t('app.skip')}
        </a>
        <div className="flex min-h-screen">
          <aside
            className="hidden w-60 shrink-0 flex-col gap-6 border-e border-line bg-surface p-4 md:flex"
            data-testid="sidebar"
          >
            <Wordmark className="px-3 text-lg" />
            <NavList items={items} />
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header
              className="flex h-14 items-center gap-2 border-b border-line bg-surface px-3 md:px-6"
              data-testid="topbar"
            >
              <Dialog open={drawer} onOpenChange={setDrawer}>
                <Tooltip label={t('nav.open')}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="md:hidden"
                    aria-label={t('nav.open')}
                    data-testid="nav-open"
                    onClick={() => setDrawer(true)}
                  >
                    <Menu className="size-5" aria-hidden />
                  </Button>
                </Tooltip>
                <SheetContent>
                  <DialogTitle className="sr-only">{t('nav.label')}</DialogTitle>
                  <DialogDescription className="sr-only">{t('nav.label')}</DialogDescription>
                  <Wordmark className="mb-4 px-3 text-lg" />
                  <NavList items={items} onNavigate={() => setDrawer(false)} />
                </SheetContent>
              </Dialog>

              <PlantSwitcher unscoped={unscoped} />
              <div className="flex-1" />

              <Button
                variant="secondary"
                size="sm"
                className="hidden gap-3 text-muted md:inline-flex"
                onClick={() => setPalette(true)}
                data-testid="palette-open"
              >
                <Search className="size-4" aria-hidden />
                {t('shell.search')}
                <Ltr className="rounded-sm border border-line px-1 text-xs">
                  {isMac ? '⌘K' : 'Ctrl K'}
                </Ltr>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label={t('shell.search')}
                onClick={() => setPalette(true)}
                data-testid="palette-open-icon"
              >
                <Search className="size-4" aria-hidden />
              </Button>
              <LanguageToggle className="hidden md:inline-flex" />
              <ThemeToggle className="hidden md:inline-flex" />
              <NotificationsButton />
              <UserMenu onSignOut={doSignOut} />
            </header>

            <main id="main" tabIndex={-1} className="flex-1 p-4 md:p-6">
              <Outlet />
            </main>
          </div>
        </div>
        <Palette open={palette} onOpenChange={setPalette} items={items} unscoped={unscoped} />
        <Toaster theme={theme} />
      </PlantProvider>
    </>
  );
}
