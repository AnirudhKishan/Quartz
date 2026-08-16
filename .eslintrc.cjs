/**
 * Layer boundaries are part of the design, so they are linted rather than left
 * to convention: the domain must stay free of React and storage APIs.
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'dev-dist', 'node_modules', 'coverage', '*.cjs'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    'no-restricted-globals': ['error', { name: 'indexedDB', message: 'Use the repository seam.' }],
  },
  overrides: [
    {
      files: ['src/domain/**/*.ts'],
      excludedFiles: ['**/*.test.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              { group: ['react', 'react-dom', '../application/*', '../infrastructure/*', '../ui/*'] },
            ],
          },
        ],
      },
    },
    {
      files: ['src/application/**/*.ts'],
      excludedFiles: ['**/*.test.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          { patterns: [{ group: ['react', 'react-dom', '../infrastructure/*', '../ui/*'] }] },
        ],
      },
    },
    {
      // This adapter is the storage seam, so it is the one place allowed to
      // reach for the global.
      files: ['src/infrastructure/indexedDbRepository.ts'],
      rules: { 'no-restricted-globals': 'off' },
    },
    {
      files: ['scripts/**/*.mjs'],
      env: { node: true, browser: false },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**'],
      env: { node: true },
    },
  ],
};
