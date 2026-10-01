import { uiResources, type Lang } from '@khalta/ui';
import i18next from 'i18next';
import ICU from 'i18next-icu';
import { initReactI18next } from 'react-i18next';
import ar from './locales/ar.json';
import en from './locales/en.json';

export function detectLang(): Lang {
  try {
    const saved = window.localStorage.getItem('khalta.lang');
    if (saved === 'ar' || saved === 'en') return saved;
  } catch {
    /* storage unavailable: fall through */
  }
  return (navigator.language ?? '').startsWith('ar') ? 'ar' : 'en';
}

export const resources = {
  en: { translation: { ...uiResources.en, ...en } },
  ar: { translation: { ...uiResources.ar, ...ar } },
};

export function createI18n(lng: Lang = detectLang()) {
  const instance = i18next.createInstance();
  void instance
    .use(ICU)
    .use(initReactI18next)
    .init({
      lng,
      fallbackLng: 'en',
      resources,
      interpolation: { escapeValue: false },
      initAsync: false,
    });
  return instance;
}

export const i18n = createI18n();
