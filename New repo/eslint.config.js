// Flat-config ESLint setup. Lint rules are intentionally light: this is a CLI
// tool, not an SDK or a library. Prefer Prettier for layout, ESLint for bugs.
import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import jest from 'eslint-plugin-jest';

export default [
  {
    ignores: ['node_modules/**', 'data/**', '.browser-profiles/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // CLI tool — console output is the user-facing surface
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      curly: ['error', 'multi-line'],
    },
  },
  {
    files: ['test/**/*.js', '**/*.test.js'],
    plugins: { jest },
    languageOptions: {
      globals: { ...jest.environments.globals.globals },
    },
    rules: {
      ...jest.configs.recommended.rules,
    },
  },
  prettier,
];
