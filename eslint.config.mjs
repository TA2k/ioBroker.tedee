// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from '@iobroker/eslint-config';

export default [
  ...config,
  {
    // specify files to exclude from linting here
    ignores: [
      '.dev-server/',
      '.vscode/',
      '*.test.js',
      'test/**/*.js',
      '*.config.mjs',
      'build',
      'dist',
      'admin/build',
      'admin/words.js',
      'admin/admin.d.ts',
      'admin/blockly.js',
      '**/adapter-config.d.ts',
    ],
  },
  {
    // plain JavaScript: JSDoc @type annotations are the type information for tsc (npm run check)
    files: ['**/*.js'],
    rules: {
      'jsdoc/check-tag-names': ['warn', { typed: false }],
    },
  },
];
