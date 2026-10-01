/**
 * Lighthouse CI (ТЗ §9 п.5, §14 Л0) — с нуля, в репозитории его не было.
 *
 * Mobile-профиль по умолчанию, медиана 5 прогонов на адрес (аудит 01.10:
 * один прогон шумнее порогов). Адреса — главная, посадочная Помощника,
 * тарифы, форма пилота и FAQ (клиентские компоненты). `/widget` и `/try`
 * из §9 появятся в Л3/Л4 — добавить сюда вместе с ними (бюджет 160 КБ).
 *
 * Пороги — бюджет §9 для статических страниц в лабораторном замере:
 * LCP ≤ 2.0 с, CLS ≤ 0.05, TBT ≤ 150 мс (лабораторный заменитель INP),
 * скрипты ≤ 110 КБ передачи, сторонних запросов 0. Категории: perf ≥ 0.9,
 * a11y = 1, BP ≥ 0.95, SEO ≥ 0.95.
 *
 * Сервер: `next start` собранного сайта на :3010. Chrome — `CHROME_PATH`
 * (в песочнице — Chromium Playwright; на раннере GitHub — системный).
 */
const PATHS = ['/uk', '/uk/assistant', '/en/assistant/pricing', '/ru/assistant/pilot', '/uk/assistant/faq'];
const BASE = process.env.LHCI_BASE_URL || 'http://localhost:3010';

module.exports = {
  ci: {
    collect: {
      url: PATHS.map((p) => BASE + p),
      numberOfRuns: 5,
      startServerCommand: process.env.LHCI_BASE_URL ? undefined : 'npx next start -p 3010',
      startServerReadyPattern: 'Ready',
      chromePath: process.env.CHROME_PATH || undefined,
      settings: {
        chromeFlags: '--no-sandbox --headless=new',
      },
    },
    assert: {
      // Медиана по прогонам — для числовых метрик.
      aggregationMethod: 'median-run',
      assertions: {
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:accessibility': ['error', { minScore: 1 }],
        'categories:best-practices': ['error', { minScore: 0.95 }],
        'categories:seo': ['error', { minScore: 0.95 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 2000 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.05 }],
        'total-blocking-time': ['error', { maxNumericValue: 150 }],
        'resource-summary:script:size': ['error', { maxNumericValue: 110 * 1024 }],
        'resource-summary:third-party:count': ['error', { maxNumericValue: 0 }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: '.lighthouseci/reports',
    },
  },
};
