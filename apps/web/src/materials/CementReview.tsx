import { Ltr } from '@khalta/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { usePrefs } from '../lib/prefs';
import { cementReviewQuery } from './api';

/** Cements whose type, class or colour a person still has to record. Nothing is applied from here. */
export function CementReview({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const q = useQuery(cementReviewQuery);
  if (!q.data || q.data.length === 0) return null;
  return (
    <section
      className="rounded-md border border-line p-3 text-sm"
      aria-label={t('materials.cement.review.title')}
      data-testid="cement-review"
    >
      <h2 className="font-semibold text-heading">{t('materials.cement.review.title')}</h2>
      <p className="mt-1 text-xs text-muted">{t('materials.cement.review.intro')}</p>
      <ul className="mt-2 flex flex-col gap-1">
        {q.data.map((r) => (
          <li key={r.materialId} className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="text-primary underline"
              onClick={() => onOpen(r.materialId)}
              data-testid="cement-review-open"
            >
              <Ltr>{lang === 'ar' ? (r.nameAr ?? r.nameEn) : r.nameEn}</Ltr>
            </button>
            <span className="text-muted">
              {r.issues
                .map((i) => t(`materials.cement.review.${i === 'legacy_white' ? 'legacy' : i}`))
                .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
