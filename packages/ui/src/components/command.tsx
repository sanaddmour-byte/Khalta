import { Command } from 'cmdk';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface PaletteItem {
  id: string;
  label: string;
  keywords?: string[];
  icon?: ReactNode;
  onSelect: () => void;
}
export interface PaletteGroup {
  heading: string;
  items: PaletteItem[];
}

const item =
  'flex cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm data-[selected=true]:bg-primary-tint';

export function CommandPalette({
  open,
  onOpenChange,
  groups,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: PaletteGroup[];
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={title}
      overlayClassName="fixed inset-0 z-40 bg-black/50"
      contentClassName="fixed inset-x-4 top-[15vh] z-50 mx-auto w-auto max-w-xl overflow-hidden rounded-lg border border-line bg-surface text-body shadow-lg"
    >
      <Command.Input
        placeholder={t('ui.palette.placeholder')}
        className="h-12 w-full border-b border-line bg-transparent px-4 text-sm outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <Command.List className="max-h-80 overflow-auto p-2">
        <Command.Empty className="p-4 text-center text-sm text-muted">
          {t('ui.palette.empty')}
        </Command.Empty>
        {groups.map((g) => (
          <Command.Group
            key={g.heading}
            heading={g.heading}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted"
          >
            {g.items.map((i) => (
              <Command.Item
                key={i.id}
                value={`${i.label} ${(i.keywords ?? []).join(' ')}`}
                onSelect={() => {
                  onOpenChange(false);
                  i.onSelect();
                }}
                className={item}
              >
                {i.icon}
                {i.label}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
