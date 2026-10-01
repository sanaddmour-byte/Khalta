import { Select as RSelect } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../cn';

export const Select = RSelect.Root;
export const SelectValue = RSelect.Value;

export const SelectTrigger = ({
  className,
  children,
  ...p
}: ComponentProps<typeof RSelect.Trigger>) => (
  <RSelect.Trigger
    className={cn(
      'inline-flex h-10 w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 text-sm text-body data-[placeholder]:text-muted',
      className,
    )}
    {...p}
  >
    <span className="truncate">{children}</span>
    <RSelect.Icon>
      <ChevronDown className="size-4 text-muted" aria-hidden />
    </RSelect.Icon>
  </RSelect.Trigger>
);

export const SelectContent = ({
  className,
  children,
  ...p
}: ComponentProps<typeof RSelect.Content>) => (
  <RSelect.Portal>
    <RSelect.Content
      position="popper"
      sideOffset={4}
      className={cn(
        'z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-surface text-body shadow-lg',
        className,
      )}
      {...p}
    >
      <RSelect.Viewport className="p-1">{children}</RSelect.Viewport>
    </RSelect.Content>
  </RSelect.Portal>
);

export const SelectItem = ({ className, children, ...p }: ComponentProps<typeof RSelect.Item>) => (
  <RSelect.Item
    className={cn(
      'relative flex cursor-default items-center rounded-sm py-1.5 ps-8 pe-2 text-sm outline-none data-[highlighted]:bg-primary-tint',
      className,
    )}
    {...p}
  >
    <RSelect.ItemIndicator className="absolute start-2">
      <Check className="size-4" aria-hidden />
    </RSelect.ItemIndicator>
    <RSelect.ItemText>{children}</RSelect.ItemText>
  </RSelect.Item>
);
