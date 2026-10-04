// Background jobs (01-domain §8). pg-boss on the existing PostgreSQL (its own schema), no Redis. Routes only ever
// call `enqueue`; handlers live in `insights/triggers.ts` and are plain functions, so tests can call them directly.
import type { Db } from '@khalta/db';
import { PgBoss } from 'pg-boss';
import type { Config } from '../config';

export const JOB_NAMES = [
  'price-change',
  'material-test',
  'rule-change',
  'strength-result',
  'change-impact',
  'nightly',
  'backup',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export interface EnqueueOptions {
  /** One pending job per key: a burst of edits becomes one job. */
  singletonKey?: string;
  delaySeconds?: number;
}
export interface Jobs {
  enqueue(name: JobName, data: Record<string, unknown>, opts?: EnqueueOptions): Promise<void>;
}

/** Records instead of queueing (API tests, and any process that runs without a worker). */
export class RecordingJobs implements Jobs {
  readonly sent: {
    name: JobName;
    data: Record<string, unknown>;
    opts: EnqueueOptions | undefined;
  }[] = [];
  async enqueue(name: JobName, data: Record<string, unknown>, opts?: EnqueueOptions) {
    this.sent.push({ name, data, opts });
  }
}

export const queueNameOf = (n: JobName) => `khalta.${n}`;

export function createBossJobs(boss: PgBoss): Jobs {
  return {
    async enqueue(name, data, opts) {
      await boss.send(queueNameOf(name), data, {
        ...(opts?.singletonKey ? { singletonKey: opts.singletonKey } : {}),
        ...(opts?.delaySeconds ? { startAfter: opts.delaySeconds } : {}),
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
      });
    },
  };
}

export type Handler = (data: Record<string, unknown>) => Promise<void>;

export interface Worker {
  boss: PgBoss;
  jobs: Jobs;
  status(): Promise<unknown>;
  stop(): Promise<void>;
}

/**
 * Starts pg-boss, registers the queues and handlers, and schedules the backup (01:30) and the nightly sweep (02:00 Asia/Amman).
 * `handlers` is injected so this module does not import the trigger code (and tests can stub it).
 */
export async function startWorker(
  config: Pick<Config, 'DATABASE_URL'>,
  handlers: Record<JobName, Handler>,
  onError: (e: unknown, name: string) => void = () => {},
): Promise<Worker> {
  const boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (e) => onError(e, 'boss'));
  await boss.start();
  for (const n of JOB_NAMES) {
    const q = queueNameOf(n);
    // `short`: at most one QUEUED job per singleton key, so a burst of edits becomes one job (the debounce)
    await boss.createQueue(q, { policy: 'short' });
    await boss.work(q, { pollingIntervalSeconds: 2 }, async (jobs) => {
      for (const j of jobs) {
        try {
          await handlers[n](j.data as Record<string, unknown>);
        } catch (e) {
          onError(e, n);
          throw e; // pg-boss retries with back-off
        }
      }
    });
  }
  await boss.schedule(queueNameOf('nightly'), '0 2 * * *', {}, { tz: 'Asia/Amman' });
  await boss.schedule(queueNameOf('backup'), '30 1 * * *', {}, { tz: 'Asia/Amman' });
  return {
    boss,
    jobs: createBossJobs(boss),
    status: async () => ({
      mode: 'pg-boss',
      queues: (await boss.getQueues()).map((q) => ({
        name: q.name,
        queued: q.queuedCount,
        active: q.activeCount,
        total: q.totalCount,
      })),
    }),
    stop: async () => {
      await boss.stop({ graceful: true });
    },
  };
}

export type { Db };
