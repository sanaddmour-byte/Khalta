import { Button, Input, Label, Ltr, toast } from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { recordVolume, volumesQuery } from '../insights/api';
import type { DesignCard } from './api';

const LIVE = ['approved', 'in_production', 'superseded'];

/** Production volume per month (F-026): append-only; the latest row per month is in force; a correction needs a note. */
export function VolumesSection({ design }: { design: DesignCard }) {
  const { t } = useTranslation();
  const f = useFormat();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  const live = LIVE.includes(design.status);
  const q = useQuery({ ...volumesQuery(design.id), enabled: live });
  const [month, setMonth] = useState('');
  const [volume, setVolume] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () =>
      recordVolume({
        designId: design.id,
        month,
        volumeM3: Number(volume),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['volumes', design.id] });
      await qc.invalidateQueries({ queryKey: ['savings'] });
      toast.success(t('volumes.saved'));
      setVolume('');
      setNote('');
    },
  });
  if (!live) return null;
  const err = m.error instanceof ApiError ? m.error.message : null;
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && volume !== '' && Number(volume) >= 0;
  return (
    <section className="mt-6" aria-label={t('volumes.title')} data-testid="volumes-section">
      <h3 className="mb-1 text-sm font-semibold text-heading">{t('volumes.title')}</h3>
      <p className="mb-2 text-xs text-muted">{t('volumes.hint')}</p>
      {q.data && q.data.inForce.length === 0 && (
        <p className="text-sm text-muted">{t('volumes.none')}</p>
      )}
      {q.data && q.data.inForce.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1 text-sm" data-testid="volumes-list">
          {q.data.history.map((h, i) => (
            <li key={h.id} className="flex flex-wrap gap-x-3" data-testid="volume-row">
              <Ltr mono>{h.month.slice(0, 7)}</Ltr>
              <Ltr>{t('library.unit.m3', { n: f.number(Number(h.volumeM3)) })}</Ltr>
              {i > 0 && h.month === q.data.history[i - 1]!.month ? (
                <span className="text-xs text-muted">{t('volumes.superseded')}</span>
              ) : (
                <span className="text-xs text-muted">{t('volumes.inForce')}</span>
              )}
              {h.note && <span className="text-xs text-muted">{h.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {caps.includes('lab.enter') && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="vol-month">{t('volumes.month')}</Label>
            <Input
              id="vol-month"
              data-testid="vol-month"
              dir="ltr"
              placeholder="2026-08"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="vol-volume">{t('volumes.volume')}</Label>
            <Input
              id="vol-volume"
              data-testid="vol-volume"
              dir="ltr"
              inputMode="decimal"
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="vol-note">{t('volumes.note')}</Label>
            <Input
              id="vol-note"
              data-testid="vol-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="sm:col-span-3">
            <Button
              onClick={() => m.mutate()}
              disabled={!valid || m.isPending}
              data-testid="vol-submit"
            >
              {t('volumes.record')}
            </Button>
          </div>
        </div>
      )}
      {err && (
        <p role="alert" className="mt-2 text-sm text-fail-text" data-testid="vol-error">
          {err}
        </p>
      )}
    </section>
  );
}
