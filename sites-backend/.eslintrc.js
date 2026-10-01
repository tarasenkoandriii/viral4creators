// Конфигурация — копия backend/.eslintrc.js (там история каждого правила):
// два проекта с одними правилами, чтобы код, переезжающий между ними
// через scripts/sync-sites-shared.mjs, линтовался одинаково.
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin', 'jest'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js', 'dist', 'node_modules'],
  overrides: [
    {
      // `expect` внутри `catch`/`if` — тест, который молча зеленеет, когда
      // код перестаёт бросать (backend, Б-5.20).
      files: ['**/*.spec.ts'],
      rules: {
        'jest/no-conditional-expect': 'error',
        'jest/no-identical-title': 'error',
        'jest/valid-expect': 'error',
      },
    },
  ],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    // Подчёркивание — «параметр обязателен сигнатурой, но здесь не нужен».
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
};
