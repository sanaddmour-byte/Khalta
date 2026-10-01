import { DirectionProvider, type Lang } from '@khalta/ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../i18n';

export type ThemePref = 'system' | 'light' | 'dark';
export type Density = 'compact' | 'comfortable';

interface Prefs {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  themePref: ThemePref;
  theme: 'light' | 'dark';
  density: Density;
  setLang: (l: Lang) => void;
  setThemePref: (t: ThemePref) => void;
  setDensity: (d: Density) => void;
}

const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(`khalta.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.localStorage.setItem(`khalta.${key}`, value);
    } catch {
      /* private mode etc.: preference just isn't remembered */
    }
  },
};

const Ctx = createContext<Prefs | null>(null);
export const usePrefs = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePrefs outside PrefsProvider');
  return v;
};

const systemTheme = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(i18n.language === 'ar' ? 'ar' : 'en');
  const [themePref, setThemeState] = useState<ThemePref>(
    (store.get('theme') as ThemePref) ?? 'system',
  );
  const [density, setDensityState] = useState<Density>(
    (store.get('density') as Density) ?? 'compact',
  );
  const [sys, setSys] = useState<'light' | 'dark'>(systemTheme);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setSys(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const theme = themePref === 'system' ? sys : themePref;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    const d = document.documentElement;
    d.lang = lang;
    d.dir = dir;
    d.dataset['theme'] = theme;
    d.dataset['density'] = density;
    void i18n.changeLanguage(lang);
  }, [lang, dir, theme, density]);

  const setLang = useCallback((l: Lang) => {
    store.set('lang', l);
    setLangState(l);
  }, []);
  const setThemePref = useCallback((t: ThemePref) => {
    store.set('theme', t);
    setThemeState(t);
  }, []);
  const setDensity = useCallback((d: Density) => {
    store.set('density', d);
    setDensityState(d);
  }, []);

  const value = useMemo<Prefs>(
    () => ({ lang, dir, themePref, theme, density, setLang, setThemePref, setDensity }),
    [lang, dir, themePref, theme, density, setLang, setThemePref, setDensity],
  );
  return (
    <Ctx.Provider value={value}>
      <I18nextProvider i18n={i18n}>
        <DirectionProvider dir={dir}>{children}</DirectionProvider>
      </I18nextProvider>
    </Ctx.Provider>
  );
}
