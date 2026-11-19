import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/artifacts/**',
      '**/data/**',
      'packages/server/drizzle/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are often part of a shape we must match (step signatures,
      // event handlers). Underscore marks intent.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The simulation must stay deterministic: no wall clock, no global RNG.
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Simulation code takes time as dt or an injected clock.' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // Node-side entry points and build scripts may use the wall clock freely.
    files: ['tools/**/*.ts', 'packages/server/**/*.ts', '**/*.mjs', 'eslint.config.js'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: ['**/*.mjs', 'eslint.config.js', '**/*.config.ts'],
    languageOptions: { globals: { ...globals.node } },
    ...tseslint.configs.disableTypeChecked,
  },
);
