// Заход 13 (Р-З13-В1): ESLint 9, flat config вместо `.eslintrc.cjs`.
// Правила и уровни перенесены 1:1 — сверено `--print-config` до/после;
// разница пресетов ESLint 8 → 9 и @typescript-eslint 6 → 8 погашена
// блоками ESLINT8_PARITY и TS_ESLINT_V6_PARITY (Р-З13-В2). Копия —
// frontend/eslint.config.mjs.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

/**
 * Р-З13-В2: `eslint:recommended` 8 → 9. Убранное из пресета возвращено,
 * добавленное выключено (включать — отдельным решением, с правкой кода):
 *  - `no-inner-declarations` — из пресета убран, а по умолчанию теперь
 *    разрешает функции в блоках; прежнее поведение — `disallow`;
 *  - `no-class-assign`, `no-with` — @typescript-eslint 8 выключает их для
 *    TS (их ловит tsc), раньше были включены;
 *  - `no-constant-condition` — по умолчанию теперь пропускает
 *    `while (true)`; прежнее — `checkLoops: 'all'`.
 */
const ESLINT8_PARITY = {
  'no-inner-declarations': [
    'error',
    'functions',
    { blockScopedFunctions: 'disallow' },
  ],
  'no-class-assign': 'error',
  'no-with': 'error',
  'no-constant-condition': ['error', { checkLoops: 'all' }],
  'no-constant-binary-expression': 'off',
  'no-empty-static-block': 'off',
  'no-unused-private-class-members': 'off',
};

/**
 * Р-З13-В2: `plugin:@typescript-eslint/recommended` 6 → 8.
 *  - `ban-types` удалён; его области — no-empty-object-type (только `{}`,
 *    пустые интерфейсы ban-types не трогал), no-unsafe-function-type,
 *    no-wrapper-object-types (последние два уже в пресете);
 *  - `no-loss-of-precision` — теперь правило ядра (уже в eslint:recommended);
 *  - `no-var-requires` устарел, но работает как раньше; замена
 *    `no-require-imports` строже — выключена;
 *  - новые `no-unused-expressions`, `prefer-namespace-keyword` — выключены;
 *  - `no-unused-vars` в 8 по умолчанию ругается на `catch (e)` — прежнее
 *    `caughtErrors: 'none'` закреплено явно.
 */
const TS_ESLINT_V6_PARITY = {
  '@typescript-eslint/no-empty-object-type': [
    'error',
    { allowInterfaces: 'always' },
  ],
  '@typescript-eslint/no-var-requires': 'error',
  '@typescript-eslint/no-require-imports': 'off',
  '@typescript-eslint/no-unused-expressions': 'off',
  '@typescript-eslint/prefer-namespace-keyword': 'off',
  '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
};

export default defineConfig(
  // Раньше `eslint . --ext ts,tsx`: JS-файлы (tailwind/postcss-конфиги)
  // не линтовались — и сейчас нет.
  { ignores: ['dist/**', '**/*.{js,cjs,mjs}'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  prettierRecommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      globals: { ...globals.browser, ...globals.es2020 },
    },
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      ...ESLINT8_PARITY,
      ...TS_ESLINT_V6_PARITY,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  }
);
