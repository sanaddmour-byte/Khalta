import type { TFunction } from 'i18next';

/**
 * "OPC 42.5", "White OPC 52.5", "White 52.5 (record the type)", or the "not recorded" note. Display only: type, class
 * and colour are three separate values, and a legacy record that stored "white" as a type is shown as a colour.
 */
export function cementText(
  t: TFunction,
  kind: string | null | undefined,
  strengthClass: number | null | undefined,
  colour?: string | null,
  legacyWhite?: boolean,
): string {
  if (!kind && strengthClass == null && !colour) return t('materials.cement.notRecorded');
  const text = [
    colour === 'white' ? t('materials.opt.cement_colour.white') : null,
    kind ? t(`materials.opt.cement_kind.${kind}`) : null,
    strengthClass ?? null,
  ]
    .filter((x) => x !== null)
    .join(' ');
  return legacyWhite ? `${text} ${t('materials.cement.legacyNote')}` : text;
}
