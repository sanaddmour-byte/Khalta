import noHardcodedUiStrings from './rules/no-hardcoded-ui-strings.js';
import noPhysicalCss from './rules/no-physical-css.js';
import validatorIsolation from './rules/validator-isolation.js';

export default {
  meta: { name: '@khalta/eslint-plugin' },
  rules: {
    'no-hardcoded-ui-strings': noHardcodedUiStrings,
    'no-physical-css': noPhysicalCss,
    'validator-isolation': validatorIsolation,
  },
};
