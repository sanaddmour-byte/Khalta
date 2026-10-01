import { Separator as RSeparator, Tabs as RTabs } from 'radix-ui';
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

export const Separator = ({ className, ...p }: ComponentProps<typeof RSeparator.Root>) => (
  <RSeparator.Root
    className={cn(
      'bg-line data-[orientation=horizontal]:h-px data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch',
      className,
    )}
    {...p}
  />
);

export const Card = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('rounded-lg border border-line bg-surface p-4', className)} {...p} />
);

export const Skeleton = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div
    aria-hidden
    className={cn(
      'h-4 animate-[k-skeleton_1.2s_ease-in-out_infinite] rounded-md bg-line',
      className,
    )}
    {...p}
  />
);

export const Tabs = RTabs.Root;
export const TabsList = ({ className, ...p }: ComponentProps<typeof RTabs.List>) => (
  <RTabs.List className={cn('inline-flex gap-1 border-b border-line', className)} {...p} />
);
export const TabsTrigger = ({ className, ...p }: ComponentProps<typeof RTabs.Trigger>) => (
  <RTabs.Trigger
    className={cn(
      '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted data-[state=active]:border-primary data-[state=active]:text-heading',
      className,
    )}
    {...p}
  />
);
export const TabsContent = RTabs.Content;

/* Table primitives: numeric cells are end-aligned with tabular numerals. */
export const Table = ({ className, ...p }: HTMLAttributes<HTMLTableElement>) => (
  <table className={cn('w-full border-collapse text-sm', className)} {...p} />
);
export const Th = ({
  className,
  numeric,
  ...p
}: HTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) => (
  <th
    scope="col"
    className={cn(
      'h-[var(--row-h)] border-b border-line px-3 text-start font-medium text-muted',
      numeric && 'text-end',
      className,
    )}
    {...p}
  />
);
export const Td = ({
  className,
  numeric,
  ...p
}: HTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) => (
  <td
    className={cn(
      'h-[var(--row-h)] border-b border-line px-3',
      numeric && 'tabular text-end',
      className,
    )}
    {...p}
  />
);

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-dashed border-line p-10 text-center',
        className,
      )}
    >
      {icon && <div className="text-muted">{icon}</div>}
      <h2 className="text-lg font-semibold text-heading">{title}</h2>
      {description && <p className="max-w-md text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}
