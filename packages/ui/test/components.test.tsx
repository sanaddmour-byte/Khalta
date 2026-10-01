import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CODE_SOURCES,
  CodeBadge,
  EVIDENCE_STATUSES,
  EvidenceChip,
  glossaryTerms,
  Ltr,
  SAVING_STATES,
  SavingStateLabel,
  STATUSES,
  StatusChip,
  uiResources,
  type Lang,
} from '../src/index';
import { renderIn } from './helpers';

type Tree = { [k: string]: string | Tree };
const LANGS: Lang[] = ['en', 'ar'];

describe('StatusChip', () => {
  it.each(LANGS.flatMap((l) => STATUSES.map((s) => [l, s] as const)))(
    '%s %s has icon, text and a status marker',
    (lang, status) => {
      const { container } = renderIn(<StatusChip status={status} />, lang);
      const el = container.querySelector(`[data-status="${status}"]`)!;
      expect(el.querySelector('svg[aria-hidden="true"]')).not.toBeNull(); // icon
      expect(el.textContent?.trim().length).toBeGreaterThan(0); // text: never colour alone
    },
  );
});

describe('EvidenceChip', () => {
  it('covers exactly the nine evidence statuses from CLAUDE.md', () => {
    expect([...EVIDENCE_STATUSES]).toEqual([
      'CODE_VERIFIED',
      'PROJECT_VERIFIED',
      'RULE_UNVERIFIED',
      'MODEL_IN_DOMAIN',
      'MODEL_BASELINE',
      'MODEL_EXTRAPOLATED',
      'INPUT_STALE',
      'INPUT_MISSING',
      'TRIAL_REQUIRED',
    ]);
  });

  it.each(LANGS.flatMap((l) => EVIDENCE_STATUSES.map((s) => [l, s] as const)))(
    '%s %s renders a label with an icon and no numeric score',
    (lang, status) => {
      const { container } = renderIn(<EvidenceChip status={status} />, lang);
      const el = container.querySelector(`[data-evidence="${status}"]`)!;
      expect(el.querySelector('svg')).not.toBeNull();
      const text = el.textContent!.trim();
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/[0-9٠-٩%]/); // evidence, never a score or percentage
      expect(text).not.toBe(`ui.evidence.${status}`); // translation exists
    },
  );

  it('has an English and an Arabic label for every status', () => {
    for (const s of EVIDENCE_STATUSES) {
      const en = ((uiResources.en['ui'] as Tree)['evidence'] as Tree)[s];
      const ar = ((uiResources.ar['ui'] as Tree)['evidence'] as Tree)[s];
      expect(en).toBeTruthy();
      expect(ar).toBeTruthy();
      expect(en).not.toBe(ar);
    }
  });
});

describe('CodeBadge', () => {
  it.each(CODE_SOURCES)('%s renders and ACI/JS stay left-to-right isolated', (source) => {
    const { container } = renderIn(<CodeBadge source={source} />, 'ar');
    expect(container.querySelector(`[data-source="${source}"]`)).not.toBeNull();
    if (source !== 'PROJECT')
      expect(container.querySelector('bdi[dir="ltr"]')?.textContent).toBe(source);
    else expect(container.textContent).toBe('المشروع');
  });
});

describe('SavingStateLabel', () => {
  it.each(SAVING_STATES)('%s is labelled with its state in both languages', (state) => {
    for (const lang of LANGS) {
      const { container, unmount } = renderIn(<SavingStateLabel state={state} />, lang);
      expect(
        container.querySelector(`[data-saving-state="${state}"]`)?.textContent?.trim(),
      ).toBeTruthy();
      unmount();
    }
    renderIn(<SavingStateLabel state="theoretical" />, 'ar');
    expect(screen.getByText('وفر نظري')).toBeInTheDocument();
  });
});

describe('Ltr (bidi isolation)', () => {
  it('wraps tokens in an LTR bdi inside an RTL context', () => {
    const { container } = renderIn(
      <p dir="rtl">
        <Ltr>C30/37</Ltr> <Ltr mono>CEM II/A-P 42.5N</Ltr> <Ltr>kg/m³</Ltr>
      </p>,
      'ar',
    );
    const tokens = [...container.querySelectorAll('bdi')];
    expect(tokens.map((t) => t.getAttribute('dir'))).toEqual(['ltr', 'ltr', 'ltr']);
    expect(tokens[1]).toHaveClass('font-mono');
    expect(tokens.map((t) => t.textContent)).toEqual(['C30/37', 'CEM II/A-P 42.5N', 'kg/m³']);
  });
});

describe('glossary', () => {
  const spec: Record<string, string> = {
    slump: 'الهبوط',
    wcm: 'نسبة الماء إلى المواد الإسمنتية',
    gradation: 'التدرج الحبيبي',
    suspended: 'موقوفة',
    trial_candidate: 'خلطة مرشحة للتجربة',
    saving_states: 'وفر نظري / معتمد / محقق',
  };
  it('has the 20 spec terms, each with unique id, English and Arabic', () => {
    expect(glossaryTerms).toHaveLength(20);
    expect(new Set(glossaryTerms.map((t) => t.id)).size).toBe(20);
    for (const t of glossaryTerms) {
      expect(t.en.trim()).not.toBe('');
      expect(t.ar.trim()).not.toBe('');
    }
  });
  it('keeps the spec wording and exposes it to i18n as glossary.<id>', () => {
    for (const [id, ar] of Object.entries(spec))
      expect(glossaryTerms.find((t) => t.id === id)?.ar).toBe(ar);
    for (const t of glossaryTerms) {
      expect((uiResources.en['glossary'] as Record<string, string>)[t.id]).toBe(t.en);
      expect((uiResources.ar['glossary'] as Record<string, string>)[t.id]).toBe(t.ar);
    }
  });
});
