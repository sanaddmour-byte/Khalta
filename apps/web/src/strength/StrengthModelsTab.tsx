import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Label,
  Ltr,
  Skeleton,
  Table,
  Td,
  Textarea,
  Th,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, CircleAlert, CircleHelp, ShieldOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import {
  approveModel,
  betaQuery,
  modelQuery,
  modelsQuery,
  refit,
  retireModel,
  sProposalQuery,
  type ModelList,
  type StrengthModel,
} from './api';
import { ModelChart } from './ModelChart';

const chip = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium';

function StatusChip({ m }: { m: StrengthModel }) {
  const { t } = useTranslation();
  if (m.retiredAt)
    return (
      <span
        className={`${chip} border-line text-muted`}
        data-testid="model-status"
        data-status="retired"
      >
        <ShieldOff className="size-3.5" aria-hidden />
        {t('strength.status.retired')}
      </span>
    );
  if (m.inForce)
    return (
      <span
        className={`${chip} border-pass bg-pass-bg text-pass-text`}
        data-testid="model-status"
        data-status="in_force"
      >
        <BadgeCheck className="size-3.5" aria-hidden />
        {t('strength.status.inForce')}
      </span>
    );
  if (m.status === 'valid')
    return (
      <span
        className={`${chip} border-olive bg-olive-tint text-olive-text`}
        data-testid="model-status"
        data-status="valid"
      >
        <CircleHelp className="size-3.5" aria-hidden />
        {t('strength.status.validProposal')}
      </span>
    );
  return (
    <span
      className={`${chip} border-warn bg-warn-bg text-warn-text`}
      data-testid="model-status"
      data-status={m.status}
    >
      <CircleAlert className="size-3.5" aria-hidden />
      {t(`strength.status.${m.status}`)}
    </span>
  );
}

function SignDialog({
  model,
  action,
  onClose,
}: {
  model: StrengthModel;
  action: 'approve' | 'retire';
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () =>
      action === 'approve'
        ? approveModel(model.id, reason.trim())
        : retireModel(model.id, reason.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['strength'] });
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('strength.done'));
      onClose();
    },
  });
  const err = m.error instanceof ApiError ? m.error.message : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        closeLabel={t('ui.close')}
        className="max-w-xl"
        data-testid="model-sign-dialog"
      >
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t(`strength.sign.title.${action}`)}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t(`strength.sign.meaning.${action}`)}
        </DialogDescription>
        <div className="flex flex-col gap-1">
          <Label htmlFor="model-reason">{t('lifecycle.sign.reason')}</Label>
          <Textarea
            id="model-reason"
            data-testid="model-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <p className="mt-3 rounded-md bg-olive-tint p-3 text-sm text-olive-text">
          {t('lifecycle.sign.scope')}
        </p>
        {err && (
          <p role="alert" className="mt-3 text-sm text-fail-text" data-testid="model-sign-error">
            {err}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('rules.cancel')}
          </Button>
          <Button
            disabled={reason.trim().length < 5 || m.isPending}
            onClick={() => m.mutate()}
            data-testid="model-sign-submit"
          >
            {t('lifecycle.sign.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModelCard({ m, names }: { m: StrengthModel; names: ModelList['materials'] }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  const [open, setOpen] = useState(false);
  const [signing, setSigning] = useState<'approve' | 'retire' | null>(null);
  const detail = useQuery({ ...modelQuery(m.id), enabled: open });
  const nm = (id: string) => {
    const x = names[id];
    return x ? (lang === 'ar' ? (x.nameAr ?? x.nameEn) : x.nameEn) : id.slice(0, 8);
  };
  const g = m.group;
  const fmt = (v: string, d = 3) => f.number(Number(v), { maximumFractionDigits: d });
  const pts = useMemo(
    () =>
      (detail.data?.points ?? [])
        .filter((p) => p.included && p.wcm !== null)
        .map((p) => ({ wcm: Number(p.wcm), mpa: Number(p.mpa) })),
    [detail.data],
  );
  const excluded = (detail.data?.points ?? []).filter((p) => !p.included);
  const canApprove = caps.includes('design.approve');
  return (
    <li
      className="rounded-lg border border-line bg-surface p-4"
      data-testid="model-card"
      data-status={m.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip m={m} />
        <h3 className="text-base font-semibold text-heading">
          {t('strength.group', { age: m.ageDays, basis: t(`strength.basis.${m.basis}`) })}
        </h3>
      </div>
      <p className="mt-1 text-sm" data-testid="model-group">
        {t('strength.groupLine', {
          cement: nm(g.cementId),
          scm: g.scm.length ? g.scm.map((x) => nm(x.id)).join(', ') : t('strength.none'),
          adm: g.admixtures.length
            ? g.admixtures.map((x) => nm(x.id)).join(', ')
            : t('strength.none'),
        })}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">{t('strength.col.n')}</dt>
          <dd data-testid="model-n">{f.number(m.n)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('strength.col.levels')}</dt>
          <dd>{f.number(m.levels)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('strength.col.domain')}</dt>
          <dd>
            <Ltr>
              {fmt(m.wcmMin, 2)} – {fmt(m.wcmMax, 2)}
            </Ltr>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('strength.col.s')}</dt>
          <dd>
            <Ltr>{t('evaluation.unit.mpa', { n: fmt(m.sMpa, 2) })}</Ltr>
          </dd>
        </div>
      </dl>
      {m.reasons.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-sm text-warn-text" data-testid="model-reasons">
          {m.reasons.map((r) => (
            <li key={r.code} data-code={r.code}>
              {t(`strength.reason.${r.code}`, { defaultValue: r.code })}
              <span className="block text-xs text-muted" dir="auto">
                {r.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">{t('strength.notCompliance')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setOpen((o) => !o)} data-testid="model-details">
          {open ? t('strength.hide') : t('strength.show')}
        </Button>
        {canApprove && m.status === 'valid' && !m.approvedAt && !m.retiredAt && (
          <Button onClick={() => setSigning('approve')} data-testid="model-approve">
            {t('strength.approve')}
          </Button>
        )}
        {canApprove && m.inForce && (
          <Button
            variant="secondary"
            onClick={() => setSigning('retire')}
            data-testid="model-retire"
          >
            {t('strength.retire')}
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-4 flex flex-col gap-3" data-testid="model-detail">
          {detail.isLoading && <Skeleton className="h-40 w-full" />}
          {detail.data && (
            <>
              <ModelChart
                a={Number(m.a)}
                b={Number(m.b)}
                s={Number(m.sMpa)}
                wcmMin={Number(m.wcmMin)}
                wcmMax={Number(m.wcmMax)}
                points={pts}
              />
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted">{t('strength.col.curve')}</dt>
                  <dd>
                    <Ltr>{t('strength.curveLine', { a: fmt(m.a, 4), b: fmt(m.b, 4) })}</Ltr>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">{t('strength.col.se')}</dt>
                  <dd>
                    <Ltr>
                      ±{fmt(m.seA, 4)} / ±{fmt(m.seB, 4)}
                    </Ltr>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">{t('strength.r2')}</dt>
                  <dd>
                    <Ltr>{fmt(m.r2, 3)}</Ltr>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">{t('strength.col.heldOut')}</dt>
                  <dd data-testid="model-heldout">
                    {m.heldOut ? (
                      <Ltr>
                        {t('strength.heldOutLine', {
                          rmse: f.number(m.heldOut.rmseMpa, { maximumFractionDigits: 2 }),
                          miss: f.number(m.heldOut.worstMissMpa, { maximumFractionDigits: 2 }),
                        })}
                      </Ltr>
                    ) : (
                      t('strength.noHeldOut')
                    )}
                  </dd>
                </div>
              </dl>
              {excluded.length > 0 && (
                <p className="text-xs text-muted" data-testid="model-excluded">
                  {t('strength.excluded', { n: excluded.length })}{' '}
                  {[...new Set(excluded.map((e) => e.exclusion))]
                    .map((c) => t(`strength.exclusion.${c}`, { defaultValue: String(c) }))
                    .join(', ')}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {signing && <SignDialog model={m} action={signing} onClose={() => setSigning(null)} />}
    </li>
  );
}

function Proposals({ plantId }: { plantId: string | undefined }) {
  const { t } = useTranslation();
  const f = useFormat();
  const s = useQuery(sProposalQuery(plantId));
  const beta = useQuery({ ...betaQuery(plantId ?? ''), enabled: !!plantId });
  return (
    <section aria-label={t('strength.proposals.title')} className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-heading">{t('strength.proposals.title')}</h2>
      <p className="max-w-3xl text-sm text-muted">{t('strength.proposals.hint')}</p>
      <div data-testid="s-proposals">
        <h3 className="mb-1 text-sm font-semibold text-heading">{t('strength.s.title')}</h3>
        {s.data && s.data.proposals.length === 0 && (
          <p className="text-sm text-muted">{t('strength.s.none')}</p>
        )}
        {s.data && s.data.proposals.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">{t('strength.s.title')}</caption>
              <thead>
                <tr>
                  <Th>{t('library.col.code')}</Th>
                  <Th>{t('strength.col.n')}</Th>
                  <Th>{t('strength.col.s')}</Th>
                  <Th className="hidden md:table-cell">{t('strength.s.condition')}</Th>
                </tr>
              </thead>
              <tbody>
                {s.data.proposals.map((p) => (
                  <tr key={p.designId} className="border-t border-line" data-testid="s-row">
                    <Td>
                      <Ltr mono>
                        {p.code} {t('versions.short', { n: p.version })}
                      </Ltr>
                    </Td>
                    <Td>{f.number(p.n)}</Td>
                    <Td className="whitespace-nowrap">
                      <Ltr>
                        {p.sMpa === null
                          ? '–'
                          : t('evaluation.unit.mpa', {
                              n: f.number(p.sMpa, { maximumFractionDigits: 2 }),
                            })}
                      </Ltr>
                      {p.higherThanModel && (
                        <span className="block text-xs text-warn-text">
                          {t('strength.s.higher')}
                        </span>
                      )}
                    </Td>
                    <Td className="hidden md:table-cell">
                      {p.enoughForCode ? t('strength.s.enough') : t('strength.s.notEnough')}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
      <div data-testid="beta-proposal">
        <h3 className="mb-1 text-sm font-semibold text-heading">{t('strength.beta.title')}</h3>
        {!plantId && <p className="text-sm text-muted">{t('strength.beta.pickPlant')}</p>}
        {beta.data && !beta.data.proposal.ok && (
          <ul className="list-disc ps-5 text-sm text-muted" data-testid="beta-missing">
            {beta.data.proposal.missing.map((m) => (
              <li key={m.code}>{t(`strength.beta.missing.${m.code}`, { defaultValue: m.code })}</li>
            ))}
          </ul>
        )}
        {beta.data?.proposal.ok && (
          <p className="text-sm" data-testid="beta-values">
            <Ltr>
              {t('strength.betaLine', {
                fm: f.number(beta.data.proposal.betaFm ?? 0, { maximumFractionDigits: 3 }),
                p75: f.number(beta.data.proposal.betaP75 ?? 0, { maximumFractionDigits: 3 }),
              })}
            </Ltr>
          </p>
        )}
        <p className="mt-1 text-xs text-muted">{t('strength.beta.note')}</p>
      </div>
    </section>
  );
}

/** Strength models (F-028): proposals with their evidence, an e-signed approval, and the proposals that need a person. */
export function StrengthModelsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { selected } = usePlant();
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  const plantId = selected && selected !== 'all' ? selected : undefined;
  const list = useQuery(modelsQuery(plantId));
  const run = useMutation({
    mutationFn: () => refit(plantId),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['strength'] });
      toast.success(t('strength.refitDone', { n: r.groups.length }));
    },
  });
  return (
    <div className="flex flex-col gap-6" data-testid="strength-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">{t('strength.intro')}</p>
        {caps.includes('design.write') && (
          <Button onClick={() => run.mutate()} disabled={run.isPending} data-testid="refit">
            {t('strength.refit')}
          </Button>
        )}
      </div>
      {list.isLoading && <Skeleton className="h-24 w-full" />}
      {list.data && list.data.models.length === 0 && (
        <EmptyState
          title={t('strength.empty.title')}
          description={t('strength.empty.description')}
        />
      )}
      <ul className="flex flex-col gap-3" data-testid="model-list">
        {list.data?.models.map((m) => (
          <ModelCard key={m.id} m={m} names={list.data.materials} />
        ))}
      </ul>
      {list.data && list.data.unassigned.length > 0 && (
        <p className="text-sm text-warn-text" data-testid="unassigned">
          {t('strength.unassigned', {
            n: list.data.unassigned.reduce((a, u) => a + u.sets, 0),
            designs: list.data.unassigned.length,
          })}
        </p>
      )}
      <Proposals plantId={plantId} />
    </div>
  );
}
