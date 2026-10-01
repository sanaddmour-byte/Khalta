import { Checkbox as RCheckbox, Label as RLabel, Switch as RSwitch } from 'radix-ui';
import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../cn';

export const Input = ({ className, ...p }: ComponentProps<'input'>) => (
  <input
    className={cn(
      'h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-body placeholder:text-muted disabled:opacity-50 aria-[invalid=true]:border-fail',
      className,
    )}
    {...p}
  />
);

export const Label = ({ className, ...p }: ComponentProps<typeof RLabel.Root>) => (
  <RLabel.Root className={cn('text-sm font-medium text-heading', className)} {...p} />
);

export const Checkbox = ({ className, ...p }: ComponentProps<typeof RCheckbox.Root>) => (
  <RCheckbox.Root
    className={cn(
      'flex size-5 items-center justify-center rounded-sm border border-muted bg-surface data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-on-primary',
      className,
    )}
    {...p}
  >
    <RCheckbox.Indicator>
      <Check className="size-4" aria-hidden />
    </RCheckbox.Indicator>
  </RCheckbox.Root>
);

export const Switch = ({ className, ...p }: ComponentProps<typeof RSwitch.Root>) => (
  <RSwitch.Root
    className={cn(
      'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-line bg-line transition-colors data-[state=checked]:bg-primary',
      className,
    )}
    {...p}
  >
    {/* margin-inline-start keeps the knob logical: it moves toward the end edge in both directions */}
    <RSwitch.Thumb className="ms-0.5 block size-5 rounded-full bg-surface shadow transition-[margin] duration-[var(--motion)] data-[state=checked]:ms-[1.375rem]" />
  </RSwitch.Root>
);
