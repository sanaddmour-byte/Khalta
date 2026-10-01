import { formatDateTime, formatNumber, type NumberFormat } from '@khalta/ui';
import { useCallback } from 'react';
import { useMe } from './auth';
import { usePrefs } from './prefs';

/** Locale-aware number/date formatting that honours the tenant's digit setting. */
export function useFormat() {
  const { lang } = usePrefs();
  const fmt: NumberFormat = useMe().data?.settings.numberFormat ?? 'latin';
  return {
    number: useCallback(
      (n: number, o?: Intl.NumberFormatOptions) => formatNumber(n, lang, fmt, o),
      [lang, fmt],
    ),
    dateTime: useCallback((d: Date | string | number) => formatDateTime(d, lang, fmt), [lang, fmt]),
  };
}
