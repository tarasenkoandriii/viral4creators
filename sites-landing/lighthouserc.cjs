/**
 * Lighthouse CI (ТЗ §9 п.5, §14 Л0) — с нуля, в репозитории его не было.
 *
 * Mobile-профиль по умолчанию, медиана 5 прогонов на адрес (аудит 01.10:
 * один прогон шумнее порогов). Адреса — главная, посадочная Помощника,
 * тарифы, форма пилота, FAQ (клиентские компоненты) и конфигуратор
 * `/widget` (Л3, свои бюджеты §9: LCP 2.5 с, скрипты 160 КБ, TBT 200 мс),
 * песочница `/try` (Л4, те же бюджеты §9), страница платформы и
 * документация (Л5, статические бюджеты).
 *
 * С виджетом (§9 п.5): в CI сборка указывает на стенд продукта
 * (`scripts/built/assist-stand.ts`, :3011 — тот же хост `localhost`, что и
 * сайт, поэтому «сторонних» запросов нет) с НАСТОЯЩИМ загрузчиком; он
 * грузится после load/idle внутри замера, и бюджет скриптов его включает.
 *
 * Пороги — бюджет §9 для статических страниц в лабораторном замере:
 * LCP ≤ 2.0 с, CLS ≤ 0.05, TBT ≤ 150 мс (лабораторный заменитель INP),
 * скрипты ≤ 118 КБ (§9, Р-З12-Б10) + загрузчик + `LAZY_TRANSFER_KB`,
 * сторонних запросов 0. Категории: perf ≥ 0.9, a11y = 1, BP ≥ 0.95,
 * SEO ≥ 0.95.
 *
 * Сервер: `next start` собранного сайта на :3010. Chrome — `CHROME_PATH`
 * (в песочнице — Chromium Playwright; на раннере GitHub — системный).
 */
const PATHS = ['/uk', '/uk/assistant', '/en/assistant/pricing', '/ru/assistant/pilot', '/uk/assistant/faq', '/uk/assistant/integrations/wordpress', '/en/docs/assistant'];
const WIDGET_PATHS = ['/uk/assistant/widget', '/uk/assistant/try'];
const BASE = process.env.LHCI_BASE_URL || 'http://localhost:3010';

/**
 * Бюджеты §9: статические страницы и `/widget`. Вес скриптов §9 — «JS
 * первой загрузки (без виджета)» + отдельной строкой «загрузчик ≤ 12 КБ»;
 * Lighthouse считает все скрипты страницы вместе, поэтому порог = сумма.
 * Без загрузчика (сборка без ключа) первую часть держит `npm run budget:js`.
 *
 * `LAZY_TRANSFER_KB` — то, что Lighthouse видит сверх этих двух строк §9:
 * ленивый чанк `web-vitals` после гидратации (3.7 КБ; §9 и `budget:js` его
 * в первую загрузку не считают) и разница передачи (`next start` сжимает
 * gzip-6, плюс заголовки ответов) с gzip-9 `budget:js` (+3.5…4.3 КБ). На
 * Next 14 это перекрывал запас первой загрузки (91 КБ при бюджете 110); с
 * Next 15 + React 19 (заход 12, 09.10.2026) рантайм вырос на 15 КБ,
 * первая загрузка — 105–109 КБ (§9 держит `budget:js`), и без этой
 * строки Lighthouse падал на 124–128 КБ при соблюдённом §9. С Р-З12-Б10
 * §9 для статических страниц — 118 КБ, порог Lighthouse = 118 + 12 + 8 = 138.
 */
const LOADER_KB = 12;
const LAZY_TRANSFER_KB = 8;
function assertions({ lcp, tbt, scriptKb }) {
  return {
    'categories:performance': ['error', { minScore: 0.9 }],
    'categories:accessibility': ['error', { minScore: 1 }],
    'categories:best-practices': ['error', { minScore: 0.95 }],
    'categories:seo': ['error', { minScore: 0.95 }],
    'largest-contentful-paint': ['error', { maxNumericValue: lcp }],
    'cumulative-layout-shift': ['error', { maxNumericValue: 0.05 }],
    'total-blocking-time': ['error', { maxNumericValue: tbt }],
    'resource-summary:script:size': ['error', { maxNumericValue: (scriptKb + LOADER_KB + LAZY_TRANSFER_KB) * 1024 }],
    'resource-summary:third-party:count': ['error', { maxNumericValue: 0 }],
  };
}

module.exports = {
  ci: {
    collect: {
      url: [...PATHS, ...WIDGET_PATHS].map((p) => BASE + p),
      numberOfRuns: 5,
      startServerCommand: process.env.LHCI_BASE_URL ? undefined : 'npx next start -p 3010',
      startServerReadyPattern: 'Ready',
      chromePath: process.env.CHROME_PATH || undefined,
      settings: {
        chromeFlags: '--no-sandbox --headless=new',
      },
    },
    assert: {
      // Медиана по прогонам — для числовых метрик (в каждой строке матрицы).
      assertMatrix: [
        { matchingUrlPattern: '^(?!.*/assistant/(widget|try)).*$', aggregationMethod: 'median-run', assertions: assertions({ lcp: 2000, tbt: 150, scriptKb: 118 }) },
        { matchingUrlPattern: '/assistant/(widget|try)', aggregationMethod: 'median-run', assertions: assertions({ lcp: 2500, tbt: 200, scriptKb: 160 }) },
      ],
    },
    upload: {
      target: 'filesystem',
      outputDir: '.lighthouseci/reports',
    },
  },
};
