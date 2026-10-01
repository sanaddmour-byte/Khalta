import { Direction } from 'radix-ui';
import type { ReactNode } from 'react';

export type Dir = 'ltr' | 'rtl';

export const DirectionProvider = ({ dir, children }: { dir: Dir; children: ReactNode }) => (
  <Direction.DirectionProvider dir={dir}>{children}</Direction.DirectionProvider>
);
export const useDir = (): Dir => Direction.useDirection();
