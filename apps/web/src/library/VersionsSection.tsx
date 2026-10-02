import { Button, Ltr } from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitCompare, Tag } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { usePrefs } from '../lib/prefs';
import { DesignStatusChip, VerdictChip } from './chips';
import {
  baselinesQuery,
  diffQuery,
  priceOpportunity,
  versionsQuery,
  type Opportunity,
} from './portfolioApi';

export function VersionsSection({
  designId,
  code,
  onOpen,
}: {
  designId: string;
  code: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  const qc = useQueryClient();
  const versions = useQuery(versionsQuery(designId));
  const baselines = useQuery({ ...baselinesQuery, enabled: caps.includes('cost.view') });
  const [pair, setPair] = useState<[string, string] | null>(null);
  const diff = useQuery({ ...diffQuery(pair?.[0] ?? '', pair?.[1] ?? ''), enabled: !!pair });
  const [result, setResult] = useState<Record<string, Opportunity>>({});
  const price = useMutation({
    mutationFn: (v: { baselineId: string; variantDesignId: string }) => priceOpportunity(v),
    onSuccess: async (res, v) => {
      setResult((p) => ({ ...p, [v.variantDesignId]: res }));
      await qc.invalidateQueries({ queryKey: ['savings'] });
      await qc.invalidateQueries({ queryKey: ['designs'] });
    },
  });
  const myBaselines = (baselines.data ?? []).filter((b) => b.code === code);
  const rows = versions.data ?? [];
  if (rows.length <= 1 && myBaselines.length === 0) return null;
  return (
    <section className="mt-6" aria-label={t('versions.title')} data-testid="versions">
      <h3 className="mb-2 text-sm font-semibold text-heading">{t('versions.title')}</h3>
      <ul className="flex flex-col gap-2">
        {rows.map((v, i) => {
          const prev = rows[i + 1];
          const base = myBaselines.find((b) => b.designId !== v.id);
          const outcome = result[v.id];
          return (
            <li
              key={v.id}
              className="rounded-md border border-line p-3 text-sm"
              data-testid="version-row"
              data-version={v.version}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Tag className="size-3.5 text-muted" aria-hidden />
                <strong>
                  <Ltr>{t('versions.short', { n: v.version })}</Ltr>
                </strong>
                <DesignStatusChip status={v.status} />
                <VerdictChip verdict={v.lastVerdict} />
                {v.id === designId && (
                  <span className="text-xs text-muted">{t('versions.current')}</span>
                )}
                {v.id !== designId && (
                  <Button variant="ghost" size="sm" onClick={() => onOpen(v.id)}>
                    {t('versions.open')}
                  </Button>
                )}
                {prev && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPair([prev.id, v.id])}
                    data-testid="compare-prev"
                  >
                    <GitCompare className="size-4" aria-hidden />
                    {t('versions.compare', { version: prev.version })}
                  </Button>
                )}
                {caps.includes('design.write') &&
                  base &&
                  ['draft', 'evaluated'].includes(v.status) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={price.isPending}
                      onClick={() => price.mutate({ baselineId: base.id, variantDesignId: v.id })}
                      data-testid="price-opportunity"
                    >
                      {t('versions.priceOpportunity')}
                    </Button>
                  )}
              </div>
              {outcome && (
                <div
                  className="mt-2"
                  data-testid="opportunity-result"
                  data-eligible={outcome.eligible}
                >
                  {outcome.eligible ? (
                    <p className="text-pass-text">
                      {t('versions.eligible')}{' '}
                      <Link to="/savings" className="underline">
                        {t('versions.seeLedger')}
                      </Link>
                    </p>
                  ) : (
                    <>
                      <p className="text-warn-text">{t('versions.notEligible')}</p>
                      <ul className="list-disc ps-5 text-xs text-muted">
                        {outcome.reasons.map((r) => (
                          <li key={r.code}>
                            {t(`versions.reason.${r.code}`, { defaultValue: r.code })}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {price.error instanceof ApiError && (
        <p role="alert" className="mt-2 text-sm text-fail-text">
          {price.error.message}
        </p>
      )}
      {pair && diff.data && (
        <div className="mt-3 rounded-md border border-line p-3" data-testid="diff">
          <p className="mb-2 text-sm font-medium">
            {t('versions.diffTitle', { from: diff.data.from.version, to: diff.data.to.version })}
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted">
                <th scope="col" className="py-1 text-start font-medium">
                  {t('library.line.material')}
                </th>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('versions.short', { n: diff.data.from.version })}
                </th>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('versions.short', { n: diff.data.to.version })}
                </th>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('versions.change')}
                </th>
              </tr>
            </thead>
            <tbody>
              {diff.data.lines.map((l) => (
                <tr key={l.materialId} className="border-t border-line" data-change={l.change}>
                  <td className="py-1">{lang === 'ar' ? (l.nameAr ?? l.nameEn) : l.nameEn}</td>
                  <td className="py-1">
                    <Ltr>{l.from ? Number(l.from) : '–'}</Ltr>
                  </td>
                  <td className="py-1">
                    <Ltr>{l.to ? Number(l.to) : '–'}</Ltr>
                  </td>
                  <td className="py-1">{t(`versions.changes.${l.change}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {diff.data.requirements.length > 0 && (
            <ul className="mt-2 text-xs text-muted">
              {diff.data.requirements.map((r) => (
                <li key={r.key}>
                  <Ltr mono>
                    {r.key}: {JSON.stringify(r.from)} → {JSON.stringify(r.to)}
                  </Ltr>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
