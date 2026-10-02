import type { EvidenceStatus } from '@khalta/engine';
import {
  Button,
  EvidenceChip,
  Input,
  Label,
  Skeleton,
  Textarea,
  toast,
  type EvidenceStatus as UiEvidence,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitCompare, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import { SectionPage } from '../pages/Section';
import { AdHocDrawer } from './AdHocDrawer';
import {
  evaluateMix,
  generate,
  preflight,
  requestTrial,
  saveDraft,
  type AdHocMaterial,
  type Candidate,
  type GenerateResult,
  type MixEvaluation,
  type Objective,
  type PoolMaterial,
  type RequestBody,
  type Requirements,
} from './api';
import { CandidateCard, CompareTable } from './CandidatesStage';
import { CharacteristicsPanel } from './CharacteristicsPanel';
import { buildCharacteristics, dofOf, release, type CharMap } from './characteristics';
import { ComparePlantsDialog } from './ComparePlantsDialog';
import { InspectStage, type Inspectable } from './InspectStage';
import { BlockedPanel, ConflictPanel, DofMeter } from './panels';
import {
  DEFAULT_REQ,
  MixGrid,
  PoolChips,
  RequirementsForm,
  exposureList,
  type MixLine,
  type ReqState,
} from './RequirementsStage';

type Path = 'generate' | 'evaluate';
const STAGES = ['requirements', 'candidates', 'inspect', 'save'] as const;
type Stage = (typeof STAGES)[number];
const KEY = 'khalta.studio.v1';

interface Saved {
  path: Path;
  req: ReqState;
  chars: CharMap;
  objective: Objective;
  excluded: string[];
  adHoc: AdHocMaterial[];
  lines: MixLine[];
}
const readSaved = (): Partial<Saved> => {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Partial<Saved>;
  } catch {
    return {};
  }
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

export function StudioPage() {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const { data: me } = useMe();
  const { plants, selected } = usePlant();
  const qc = useQueryClient();
  const caps = me?.capabilities ?? [];
  const canCost = caps.includes('cost.view');
  const canWrite = caps.includes('design.write');
  const saved = useMemo(readSaved, []);

  const [path, setPath] = useState<Path>(saved.path ?? 'generate');
  const [stage, setStage] = useState<Stage>('requirements');
  const [req, setReq] = useState<ReqState>({ ...DEFAULT_REQ, ...saved.req });
  const [chars, setChars] = useState<CharMap>(saved.chars ?? {});
  const [objective, setObjective] = useState<Objective>(saved.objective ?? 'cheapest');
  const [excluded, setExcluded] = useState<string[]>(saved.excluded ?? []);
  const [adHoc, setAdHoc] = useState<AdHocMaterial[]>(saved.adHoc ?? []);
  const [lines, setLines] = useState<MixLine[]>(saved.lines ?? [{ materialId: '', kg: '' }]);
  const [drawer, setDrawer] = useState(false);
  const [compare, setCompare] = useState(false);

  const [result, setResult] = useState<{ key: string; data: GenerateResult } | null>(null);
  const [mix, setMix] = useState<{
    key: string;
    data: MixEvaluation;
    lines: { materialId: string; kgPerM3: string }[];
  } | null>(null);
  const [pinned, setPinned] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const cancelled = useRef(0);

  const plantId = req.plantId || (selected !== 'all' ? selected : plants[0]?.id) || '';
  const plantOptions = plants.map((p) => ({
    id: p.id,
    label: lang === 'ar' ? p.nameAr : p.nameEn,
  }));

  useEffect(() => {
    try {
      window.localStorage.setItem(
        KEY,
        JSON.stringify({ path, req, chars, objective, excluded, adHoc, lines }),
      );
    } catch {
      /* not remembered */
    }
  }, [path, req, chars, objective, excluded, adHoc, lines]);

  // ---- the request, as the API wants it (null while a field is incomplete)
  const body = useMemo<RequestBody | null>(() => {
    const fc = Number(req.fc);
    const slump = Number(req.slump);
    if (!plantId || !(fc > 0) || !Number.isFinite(slump)) return null;
    const requirements: Requirements = {
      fcMpa: fc,
      basis: req.basis,
      testAgeDays: 28,
      exposure: exposureList(req.exposure),
      slumpMm: slump,
      nmasMm: Number(req.nmas),
      pumpable: req.pumpable,
      s3Option: req.exposure.S === 'S3' ? (Number(req.s3Option) as 1 | 2) : null,
      airPct: null,
    };
    const characteristics = buildCharacteristics(chars);
    return {
      plantId,
      mode: req.mode,
      objective,
      requirements,
      ...(Object.keys(characteristics).length > 0 && { characteristics }),
      ...(excluded.length > 0 && { materials: { exclude: excluded } }),
      ...(adHoc.length > 0 && { adHoc }),
    };
  }, [req, chars, objective, excluded, adHoc, plantId]);
  const key = JSON.stringify(body);
  const debounced = useDebounced(key, 500);

  const pre = useQuery({
    queryKey: ['studio-preflight', debounced],
    queryFn: () => preflight(JSON.parse(debounced) as RequestBody),
    enabled: canWrite && debounced !== 'null',
    placeholderData: (p) => p,
    retry: false,
  });
  const pool: PoolMaterial[] = useMemo(() => {
    const base = pre.data?.pool ?? [];
    const extra: PoolMaterial[] = adHoc.map((a, i) => ({
      id: `adhoc-${i + 1}`,
      category: a.category,
      nameEn: a.market_name_en,
      nameAr: a.market_name_ar ?? null,
      usable: true,
      reason: null,
      hasTest: true,
      source: 'user_declared',
    }));
    return [...base, ...extra];
  }, [pre.data, adHoc]);
  const nameOfMat = (m: PoolMaterial) => (lang === 'ar' ? (m.nameAr ?? m.nameEn) : m.nameEn);
  const nameOf = (id: string) => {
    const m = pool.find((x) => x.id === id);
    return m ? nameOfMat(m) : id.slice(0, 8);
  };
  const aggregates = pool.filter(
    (m) => m.usable && !excluded.includes(m.id) && ['fine_agg', 'coarse_agg'].includes(m.category),
  ).length;
  const dof = result?.data.outcome.dof ?? dofOf(aggregates, chars);

  // ---- actions
  const gen = useMutation({
    mutationFn: async () => {
      const seq = ++cancelled.current;
      const data = await generate(body!);
      if (seq !== cancelled.current) throw new Error('cancelled');
      return { key, data };
    },
    onSuccess: (r) => {
      setResult(r);
      setPinned([]);
      setOpenId(null);
      setStage('candidates');
      void qc.invalidateQueries({ queryKey: ['design-requests'] });
    },
  });
  const ev = useMutation({
    mutationFn: async () => {
      const typed = lines
        .filter((l) => l.materialId && l.kg)
        .map((l) => ({ materialId: l.materialId, kgPerM3: Number(l.kg).toFixed(3) }));
      const { objective: _o, ...rest } = body!;
      const data = await evaluateMix({ ...rest, lines: typed });
      return { key, data, lines: typed };
    },
    onSuccess: (r) => {
      setMix(r);
      setStage('inspect');
    },
  });
  const cancel = () => {
    cancelled.current++;
    gen.reset();
  };
  const err = (e: unknown) =>
    e instanceof ApiError
      ? e.message
      : e instanceof Error && e.message !== 'cancelled'
        ? e.message
        : null;

  const stale = result !== null && result.key !== key;
  const cands = result?.data.candidates ?? [];
  const best = cands[0]?.costJodPerM3 ? Number(cands[0].costJodPerM3) : null;
  const open: Candidate | null = cands.find((c) => c.id === openId) ?? null;
  const pinnedCands = cands.filter((c) => pinned.includes(c.id));

  const inspectable: Inspectable | null =
    path === 'generate' && open
      ? {
          report: open.report,
          lines: open.lines,
          guardrails: open.guardrails,
          validator: open.validator,
          evidence: open.evidence,
          binding: open.binding,
        }
      : path === 'evaluate' && mix
        ? {
            report: mix.data.report,
            lines: mix.lines,
            guardrails: null,
            validator: {
              status: mix.data.validator.status,
              version: mix.data.validator.validatorVersion,
              checked: mix.data.validator.checked,
              mismatches: mix.data.validator.mismatches,
            },
            evidence: mix.data.report.evidence as EvidenceStatus[],
            binding: [],
          }
        : null;

  // ---- save / request trial
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const canAuthorize = caps.includes('candidate.authorize');
  const save = useMutation({
    mutationFn: () => {
      const { objective: _o, ...rest } = body!;
      const l = path === 'generate' && open ? open.lines : (mix?.lines ?? []);
      return saveDraft({ ...rest, code, name, lines: l });
    },
    onSuccess: () => {
      toast.success(t('studio.save.savedDraft'));
      void qc.invalidateQueries({ queryKey: ['designs'] });
    },
  });
  const trial = useMutation({
    mutationFn: () =>
      requestTrial(result!.data.id, open!.id, {
        code,
        name,
        ...(reason.trim() && { authorizationReason: reason.trim() }),
      }),
    onSuccess: () => {
      toast.success(t('studio.save.trialRequested'));
      void qc.invalidateQueries({ queryKey: ['designs'] });
      void qc.invalidateQueries({ queryKey: ['design-request'] });
    },
  });

  if (me && !canWrite) return <SectionPage id="studio" />;

  const blockedByRequest =
    pre.data?.blockers.some((b) => b.code === 'not_supported' || b.code === 'request_infeasible') ??
    false;
  const airEntrained = exposureList(req.exposure).some((c) => ['F1', 'F2', 'F3'].includes(c));
  const ready = body !== null;
  const outcome = result?.data.outcome;
  const labelChar = (id: string) => {
    const [k, sub] = [id.split('.')[0]!, id.includes('.') ? id.slice(id.indexOf('.') + 1) : null];
    const base = t(`studio.chars.${k}`, { defaultValue: id });
    if (!sub) return base;
    const m = pool.find((x) => x.id === sub);
    return `${base} · ${m ? nameOfMat(m) : sub}`;
  };

  return (
    <div className="flex flex-col gap-6" data-testid="studio-page">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold text-heading">{t('nav.studio')}</h1>
        <div role="group" aria-label={t('studio.path.label')} className="flex flex-wrap gap-2">
          {(['evaluate', 'generate'] as const).map((p) => (
            <Button
              key={p}
              variant={path === p ? 'primary' : 'secondary'}
              aria-pressed={path === p}
              onClick={() => {
                setPath(p);
                setStage('requirements');
              }}
              data-testid={`path-${p}`}
            >
              {t(`studio.path.${p}`)}
            </Button>
          ))}
        </div>
        <nav aria-label={t('studio.stages.label')}>
          <ol className="flex flex-wrap gap-2 text-sm">
            {STAGES.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => setStage(s)}
                  aria-current={stage === s ? 'step' : undefined}
                  data-testid={`stage-${s}`}
                  className={`rounded-md border px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-primary ${stage === s ? 'border-primary bg-primary-tint font-semibold' : 'border-line text-muted'}`}
                >
                  {i + 1}. {t(`studio.stage.${s}`)}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <p
          className="rounded-md border border-warn bg-warn-bg px-3 py-2 text-sm text-warn-text"
          data-testid="trial-banner"
        >
          {t('studio.banner')}
        </p>
      </header>

      {stage === 'requirements' && (
        <div className="flex flex-col gap-8">
          <RequirementsForm
            req={{ ...req, plantId }}
            set={(p) => setReq((r) => ({ ...r, ...p }))}
            plants={plantOptions}
            objective={objective}
            setObjective={setObjective}
          />
          <PoolChips
            pool={pool.filter((m) => !m.id.startsWith('adhoc-'))}
            excluded={excluded}
            toggle={(id) =>
              setExcluded((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))
            }
            adHoc={adHoc}
            removeAdHoc={(i) => setAdHoc((c) => c.filter((_, j) => j !== i))}
            nameOf={nameOfMat}
            onAdd={() => setDrawer(true)}
          />
          {path === 'evaluate' && (
            <MixGrid lines={lines} setLines={setLines} pool={pool} nameOf={nameOfMat} />
          )}
          {path === 'generate' && (
            <section className="flex flex-col gap-3" aria-labelledby="chars-title">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="chars-title" className="text-lg font-semibold text-heading">
                  {t('studio.chars.title')}
                </h2>
                <DofMeter dof={dof} />
              </div>
              <p className="max-w-3xl text-sm text-muted">{t('studio.chars.hint')}</p>
              <CharacteristicsPanel
                pool={pool}
                map={chars}
                onChange={setChars}
                bounds={pre.data?.bounds ?? []}
                rejected={pre.data?.characteristics.rejected ?? []}
                nameOf={nameOfMat}
              />
            </section>
          )}
          {pre.data && pre.data.blockers.length > 0 && path === 'generate' && (
            <BlockedPanel blockers={pre.data.blockers} />
          )}
          {pre.isError && (
            <p role="alert" className="text-sm text-fail-text">
              {err(pre.error)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {path === 'generate' ? (
              <Button
                onClick={() => gen.mutate()}
                disabled={
                  !ready ||
                  gen.isPending ||
                  airEntrained ||
                  blockedByRequest ||
                  (pre.data ? !pre.data.characteristics.ok : false)
                }
                data-testid="generate"
              >
                <Play className="size-4" aria-hidden />
                {gen.isPending ? t('studio.generating') : t('studio.generate')}
              </Button>
            ) : (
              <Button
                onClick={() => ev.mutate()}
                disabled={
                  !ready || ev.isPending || lines.filter((l) => l.materialId && l.kg).length < 2
                }
                data-testid="evaluate"
              >
                <Play className="size-4" aria-hidden />
                {t('studio.evaluate')}
              </Button>
            )}
            {gen.isPending && (
              <Button variant="secondary" onClick={cancel} data-testid="generate-cancel">
                {t('studio.cancel')}
              </Button>
            )}
            {path === 'generate' && (
              <Button
                variant="secondary"
                onClick={() => setCompare(true)}
                disabled={!ready}
                data-testid="compare-plants-open"
              >
                <GitCompare className="size-4" aria-hidden />
                {t('studio.compare.open')}
              </Button>
            )}
            {(err(gen.error) || err(ev.error)) && (
              <p role="alert" className="text-sm text-fail-text" data-testid="studio-error">
                {err(gen.error) ?? err(ev.error)}
              </p>
            )}
          </div>
        </div>
      )}

      {stage === 'candidates' && (
        <section
          className="flex flex-col gap-4"
          aria-label={t('studio.stage.candidates')}
          data-testid="candidates-stage"
        >
          {gen.isPending && <Skeleton className="h-40 w-full" />}
          {!result && !gen.isPending && (
            <p className="text-sm text-muted">{t('studio.cand.empty')}</p>
          )}
          {stale && (
            <p
              role="status"
              className="rounded-md border border-warn bg-warn-bg p-2 text-sm text-warn-text"
              data-testid="stale-banner"
            >
              {t('studio.cand.stale')}
            </p>
          )}
          {outcome && (
            <div className="flex flex-wrap items-center gap-3">
              <DofMeter dof={outcome.dof ?? dof} />
              <p className="text-xs text-muted" data-testid="search-stats">
                {t('studio.cand.stats', {
                  solved: outcome.stats.solved,
                  enumerated: outcome.stats.enumerated,
                })}
              </p>
            </div>
          )}
          {result?.data.status === 'blocked' && <BlockedPanel blockers={outcome!.blockers} />}
          {result?.data.status === 'infeasible' && outcome?.conflicts && (
            <ConflictPanel
              conflicts={outcome.conflicts}
              label={labelChar}
              onRelease={(id) => {
                setChars((m) => release(m, id));
                setStage('requirements');
                setTimeout(() => gen.mutate(), 0);
              }}
            />
          )}
          {result?.data.status === 'no_valid_candidate' && (
            <p
              role="alert"
              className="rounded-md border border-fail bg-fail-bg p-3 text-sm text-fail-text"
              data-testid="no-valid"
            >
              {t('studio.cand.noValid')}
              {outcome?.notes.map((n, i) => (
                <span key={i} className="block">
                  {n.detail}
                </span>
              ))}
            </p>
          )}
          {cands.length > 0 && (
            <>
              <div
                className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
                data-testid="candidate-grid"
              >
                {cands.map((c) => (
                  <CandidateCard
                    key={c.id}
                    c={c}
                    best={best}
                    nameOf={nameOf}
                    canCost={canCost}
                    pinned={pinned.includes(c.id)}
                    canPin={pinned.length < 4}
                    onPin={(on) =>
                      setPinned((p) => (on ? [...p, c.id] : p.filter((x) => x !== c.id)))
                    }
                    onOpen={() => {
                      setOpenId(c.id);
                      setStage('inspect');
                    }}
                  />
                ))}
              </div>
              {pinnedCands.length >= 2 && (
                <section aria-labelledby="cmp-title" className="flex flex-col gap-2">
                  <h3 id="cmp-title" className="font-semibold">
                    {t('studio.cmp.title')}
                  </h3>
                  <CompareTable cands={pinnedCands} nameOf={nameOf} canCost={canCost} />
                </section>
              )}
            </>
          )}
        </section>
      )}

      {stage === 'inspect' && (
        <section aria-label={t('studio.stage.inspect')} data-testid="inspect-section">
          {inspectable ? (
            <InspectStage item={inspectable} nameOf={nameOf} canCost={canCost} />
          ) : (
            <p className="text-sm text-muted">{t('studio.inspect.none')}</p>
          )}
        </section>
      )}

      {stage === 'save' && (
        <section
          className="flex max-w-2xl flex-col gap-4"
          aria-label={t('studio.stage.save')}
          data-testid="save-stage"
        >
          {!inspectable ? (
            <p className="text-sm text-muted">{t('studio.inspect.none')}</p>
          ) : (
            <>
              <div className="flex flex-col gap-2" data-testid="evidence-gaps">
                <h3 className="font-semibold">{t('studio.save.gaps')}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {inspectable.evidence.map((e) => (
                    <EvidenceChip key={e} status={e as UiEvidence} />
                  ))}
                </div>
                <p className="text-sm text-muted">{t('studio.save.gapsHint')}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="sv-code">{t('studio.save.code')}</Label>
                  <Input
                    id="sv-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    data-testid="save-code"
                    dir="ltr"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="sv-name">{t('studio.save.name')}</Label>
                  <Input
                    id="sv-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    data-testid="save-name"
                  />
                </div>
              </div>
              {path === 'generate' && open?.requiresAuthorization && (
                <div className="flex flex-col gap-1" data-testid="authorization">
                  <p className="text-sm text-fail-text">
                    {canAuthorize ? t('studio.save.authorize') : t('studio.save.needsManager')}
                  </p>
                  {canAuthorize && (
                    <>
                      <Label htmlFor="sv-reason">{t('studio.save.reason')}</Label>
                      <Textarea
                        id="sv-reason"
                        rows={3}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        data-testid="save-reason"
                      />
                    </>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="secondary"
                  onClick={() => save.mutate()}
                  disabled={
                    code.trim().length < 2 || name.trim().length < 2 || save.isPending || !ready
                  }
                  data-testid="save-draft"
                >
                  {t('studio.save.draft')}
                </Button>
                <Button
                  onClick={() => trial.mutate()}
                  disabled={
                    path !== 'generate' ||
                    !open ||
                    open.validator.status !== 'pass' ||
                    stale ||
                    code.trim().length < 2 ||
                    name.trim().length < 2 ||
                    trial.isPending ||
                    !caps.includes('trial.request') ||
                    (open.requiresAuthorization && (!canAuthorize || reason.trim().length < 10))
                  }
                  data-testid="request-trial"
                >
                  {t('studio.save.trial')}
                </Button>
              </div>
              {path !== 'generate' && (
                <p className="text-xs text-muted">{t('studio.save.trialGenerated')}</p>
              )}
              {stale && <p className="text-xs text-warn-text">{t('studio.cand.stale')}</p>}
              {[save.error, trial.error].map((e, i) =>
                err(e) ? (
                  <p
                    key={i}
                    role="alert"
                    className="text-sm text-fail-text"
                    data-testid="save-error"
                  >
                    {err(e)}
                  </p>
                ) : null,
              )}
              {trial.data && (
                <p role="status" className="text-sm text-pass-text" data-testid="trial-done">
                  {t('studio.save.trialDone', { code: trial.data.design.code })}
                </p>
              )}
              {save.data && (
                <p role="status" className="text-sm text-pass-text" data-testid="draft-done">
                  {t('studio.save.draftDone', { code: save.data.code })}
                </p>
              )}
            </>
          )}
        </section>
      )}

      <AdHocDrawer
        open={drawer}
        onOpenChange={setDrawer}
        onAdd={(m) => setAdHoc((c) => [...c, m])}
      />
      {body && (
        <ComparePlantsDialog
          open={compare}
          onOpenChange={setCompare}
          body={(({ plantId: _p, ...rest }) => rest)(body)}
          plants={plants}
          currentPlantId={plantId}
          canCost={canCost}
        />
      )}
    </div>
  );
}
