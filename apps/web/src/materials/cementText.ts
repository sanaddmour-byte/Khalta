import type { TFunction } from 'i18next';

/** "OPC 42.5", "White 52.5", or the "not recorded" note for a cement with no label. Display only. */
export function cementText(
  t: TFunction,
  kind: string | null | undefined,
  strengthClass: number | null | undefined,
): string {
  if (!kind && strengthClass == null) return t('materials.cement.notRecorded');
  return [kind ? t(`materials.opt.cement_kind.${kind}`) : null, strengthClass ?? null]
    .filter((x) => x !== null)
    .join(' ');
}
