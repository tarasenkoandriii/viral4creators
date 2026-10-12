// Тот же конфиг, что backend и sites-backend — единый стиль по монорепо
// (отдельный деплоймый пакет Э-С Ш3, но не повод расходиться в линтинге).
//
// Заход 13 (Р-З13-В1): ESLint 9, flat config вместо `.eslintrc.js`.
// Правила и уровни перенесены 1:1 — сверено `--print-config` до/после;
// разница пресетов @typescript-eslint 6 → 8 погашена блоком
// TS_ESLINT_V6_PARITY (Р-З13-В2).
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import jest from 'eslint-plugin-jest';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

/**
 * Р-З13-В2: `plugin:@typescript-eslint/recommended` версии 6 и 8 — разные
 * наборы. Здесь — ровно прежний:
 *  - `ban-types` в 8 удалён; его области — три правила-преемника
 *    (`{}` — no-empty-object-type без пустых интерфейсов, их ban-types не
 *    трогал; `Function`; `String`/`Object`/…) — последние два уже в пресете;
 *  - `no-loss-of-precision` — теперь правило ядра (понимает `1_000`);
 *  - `no-var-requires` в 8 устарел, но работает как раньше; его замена
 *    `no-require-imports` строже (ловит и `import x = require()`) — выключена;
 *  - новые в пресете 8 `no-unused-expressions`, `prefer-namespace-keyword` —
 *    выключены (включать — отдельным решением, с правкой кода);
 *  - `no-unused-vars`: в 8 по умолчанию ругается на неиспользованную
 *    переменную `catch (e)` — прежнее `caughtErrors: 'none'` закреплено явно.
 */
const TS_ESLINT_V6_PARITY = {
  '@typescript-eslint/no-empty-object-type': [
    'error',
    { allowInterfaces: 'always' },
  ],
  'no-loss-of-precision': 'error',
  '@typescript-eslint/no-var-requires': 'error',
  '@typescript-eslint/no-require-imports': 'off',
  '@typescript-eslint/no-unused-expressions': 'off',
  '@typescript-eslint/prefer-namespace-keyword': 'off',
  '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
};

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  prettierRecommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Отдельный tsconfig для линтера (не tsconfig.json — тот
        // намеренно исключает test/, чтобы сборка (`npm run build`) не
        // тащила тестовые файлы в dist/, но ESLint должен видеть и их).
        project: 'tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: 'module',
      globals: { ...globals.node, ...globals.jest },
    },
    // ESLint 8 о ненужных `eslint-disable` молчал — так и оставлено.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      ...TS_ESLINT_V6_PARITY,
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['**/*.spec.ts'],
    plugins: { jest },
    rules: {
      'jest/no-conditional-expect': 'error',
      'jest/no-identical-title': 'error',
      'jest/valid-expect': 'error',
    },
  },
);
