import { ApiError } from '../lib/api';

/** An audited CSV export (POST); the browser saves it under the server's name (it carries the file hash stem). */
export async function downloadCsv(path: string, body: object, fallbackName: string) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* keep the status text */
    }
    throw new ApiError(res.status, message);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const name = m ? decodeURIComponent(m[1]!) : fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

export const exportDesigns = (plantId?: string) =>
  downloadCsv('/api/exports/designs.csv', plantId ? { plantId } : {}, 'khalta-designs.csv');
export const exportBatch = (instanceId: string) =>
  downloadCsv('/api/exports/batch-weights.csv', { instanceId }, 'khalta-batch-weights.csv');
export const exportBatchPlan = (instanceId: string) =>
  downloadCsv('/api/exports/batch-plans.csv', { instanceId }, 'khalta-batch-plans.csv');
