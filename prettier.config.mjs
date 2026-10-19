// iobroker prettier configuration file
import prettierConfig from '@iobroker/eslint-config/prettier.config.mjs';

export default {
  ...prettierConfig,
  // keep the existing code style of this adapter (2 spaces, parentheses around arrow parameters)
  tabWidth: 2,
  arrowParens: 'always',
};
