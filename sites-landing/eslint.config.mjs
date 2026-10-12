// Заход 13 (Р-З13-В1): ESLint 9, flat config вместо `.eslintrc.json`, и
// `eslint` CLI вместо `next lint` (в Next 15.5 устарел, в 16 удалён).
// `next/core-web-vitals` подключён через FlatCompat — как в шаблоне
// create-next-app 15: тот же eslint-config-next 15.5, правила 1:1
// (сверено `--print-config` до/после).
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const eslintConfig = [
  // scripts/ — проверочные скрипты (`npm test`); `next lint` их не видел
  // (только src/), а под правилами Next в них 4 находки (react/display-name,
  // react/no-children-prop в тестовых компонентах, `eslint-disable` на
  // правило вне конфига) — линтуются отдельным решением (Р-З13-В3).
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', 'next-env.d.ts', 'scripts/**'],
  },
  ...compat.extends('next/core-web-vitals'),
  {
    // `next lint` о ненужных `eslint-disable` молчал — так и оставлено.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];

export default eslintConfig;
