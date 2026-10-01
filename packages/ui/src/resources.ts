import glossary from '../glossary.json';
import ar from './locales/ar.json';
import en from './locales/en.json';

export type Lang = 'en' | 'ar';
export const LANGS: readonly Lang[] = ['en', 'ar'];

type Tree = { [k: string]: string | Tree };
const glossaryFor = (lang: Lang): Tree => ({
  glossary: Object.fromEntries(glossary.terms.map((t) => [t.id, t[lang]])),
});

/** UI-level strings + the glossary (single source of truth for domain terms in both languages). */
export const uiResources: Record<Lang, Tree> = {
  en: { ...en, ...glossaryFor('en') },
  ar: { ...ar, ...glossaryFor('ar') },
};
export const glossaryTerms = glossary.terms;
