import { describe, expect, it } from 'vitest';
import { formatDateTime, formatJod, formatNumber, numberLocale } from '../src/format';

describe('number formatting', () => {
  it('uses Western digits by default in both languages', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
    expect(formatNumber(1234.5, 'ar')).toMatch(/^1[,٬]234[.٫]5$/);
    expect(formatNumber(1234.5, 'ar')).not.toMatch(/[٠-٩]/);
  });
  it('uses Arabic-Indic digits only on request', () => {
    expect(formatNumber(30, 'ar', 'arabic-indic')).toBe('٣٠');
    expect(formatNumber(30, 'en', 'arabic-indic')).toBe('٣٠');
    expect(numberLocale('ar')).toBe('ar-JO-u-nu-latn');
  });
  it('formats JOD with exactly three decimals', () => {
    expect(formatJod(0.84, 'en')).toBe('0.840');
    expect(formatJod(1250, 'en')).toBe('1,250.000');
  });
});

describe('date formatting', () => {
  it('displays UTC timestamps in Asia/Amman (UTC+3 all year since 2022)', () => {
    expect(formatDateTime('2026-01-15T10:00:00Z', 'en')).toContain('1:00');
    expect(formatDateTime('2026-07-15T10:00:00Z', 'en')).toContain('1:00');
    expect(formatDateTime('2026-07-15T21:30:00Z', 'en')).toMatch(/Jul 16, 2026/); // crosses midnight in Amman
  });
});
