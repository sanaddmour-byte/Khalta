// Pure evaluator kernel (no I/O). Real pipeline arrives in M2.1.
export const ENGINE_API_VERSION = 1;

export interface TraceEntry {
  readonly key: string;
  readonly source: string;
}

export type Trace = readonly TraceEntry[];

export * from './materials';
export * from './prices';
