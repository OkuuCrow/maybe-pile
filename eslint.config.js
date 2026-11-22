import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'tests/unit/__snapshots__/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...jsxA11y.flatConfigs.strict,
    plugins: { ...jsxA11y.flatConfigs.strict.plugins, 'react-hooks': reactHooks },
    languageOptions: { ...jsxA11y.flatConfigs.strict.languageOptions, globals: { ...globals.browser } },
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // The renderer is sandboxed: it must never import Node or Electron modules.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'child_process', 'os', 'crypto'],
              message: 'Renderer code cannot use Node APIs; call the preload bridge instead.',
            },
            { group: ['electron'], message: 'Renderer code cannot import Electron.' },
            {
              group: ['**/main/**', '**/db/**', '**/providers/**'],
              message: 'Renderer must not import main-process modules.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Never inject HTML; render text.',
        },
        { selector: "MemberExpression[property.name='innerHTML']", message: 'Never use innerHTML.' },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts', 'src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'electron', '**/main/**', '**/db/**'],
              message: 'shared/ and domain/ must stay platform-neutral.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
