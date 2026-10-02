// Pure evaluator kernel (no I/O). Real pipeline arrives in M2.1.
export const ENGINE_API_VERSION = 1;

export interface TraceEntry {
  readonly key: string;
  readonly source: string;
}

export type Trace = readonly TraceEntry[];

export * from './materials';
export * from './prices';
export * from './legacy';
export * from './lifecycle';
export * from './evaluate/types';
export * from './characteristics';
export * from './profiles';
export * from './approval/trial';
export * from './approval/gates';
export * from './approval/classify';
