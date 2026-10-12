// Заход 13 (Р-З13-В1): ESLint 9, flat config вместо `.eslintrc.json`, и
// `eslint` CLI вместо `next lint` (в Next 15.5 устарел, в 16 удалён).
// `next/core-web-vitals` подключён через FlatCompat — как в шаблоне
// create-next-app 15: тот же eslint-config-next 15.5, правила 1:1
// (сверено `--print-config` до/после).
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const eslintConfig = [
  { ignores: ['.next/**', 'node_modules/**', 'out/**', 'next-env.d.ts'] },
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
