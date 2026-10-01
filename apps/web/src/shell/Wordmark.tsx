import { useTranslation } from 'react-i18next';

export function Wordmark({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-baseline gap-2 font-semibold text-heading ${className}`}>
      <span lang="ar">{t('app.nameAr')}</span>
      <span aria-hidden>·</span>
      <span lang="en">{t('app.nameEn')}</span>
    </span>
  );
}
