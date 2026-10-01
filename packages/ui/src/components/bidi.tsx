import type { HTMLAttributes } from 'react';
import { cn } from '../cn';

/**
 * Isolates mixed-direction tokens (units, strength classes, product codes, clause refs, numbers
 * with units) so surrounding Arabic text can never reorder them. `mono` is for product codes.
 */
export function Ltr({ mono, className, ...p }: HTMLAttributes<HTMLElement> & { mono?: boolean }) {
  return <bdi dir="ltr" className={cn('tabular', mono && 'font-mono', className)} {...p} />;
}
