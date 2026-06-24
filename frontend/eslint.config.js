// Authorized by HUB-1569 — ESLint 9 flat config; TS + React + Hooks + a11y; .tsx only (AC#4)
// Authorized by HUB-1573 — adds no-raw-admin-fetch rule (AC#1: callers must use apiClient from src/lib/api.ts)
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...jsxA11yPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  {
    // HUB-1573 AC#1: ban direct fetch on /api/v1/admin/* — callers must use apiClient.
    // apiClient itself (src/lib/api.ts) uses fetch internally; the rule excludes that file.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/api.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='fetch'][arguments.0.type='Literal'][arguments.0.value=/^\\u002Fapi\\u002Fv1\\u002Fadmin\\u002F/]",
          message:
            'HUB-1573 AC#1: Direct fetch on /api/v1/admin/* is forbidden. Use apiClient from src/lib/api.ts so the 401-refresh-retry contract is honored.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.jsx', 'src/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: '*',
          message: 'HUB-1569 AC#4: .tsx only — no .jsx or .js files in frontend/src/',
        },
      ],
    },
  },
];
