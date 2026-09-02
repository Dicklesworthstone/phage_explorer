import tseslint from 'typescript-eslint'

export default [
  {
    // All ignores consolidated here (replaces legacy .eslintignore)
    ignores: [
      'dist/**',
      'node_modules/**',
      'packages/**/dist/**',
      // Both wasm-pack outputs are generated. Only `pkg` was listed, so a
      // rebuild of the SIMD variant (which production actually prefers) failed
      // lint on wasm-bindgen's own generated headers.
      'packages/wasm-compute/pkg/**',
      'packages/wasm-compute/pkg-simd/**',
      // NOTE: packages/tui is deliberately NOT ignored any more.
      //
      // Ignoring it meant 59 files and ~11k lines of the terminal app were
      // never linted. That is how an unused `AnomalyOverlay` import survived --
      // the same import whose missing render branch soft-locked the app on
      // Shift+A. Lint runs at --max-warnings=0 and still could not see it.
      '.cache/**',
      // Vercel build artifacts (generated; may contain minified bundles)
      '.vercel/**',
      'packages/**/.vercel/**',
      // Playwright artifacts (generated; can contain minified bundles)
      'playwright-report/**',
      'test-results/**',
      'screenshots/**',
      'packages/**/playwright-report/**',
      'packages/**/test-results/**',
      'packages/**/screenshots/**',
    ]
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  }
]
