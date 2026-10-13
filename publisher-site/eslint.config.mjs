// ESLint 9, flat config — как у соседних Next-пакетов (sites-landing, заход
// 13): `next/core-web-vitals` через FlatCompat, `eslint` CLI вместо
// устаревшего `next lint`. scripts/ — проверочные скрипты (`npm test`,
// стенд, e2e) — как у sites-landing, вне линта Next; их держат `tsc` и
// prettier.
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const eslintConfig = [
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', '.lighthouseci/**', 'next-env.d.ts', 'scripts/**'],
  },
  ...compat.extends('next/core-web-vitals'),
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'react-hooks/exhaustive-deps': 'error',
    },
  },
];

export default eslintConfig;
