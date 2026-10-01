import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from '@khalta/ui';
import { Bell, Languages, LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../lib/auth';
import { usePrefs, type Density, type ThemePref } from '../lib/prefs';

// Language names are shown in their own language (endonyms) and are never translated.
const LANGUAGE_NAME = { en: 'English', ar: 'العربية' } as const;

export function LanguageToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { lang, setLang } = usePrefs();
  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      data-testid="lang-toggle"
      lang={lang === 'ar' ? 'en' : 'ar'}
      onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
    >
      <Languages className="size-4" aria-hidden />
      {t('shell.toggleLanguage')}
    </Button>
  );
}

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };

export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { themePref, setThemePref } = usePrefs();
  const Icon = THEME_ICON[themePref];
  const label = `${t('shell.theme')}: ${t(`shell.theme${themePref[0]!.toUpperCase()}${themePref.slice(1)}`)}`;
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        size="icon"
        className={className}
        aria-label={label}
        data-testid="theme-toggle"
        onClick={() => setThemePref(NEXT[themePref])}
      >
        <Icon className="size-4" aria-hidden />
      </Button>
    </Tooltip>
  );
}

export function NotificationsButton() {
  const { t } = useTranslation();
  return (
    <Popover>
      <Tooltip label={t('shell.notifications')}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('shell.notifications')}
            data-testid="notifications"
          >
            <Bell className="size-4" aria-hidden />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-80">
        <EmptyState
          className="border-0 p-2"
          title={t('shell.noNotifications')}
          description={t('shell.noNotificationsHint')}
          icon={<Bell className="size-6" aria-hidden />}
        />
      </PopoverContent>
    </Popover>
  );
}

export function UserMenu({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const { themePref, setThemePref, density, setDensity, lang, setLang } = usePrefs();
  if (!me) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('shell.account')} data-testid="user-menu">
          <UserRound className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          <span className="block text-sm font-medium text-heading">{me.user.name}</span>
          <bdi dir="ltr" className="block">
            {me.user.email}
          </bdi>
          <span className="block">{t(`roles.${me.role}`)}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* Language and theme are also here so they stay reachable on narrow screens. */}
        <DropdownMenuLabel>{t('shell.language')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={lang} onValueChange={(v) => setLang(v as 'en' | 'ar')}>
          <DropdownMenuRadioItem value="en">
            <span lang="en">{LANGUAGE_NAME.en}</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="ar">
            <span lang="ar">{LANGUAGE_NAME.ar}</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('shell.theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={themePref}
          onValueChange={(v) => setThemePref(v as ThemePref)}
        >
          <DropdownMenuRadioItem value="system">{t('shell.themeSystem')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">{t('shell.themeLight')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t('shell.themeDark')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('shell.density')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={density} onValueChange={(v) => setDensity(v as Density)}>
          <DropdownMenuRadioItem value="compact">{t('shell.densityCompact')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="comfortable">
            {t('shell.densityComfortable')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut} data-testid="sign-out">
          <LogOut className="size-4 rtl:-scale-x-100" aria-hidden />
          {t('shell.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
