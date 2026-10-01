import type { Lang } from './resources';

export type NumberFormat = 'latin' | 'arabic-indic';

/** Western digits by default (03-ui.md §6); Arabic-Indic only when the tenant setting says so. */
export function numberLocale(lang: Lang, format: NumberFormat = 'latin'): string {
  if (lang === 'ar') return format === 'arabic-indic' ? 'ar-JO-u-nu-arab' : 'ar-JO-u-nu-latn';
  return format === 'arabic-indic' ? 'en-u-nu-arab' : 'en-US';
}

export function formatNumber(
  value: number,
  lang: Lang,
  format: NumberFormat = 'latin',
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(numberLocale(lang, format), options).format(value);
}

/** JOD with exactly 3 decimals (money rule). The value should come from a decimal string. */
export const formatJod = (value: number, lang: Lang, format: NumberFormat = 'latin') =>
  formatNumber(value, lang, format, { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** Timestamps are stored in UTC and always displayed in Asia/Amman. */
export function formatDateTime(
  date: Date | string | number,
  lang: Lang,
  format: NumberFormat = 'latin',
): string {
  return new Intl.DateTimeFormat(numberLocale(lang, format), {
    timeZone: 'Asia/Amman',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(date));
}
