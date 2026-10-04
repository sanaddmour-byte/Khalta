import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '@khalta/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Work that exists only on the screen (generated candidates, a typed mix) is registered here so a global action that
// would silently re-scope it, like switching plant, can ask first. The registry is module state on purpose: the plant
// switcher and a screen share nothing else.
const dirty = new Map<string, string>();

/** Mark this screen as holding unsaved work while `active`; `label` names it in the question. */
export function useUnsavedWork(key: string, active: boolean, label: string) {
  useEffect(() => {
    if (active) dirty.set(key, label);
    else dirty.delete(key);
    return () => {
      dirty.delete(key);
    };
  }, [key, active, label]);
}

export const unsavedLabels = () => [...dirty.values()];

/** Runs `go` at once, or after the person confirms when unsaved work would be discarded. */
export function useGuardedSwitch(go: (id: string) => void) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<string | null>(null);
  const request = (id: string) => {
    if (unsavedLabels().length === 0) go(id);
    else setPending(id);
  };
  const dialog = pending !== null && (
    <Dialog open onOpenChange={(o) => !o && setPending(null)}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-md" data-testid="unsaved-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('shell.unsaved.title')}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t('shell.unsaved.body', { what: unsavedLabels().join(', ') })}
        </DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPending(null)} data-testid="unsaved-stay">
            {t('shell.unsaved.stay')}
          </Button>
          <Button
            onClick={() => {
              const id = pending;
              setPending(null);
              go(id);
            }}
            data-testid="unsaved-switch"
          >
            {t('shell.unsaved.switch')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
  return { request, dialog };
}
