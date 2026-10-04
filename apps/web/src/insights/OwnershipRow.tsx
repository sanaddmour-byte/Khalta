import {
  Button,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OctagonAlert, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { acknowledgeInsight, assigneesQuery, assignInsight, type Insight } from './api';

/** Owner, acknowledgement and deadline of a high or critical alert. Escalation is by the hourly job; nothing here changes a design. */
export function OwnershipRow({ insight }: { insight: Insight }) {
  const { t } = useTranslation();
  const f = useFormat();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  const own = insight.ownership;
  const [pick, setPick] = useState('');
  const canAssign = caps.includes('insight.accept');
  const people = useQuery({ ...assigneesQuery(insight.id), enabled: canAssign });
  const refresh = () => qc.invalidateQueries({ queryKey: ['insights'] });
  const fail = (e: unknown) =>
    toast.error(e instanceof ApiError ? e.message : t('insights.owner.failed'));
  const assign = useMutation({
    mutationFn: () => assignInsight(insight.id, pick),
    onSuccess: refresh,
    onError: fail,
  });
  const ack = useMutation({
    mutationFn: () => acknowledgeInsight(insight.id),
    onSuccess: refresh,
    onError: fail,
  });
  if (!own || (insight.severity !== 'critical' && insight.severity !== 'high')) return null;
  const mine = own.ownerId === me?.user.id;
  const alarming = own.state === 'overdue' || own.state === 'escalated';
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 text-xs"
      data-testid="ownership"
      data-state={own.state}
    >
      <span
        className={`inline-flex items-center gap-1 font-medium ${alarming ? 'text-fail-text' : 'text-muted'}`}
      >
        {alarming ? (
          <OctagonAlert className="size-3.5" aria-hidden />
        ) : (
          <UserCheck className="size-3.5" aria-hidden />
        )}
        {t(`insights.owner.state.${own.state}`)}
      </span>
      {own.ownerName && <span>{own.ownerName}</span>}
      {own.dueAt ? (
        <span className="text-muted">
          {t('insights.owner.due')} <Ltr>{f.dateTime(own.dueAt)}</Ltr>
        </span>
      ) : (
        own.state !== 'unassigned' && (
          <span className="text-muted">{t('insights.owner.noDeadline')}</span>
        )
      )}
      {own.state !== 'acknowledged' && own.state !== 'unassigned' && (mine || canAssign) && (
        <Button
          variant="secondary"
          onClick={() => ack.mutate()}
          disabled={ack.isPending}
          data-testid="ack"
        >
          {t('insights.owner.acknowledge')}
        </Button>
      )}
      {canAssign && (
        <>
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger
              className="h-8 w-44"
              aria-label={t('insights.owner.assignTo')}
              data-testid="owner-pick"
            >
              <SelectValue placeholder={t('insights.owner.assignTo')} />
            </SelectTrigger>
            <SelectContent>
              {(people.data ?? []).map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="secondary"
            disabled={!pick || assign.isPending}
            onClick={() => assign.mutate()}
            data-testid="assign"
          >
            {t('insights.owner.assign')}
          </Button>
        </>
      )}
    </div>
  );
}
