import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, it } from 'vitest';
import noHardcodedUiStrings from '../src/rules/no-hardcoded-ui-strings.js';
import noPhysicalCss, { physicalTokens } from '../src/rules/no-physical-css.js';
import validatorIsolation from '../src/rules/validator-isolation.js';
import { expect } from 'vitest';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

tester.run('no-hardcoded-ui-strings', noHardcodedUiStrings, {
  valid: [
    '<div>{t("slump")}</div>',
    '<div>{" "}</div>',
    '<div>42</div>',
    '<div>—</div>',
    '<input placeholder={t("x")} />',
    '<input type="text" data-testid="shell" />',
    '<img alt="" />',
  ],
  invalid: [
    { code: '<div>Slump</div>', errors: [{ messageId: 'text' }] },
    { code: '<div>{"Slump"}</div>', errors: [{ messageId: 'text' }] },
    { code: '<div>{`Slump`}</div>', errors: [{ messageId: 'text' }] },
    { code: '<>Compliance</>', errors: [{ messageId: 'text' }] },
    { code: '<input placeholder="Search" />', errors: [{ messageId: 'attr' }] },
    { code: '<button aria-label={"Close"} />', errors: [{ messageId: 'attr' }] },
    { code: '<img alt={`Logo`} />', errors: [{ messageId: 'attr' }] },
    { code: '<div title="الهبوط" />', errors: [{ messageId: 'attr' }] },
  ],
});

tester.run('no-physical-css', noPhysicalCss, {
  valid: [
    '<div className="ms-2 pe-4 start-0 text-start rounded-s border-e" />',
    '<div className="mx-2 px-4 mt-1 pb-2 inset-x-0" />',
    '<div className={cn("flex", active && "ms-2")} />',
    'const left = 1; const s = "ml-2";', // not in a class context
    '<div style={{ marginInlineStart: 4 }} />',
    '<div className="hover:ms-2 md:text-start" />',
  ],
  invalid: [
    { code: '<div className="ml-2" />', errors: [{ messageId: 'cls' }] },
    {
      code: '<div className="p-2 pr-4 left-0" />',
      errors: [{ messageId: 'cls' }, { messageId: 'cls' }],
    },
    {
      code: '<div className="-mr-1 md:text-left" />',
      errors: [{ messageId: 'cls' }, { messageId: 'cls' }],
    },
    { code: '<div className="hover:!pl-2" />', errors: [{ messageId: 'cls' }] },
    {
      code: '<div className="rounded-tr-lg border-l-2" />',
      errors: [{ messageId: 'cls' }, { messageId: 'cls' }],
    },
    { code: '<div className={cn("flex", on && "float-right")} />', errors: [{ messageId: 'cls' }] },
    { code: '<div className={`flex mr-2 ${x}`} />', errors: [{ messageId: 'cls' }] },
    { code: '<div style={{ marginLeft: 4 }} />', errors: [{ messageId: 'style' }] },
    { code: '<div style={{ textAlign: "right" }} />', errors: [{ messageId: 'style' }] },
  ],
});

tester.run('validator-isolation', validatorIsolation, {
  valid: [
    'import { x } from "@khalta/engine";',
    'import { y } from "./recompute";',
    'import fs from "node:fs";',
  ],
  invalid: [
    { code: 'import { x } from "@khalta/engine/optimizer";', errors: [{ messageId: 'banned' }] },
    {
      code: 'import { x } from "../../engine/src/optimizer/index";',
      errors: [{ messageId: 'banned' }],
    },
    { code: 'export * from "@khalta/engine/optimizer";', errors: [{ messageId: 'banned' }] },
    { code: 'export { a } from "../optimizer/solve";', errors: [{ messageId: 'banned' }] },
    {
      code: 'const m = await import("@khalta/engine/optimizer");',
      errors: [{ messageId: 'banned' }],
    },
    { code: 'const m = require("../optimizer");', errors: [{ messageId: 'banned' }] },
  ],
});

// TypeScript syntax needs the TS parser (this is what the real lint run uses).
new RuleTester({ languageOptions: { parser: tseslint.parser } }).run(
  'validator-isolation (ts)',
  validatorIsolation,
  {
    valid: ['import type { Trace } from "@khalta/engine";'],
    invalid: [
      {
        code: 'import type { S } from "@khalta/engine/optimizer";',
        errors: [{ messageId: 'banned' }],
      },
    ],
  },
);

describe('physicalTokens', () => {
  it('ignores logical and unrelated tokens', () => {
    expect(physicalTokens('ms-2 me-2 ps-1 pe-1 start-0 end-0 text-start text-end')).toEqual([]);
  });
  it('finds physical tokens through variants and negatives', () => {
    expect(physicalTokens('dark:md:-ml-2 !pr-1')).toEqual(['dark:md:-ml-2', '!pr-1']);
  });
});
