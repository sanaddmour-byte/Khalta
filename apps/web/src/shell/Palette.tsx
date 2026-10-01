import { CommandPalette, type PaletteGroup } from '@khalta/ui';
import { useNavigate } from '@tanstack/react-router';
import { Factory, Languages, Moon, Sun } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { NavItem } from '../lib/nav';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';

export function Palette({
  open,
  onOpenChange,
  items,
  unscoped,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  items: NavItem[];
  unscoped: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { lang, setLang, theme, setThemePref } = usePrefs();
  const { plants, select } = usePlant();

  // Ctrl/Cmd+K toggles the palette from anywhere.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open, onOpenChange]);

  const groups = useMemo<PaletteGroup[]>(
    () => [
      {
        heading: t('shell.navigate'),
        items: items.map((n) => ({
          id: `nav-${n.id}`,
          label: t(`nav.${n.id}`),
          // search works in both languages regardless of the UI language
          keywords: [t(`nav.${n.id}`, { lng: 'en' }), t(`nav.${n.id}`, { lng: 'ar' })],
          icon: <n.icon className="size-4" aria-hidden />,
          onSelect: () => void navigate({ to: n.path }),
        })),
      },
      {
        heading: t('shell.plantsGroup'),
        items: plants.map((p) => ({
          id: `plant-${p.id}`,
          label: `${p.code} ${lang === 'ar' ? p.nameAr : p.nameEn}`,
          keywords: [p.code, p.nameAr, p.nameEn],
          icon: <Factory className="size-4" aria-hidden />,
          onSelect: () => select(p.id),
        })),
      },
      {
        heading: t('shell.commands'),
        items: [
          {
            id: 'lang',
            label: `${t('shell.language')}: ${t('shell.toggleLanguage')}`,
            keywords: ['language', 'لغة', 'عربي', 'english'],
            icon: <Languages className="size-4" aria-hidden />,
            onSelect: () => setLang(lang === 'ar' ? 'en' : 'ar'),
          },
          {
            id: 'theme',
            label: `${t('shell.theme')}: ${theme === 'dark' ? t('shell.themeLight') : t('shell.themeDark')}`,
            keywords: ['theme', 'dark', 'light', 'مظهر'],
            icon:
              theme === 'dark' ? (
                <Sun className="size-4" aria-hidden />
              ) : (
                <Moon className="size-4" aria-hidden />
              ),
            onSelect: () => setThemePref(theme === 'dark' ? 'light' : 'dark'),
          },
        ],
      },
    ],
    [t, items, plants, lang, theme, navigate, select, setLang, setThemePref],
  );
  void unscoped;
  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      title={t('shell.search')}
    />
  );
}
