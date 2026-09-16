// Тот же конфиг, что backend/.eslintrc.js — единый стиль по монорепо,
// см. doc/LIVE-LOGIN-RELAY-SPEC.md §3 (отдельный пакет, но не повод
// расходиться в линтинге).
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    // Отдельный tsconfig для линтера (не tsconfig.json — тот
    // намеренно исключает test/, чтобы сборка (`npm run build`) не
    // тащила тестовые файлы в dist/, но ESLint должен видеть и их).
    project: 'tsconfig.eslint.json',
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
  ignorePatterns: ['.eslintrc.js', 'dist'],
  overrides: [
    {
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
  },
};
