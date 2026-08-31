import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    '.agents',
    '.browser-pilot',
    '.claude',
    '.codex',
    '.serena',
    '.stitch',
    '.vscode',
    '.worktrees',
    'dist',
    'output',
    'target',
    'test-results',
    'src-tauri/target',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      'no-useless-assignment': 'warn',
      'no-useless-catch': 'warn',
      'no-useless-escape': 'warn',
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "ImportDeclaration[source.value='@tauri-apps/api/core'] ImportSpecifier[imported.name='invoke']",
          message:
            'Route backend IPC through src/services/api.ts so command contracts stay typed and centralized.',
        },
        {
          selector:
            "ImportDeclaration[source.value='@tauri-apps/api/event'] ImportSpecifier[imported.name='listen']",
          message:
            'Route backend events through src/services/events.ts so subscriptions stay typed and centralized.',
        },
      ],
    },
  },
  {
    files: [
      'src/services/api.ts',
      'src/services/events.ts',
      '**/*.test.{ts,tsx,js,jsx}',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['vite.config.ts', 'e2e/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
])
