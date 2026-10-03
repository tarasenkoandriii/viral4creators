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

/** Общие запреты синтаксиса src/** (повторены в override bf.js — override заменяет правило целиком). */
const SYNTAX = [
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
];

/**
 * Э3-бис, К-11 (ТЗ §5-тер.8, §5-тер.16 п.12): в чанке поведения нет
 * слушателей клавиатуры, ввода, буфера обмена и выделения, нет чтения
 * значений полей (`.value`), выделения и буфера обмена — ни в каком виде.
 */
const BF_FORBIDDEN = [
  {
    selector:
      "Literal[value=/^(keydown|keyup|keypress|input|beforeinput|change|paste|copy|cut|selectionchange|selectstart)$/]",
    message: 'К-11: в bf.js запрещены события клавиатуры, ввода, буфера обмена и выделения',
  },
  {
    selector: "MemberExpression[property.name=/^(value|valueAsNumber|valueAsDate|selectionStart|selectionEnd|files|clipboardData)$/]",
    message: 'К-11: в bf.js запрещено читать значения полей и буфер обмена',
  },
  {
    selector: "MemberExpression[computed=true][property.value=/^(value|files|clipboardData)$/]",
    message: 'К-11: в bf.js запрещено читать значения полей и буфер обмена',
  },
  {
    selector: "Identifier[name=/^(getSelection|clipboard|FormData|onkeydown|onkeyup|onkeypress|oninput|onchange|onpaste)$/]",
    message: 'К-11: в bf.js запрещены выделение, буфер обмена, FormData и обработчики ввода',
  },
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
        'no-restricted-syntax': ['error', ...SYNTAX],
      },
    },
    {
      // Загрузчик — origin заказчика: ни строки разметки, ни внешних модулей.
      files: ['src/loader/**/*.ts', 'src/engage/**/*.ts', 'src/ana/**/*.ts', 'src/bf/**/*.ts'],
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
      // Э3-бис: чанк поведения (К-11) — общий список плюс запреты сбора ввода.
      files: ['src/bf/**/*.ts'],
      rules: {
        'no-restricted-syntax': ['error', ...SYNTAX, ...BF_FORBIDDEN],
      },
    },
    {
      files: ['scripts/**/*.ts', 'e2e/**/*.ts', '*.config.ts'],
      env: { node: true, browser: false },
    },
  ],
};
