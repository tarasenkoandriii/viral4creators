/**
 * Линт виджета. Для ЗАГРУЗЧИКА (src/loader/**, исполняется в origin
 * заказчика) — запрет HTML-приёмников и eval (ТЗ §4.12, аудит 1.2: «правило
 * линтера в CI и стенд с require-trusted-types-for 'script'»): только
 * createElement/textContent/attachShadow. Для чата (src/chat/**) — то же
 * плюс запрет dangerouslySetInnerHTML (ответ модели — враждебный текст).
 */
const HTML_SINKS = [
  { property: 'innerHTML', message: 'HTML-приёмник запрещён (§4.12): textContent/createElement' },
  { property: 'outerHTML', message: 'HTML-приёмник запрещён (§4.12)' },
  { property: 'insertAdjacentHTML', message: 'HTML-приёмник запрещён (§4.12)' },
  { property: 'srcdoc', message: 'srcdoc запрещён (§4.12)' },
  { object: 'document', property: 'write', message: 'document.write запрещён (§4.12)' },
  { object: 'document', property: 'writeln', message: 'document.write запрещён (§4.12)' },
  { object: 'Range', property: 'createContextualFragment', message: 'HTML-приёмник запрещён (§4.12)' },
];

module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  ignorePatterns: ['dist', 'dist-test', 'node_modules', 'test-results', 'playwright-report', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      files: ['src/**/*.ts', 'src/**/*.tsx'],
      rules: {
        'no-restricted-properties': ['error', ...HTML_SINKS],
        'no-eval': 'error',
        'no-implied-eval': 'error',
        'no-new-func': 'error',
        'no-restricted-syntax': [
          'error',
          {
            selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
            message: 'dangerouslySetInnerHTML запрещён: ответ модели — враждебный текст (§4.12)',
          },
          {
            selector: "CallExpression[callee.name='setTimeout'][arguments.0.type='Literal']",
            message: 'строковый setTimeout запрещён (§4.12)',
          },
          {
            selector: "CallExpression[callee.name='setInterval'][arguments.0.type='Literal']",
            message: 'строковый setInterval запрещён (§4.12)',
          },
        ],
      },
    },
    {
      // Загрузчик — origin заказчика: ни строки разметки, ни внешних модулей.
      files: ['src/loader/**/*.ts', 'src/engage/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              { group: ['preact', 'preact/*', '../chat/*'], message: 'загрузчик — ванильный TS ≤ 12 КБ gzip (§4.12), без Preact и кода чата' },
            ],
          },
        ],
      },
    },
    {
      files: ['scripts/**/*.ts', 'e2e/**/*.ts', '*.config.ts'],
      env: { node: true, browser: false },
    },
  ],
};
