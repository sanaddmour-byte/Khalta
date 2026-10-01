import { describe, expect, it } from 'vitest';
import { resources } from '../src/i18n';

type Tree = { [k: string]: string | Tree };
const keys = (t: Tree, prefix = ''): string[] =>
  Object.entries(t).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`),
  );

describe('locale resources', () => {
  const en = keys(resources.en.translation as Tree).sort();
  const ar = keys(resources.ar.translation as Tree).sort();

  it('English and Arabic define exactly the same keys', () => {
    expect(ar.filter((k) => !en.includes(k))).toEqual([]);
    expect(en.filter((k) => !ar.includes(k))).toEqual([]);
  });

  it('no Arabic string is left identical to English unless it is a code or a brand name', () => {
    const flat = (t: Tree, p = ''): Record<string, string> =>
      Object.fromEntries(
        Object.entries(t).flatMap(([k, v]) =>
          typeof v === 'string' ? [[`${p}${k}`, v]] : Object.entries(flat(v, `${p}${k}.`)),
        ),
      );
    const e = flat(resources.en.translation as Tree);
    const a = flat(resources.ar.translation as Tree);
    const same = Object.keys(e).filter((k) => e[k] === a[k]);
    const allowed = /^(app\.nameAr|app\.nameEn|ui\.code\.(ACI|JS)|dev_materials\.cement)$/;
    expect(same.filter((k) => !allowed.test(k))).toEqual([]);
  });
});
