import i18next from 'i18next';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { DirectionProvider, uiResources, type Lang } from '../src/index';

export function renderIn(ui: ReactElement, lang: Lang = 'en') {
  const i18n = i18next.createInstance();
  void i18n.use(initReactI18next).init({
    lng: lang,
    fallbackLng: false,
    resources: { en: { translation: uiResources.en }, ar: { translation: uiResources.ar } },
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return render(
    <I18nextProvider i18n={i18n}>
      <DirectionProvider dir={dir}>{ui}</DirectionProvider>
    </I18nextProvider>,
  );
}
