/**
 * Lighthouse CI (проектный документ §13.6): медиана 5 прогонов, mobile
 * (умолчание Lighthouse), на `/`, странице материала и `/contact`.
 * Пороги: Performance ≥ 0.9, Accessibility = 1, SEO ≥ 0.95 — на сборке с
 * двумя ключами индексации (на noindex-сборке SEO честно ниже: аудит
 * «страница закрыта от индексации»). Условия прогона (Chrome, профиль,
 * стенд) фиксируются в артефакте `.lighthouseci/`.
 *
 * Сервер: `next start` собранного сайта на :3020, стенд API на :3021.
 * Chrome — `CHROME_PATH` (в песочнице — Chromium Playwright; на раннере
 * GitHub — системный).
 */
const BASE = process.env.LHCI_BASE_URL || 'http://localhost:3020';

module.exports = {
  ci: {
    collect: {
      url: ['/', '/materials/pershyi-material', '/contact'].map((p) => BASE + p),
      numberOfRuns: 5,
      settings: {
        chromeFlags: '--no-sandbox --headless=new',
      },
    },
    assert: {
      aggregationMethod: 'median',
      assertions: {
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:accessibility': ['error', { minScore: 1 }],
        'categories:seo': ['error', { minScore: 0.95 }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: '.lighthouseci/reports',
    },
  },
};
