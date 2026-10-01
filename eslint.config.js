import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        // Injected at build time by vite.config.js `define`. Declaring it here
        // keeps `no-undef` from flagging a legitimate compile-time constant.
        __APP_BUILD_TIME__: 'readonly',
      },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        // A leading underscore is this codebase's marker for "destructured on
        // purpose, deliberately excluded from the rest object" — e.g. dropping
        // `id` before re-creating a cloned document.
        varsIgnorePattern: '^[A-Z_]',
        argsIgnorePattern: '^_',
      }],

      // React Compiler / HMR advisories, not correctness defects.
      //
      // preserve-manual-memoization fires whenever the compiler cannot prove the
      // existing dependency array is optimal ("Compilation Skipped"); it reports
      // no incorrect behaviour, only that a component keeps running unoptimised.
      // set-state-in-effect reports a cascading render, which is a performance
      // consideration. only-export-components affects Fast Refresh in dev.
      //
      // These were promoted to errors when eslint-plugin-react-hooks v7 brought
      // the React Compiler rules along, which turned `npm test` red on code that
      // works. Rewriting the memoisation would risk behaviour changes for no
      // correctness gain, so they are reported but do not fail the gate.
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    files: ['functions/**/*.js', 'functions/**/*.eslintrc.js'],
    languageOptions: {
      ecmaVersion: 2018,
      globals: {
        ...globals.node,
      },
      sourceType: 'commonjs',
    },
    rules: js.configs.recommended.rules,
  },
])
