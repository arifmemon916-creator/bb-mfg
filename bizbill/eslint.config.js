import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['www/vendor/**', 'node_modules/**', 'android/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-unreachable': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  { files: ['www/sw.js'], languageOptions: { globals: { ...globals.serviceworker } } },
];
