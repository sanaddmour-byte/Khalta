import {
  Dialog as RDialog,
  DropdownMenu as RMenu,
  Popover as RPopover,
  Tooltip as RTooltip,
} from 'radix-ui';
import { Check, ChevronDown, X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../cn';

const surface = 'rounded-lg border border-line bg-surface text-body shadow-lg';
const pop = 'data-[state=open]:animate-[k-pop-in_var(--motion)_ease-out]';

/* ---- Dialog and Sheet (drawer from the start edge) ---- */
export const Dialog = RDialog.Root;
export const DialogTrigger = RDialog.Trigger;
export const DialogClose = RDialog.Close;
export const DialogTitle = RDialog.Title;
export const DialogDescription = RDialog.Description;

const overlay =
  'fixed inset-0 z-40 bg-black/50 data-[state=open]:animate-[k-fade-in_var(--motion)] data-[state=closed]:animate-[k-fade-out_var(--motion)]';

export function DialogContent({
  className,
  children,
  closeLabel,
  ...p
}: ComponentProps<typeof RDialog.Content> & { closeLabel: string }) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className={overlay} />
      <RDialog.Content
        className={cn(
          surface,
          pop,
          'fixed inset-0 z-50 m-auto h-fit max-h-[85vh] w-[calc(100%-2rem)] max-w-lg overflow-auto p-6',
          className,
        )}
        {...p}
      >
        {children}
        <RDialog.Close
          className="absolute end-3 top-3 rounded-sm p-1 text-muted hover:text-heading"
          aria-label={closeLabel}
        >
          <X className="size-4" aria-hidden />
        </RDialog.Close>
      </RDialog.Content>
    </RDialog.Portal>
  );
}

export function SheetContent({
  className,
  children,
  ...p
}: ComponentProps<typeof RDialog.Content>) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className={overlay} />
      <RDialog.Content
        className={cn(
          'fixed inset-y-0 start-0 z-50 w-72 max-w-[85vw] border-e border-line bg-surface p-4 text-body',
          'data-[state=open]:animate-[k-slide-start-in_var(--motion)_ease-out] data-[state=closed]:animate-[k-slide-start-out_var(--motion)_ease-in]',
          className,
        )}
        {...p}
      >
        {children}
      </RDialog.Content>
    </RDialog.Portal>
  );
}

/* ---- Popover ---- */
export const Popover = RPopover.Root;
export const PopoverTrigger = RPopover.Trigger;
export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...p
}: Omit<ComponentProps<typeof RPopover.Content>, 'align'> & { align?: 'start' | 'end' }) {
  return (
    <RPopover.Portal>
      <RPopover.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(surface, pop, 'z-50 w-72 p-4', className)}
        {...p}
      />
    </RPopover.Portal>
  );
}

/* ---- Tooltip ---- */
export const TooltipProvider = RTooltip.Provider;
export function Tooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          sideOffset={6}
          className="z-50 rounded-md bg-heading px-2 py-1 text-xs text-app"
        >
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

/* ---- Dropdown menu ---- */
// Non-modal by default: a dropdown should not lock the page behind it (and Radix's modal mode
// aria-hides the whole app while it is open, which axe flags for the focusable content behind it).
export const DropdownMenu = (props: ComponentProps<typeof RMenu.Root>) => (
  <RMenu.Root modal={false} {...props} />
);
export const DropdownMenuTrigger = RMenu.Trigger;
export function DropdownMenuContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...p
}: Omit<ComponentProps<typeof RMenu.Content>, 'align'> & { align?: 'start' | 'end' }) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(surface, pop, 'z-50 min-w-48 p-1', className)}
        {...p}
      />
    </RMenu.Portal>
  );
}
export const DropdownMenuItem = ({ className, ...p }: ComponentProps<typeof RMenu.Item>) => (
  <RMenu.Item
    className={cn(
      'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-primary-tint',
      className,
    )}
    {...p}
  />
);
export const DropdownMenuLabel = ({ className, ...p }: ComponentProps<typeof RMenu.Label>) => (
  <RMenu.Label className={cn('px-2 py-1.5 text-xs text-muted', className)} {...p} />
);
export const DropdownMenuSeparator = ({
  className,
  ...p
}: ComponentProps<typeof RMenu.Separator>) => (
  <RMenu.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...p} />
);
export const DropdownMenuRadioGroup = RMenu.RadioGroup;
export const DropdownMenuRadioItem = ({
  className,
  children,
  ...p
}: ComponentProps<typeof RMenu.RadioItem>) => (
  <RMenu.RadioItem
    className={cn(
      'flex cursor-default items-center gap-2 rounded-sm py-1.5 ps-8 pe-2 text-sm outline-none data-[highlighted]:bg-primary-tint relative',
      className,
    )}
    {...p}
  >
    <RMenu.ItemIndicator className="absolute start-2">
      <Check className="size-4" aria-hidden />
    </RMenu.ItemIndicator>
    {children}
  </RMenu.RadioItem>
);

export { ChevronDown };
