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
  ignorePatterns: ['.eslintrc.js'],
  overrides: [
    {
      // Б-5.20: правило, которое не даст вернуться опасному паттерну.
      //
      // Первый аудит нашёл в `plan.service.spec` проверку через
      // `try { … } catch (e) { expect(e)… }`: если код перестанет
      // бросать, `catch` просто не выполнится, и тест останется
      // ЗЕЛЁНЫМ, ничего не проверив. Правку сделали руками (этап 40), но
      // правила не завели, и половина пункта осталась открытой:
      // `expect.assertions` — 0 вхождений на 898 тестов.
      //
      // `jest/no-conditional-expect` ловит именно это: `expect` внутри
      // `catch`, `if` или `.catch()`. Оно точнее, чем требовать
      // `expect.assertions` в каждом тесте, — то была бы церемония, а не
      // проверка.
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
