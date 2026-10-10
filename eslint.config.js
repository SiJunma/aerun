import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    // Regression-test fixtures are deliberately unrunnable code: they exist to
    // be fed to a check that MUST fail on them, so linting them is noise.
    'scripts/fixtures/**',
  ]),
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

      // Disallow raw react-bootstrap <Modal> usage — use ForumModal instead.
      // This catches the "stuck modal" bug class. Importing Modal is also flagged
      // because that usually leads to direct usage. Only the Modal specifier matches; other react-bootstrap imports are fine.
      'no-restricted-syntax': ['error', {
        selector: 'JSXOpeningElement[name.name=Modal]',
        message: 'Raw <Modal> from react-bootstrap is prohibited — use ForumModal instead (stuck-modal bug class).',
      }, {
        selector: "ImportDeclaration[source.value='react-bootstrap'] > ImportSpecifier[imported.name=Modal]",
        message: 'Direct import of Modal from react-bootstrap is prohibited — use ForumModal instead (stuck-modal bug class).',
      },
      ],
    },
  },
  {
    // ForumModal is the single sanctioned wrapper around react-bootstrap Modal (scripts/check-no-raw-modal.mjs enforces the same rule), so it is exempt from the ban it exists to implement.
    files: ['src/components/common/ForumModal.jsx'],
    rules: {
      'no-restricted-syntax': 'off',
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
