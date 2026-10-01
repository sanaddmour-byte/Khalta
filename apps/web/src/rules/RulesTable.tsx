import { Ltr, Table, Td, Th, VerificationChip } from '@khalta/ui';
import { useTranslation } from 'react-i18next';
import { usePrefs } from '../lib/prefs';
import type { Rule } from './api';
import { RuleValue } from './format';

interface Props {
  rules: Rule[];
  onOpen: (rule: Rule) => void;
}

/** Rules grouped by ruleset, then chapter. Each row is one focusable button that opens the detail sheet. */
export function RulesTable({ rules, onOpen }: Props) {
  const { t } = useTranslation();
  const { lang } = usePrefs();

  const byRuleset = new Map<string, Map<string, Rule[]>>();
  for (const r of rules) {
    const chapters = byRuleset.get(r.ruleset) ?? new Map<string, Rule[]>();
    const g = r.group ?? '';
    chapters.set(g, [...(chapters.get(g) ?? []), r]);
    byRuleset.set(r.ruleset, chapters);
  }

  if (rules.length === 0)
    return (
      <p className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
        {t('rules.noMatches')}
      </p>
    );

  return (
    <div className="flex flex-col gap-8">
      {[...byRuleset].map(([ruleset, chapters]) => (
        <section key={ruleset} aria-labelledby={`rs-${ruleset}`} data-ruleset={ruleset}>
          <h2 id={`rs-${ruleset}`} className="mb-2 text-lg font-semibold text-heading">
            {t(`rules.rulesets.${ruleset}`, { defaultValue: ruleset })}
          </h2>
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <Table>
              <thead>
                <tr>
                  <Th>{t('rules.col.rule')}</Th>
                  <Th className="hidden md:table-cell">{t('rules.col.value')}</Th>
                  <Th className="hidden 2xl:table-cell">{t('rules.col.class')}</Th>
                  <Th className="hidden xl:table-cell">{t('rules.col.clause')}</Th>
                  <Th className="hidden md:table-cell">{t('rules.col.status')}</Th>
                  <Th numeric className="hidden 2xl:table-cell">
                    {t('rules.col.usedBy')}
                  </Th>
                </tr>
              </thead>
              {[...chapters].map(([chapter, list]) => (
                <tbody key={chapter} data-chapter={chapter}>
                  {chapter && (
                    <tr>
                      <th
                        colSpan={6}
                        scope="colgroup"
                        className="bg-app px-3 py-1.5 text-start text-xs font-semibold text-muted"
                      >
                        {chapter}
                      </th>
                    </tr>
                  )}
                  {list.map((r) => (
                    <tr key={r.id} data-rule={r.key} className="hover:bg-primary-tint">
                      <Td className="max-w-[18rem] md:max-w-xs">
                        <button
                          type="button"
                          onClick={() => onOpen(r)}
                          className="block w-full text-start"
                          data-testid={`rule-open-${r.key}`}
                        >
                          <Ltr mono className="text-xs">
                            {r.key}
                          </Ltr>
                          <span className="block truncate text-xs text-muted">
                            {lang === 'ar' ? (r.noteAr ?? r.noteEn) : (r.noteEn ?? r.noteAr)}
                          </span>
                        </button>
                        {/* Below md the value and status sit under the rule name so nothing is out of view. */}
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm md:hidden">
                          <RuleValue rule={r} />
                          <VerificationChip state={r.status} />
                        </div>
                      </Td>
                      <Td className="hidden max-w-56 md:table-cell">
                        <RuleValue rule={r} />
                      </Td>
                      <Td className="hidden text-xs 2xl:table-cell">
                        {t(`rules.class.${r.requirementClass}`, {
                          defaultValue: r.requirementClass,
                        })}
                      </Td>
                      <Td className="hidden text-xs xl:table-cell">
                        <Ltr>{r.clauseRef}</Ltr>
                      </Td>
                      <Td className="hidden md:table-cell">
                        <VerificationChip state={r.status} />
                      </Td>
                      <Td numeric className="hidden 2xl:table-cell">
                        {r.usedByDesigns}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </Table>
          </div>
        </section>
      ))}
    </div>
  );
}
