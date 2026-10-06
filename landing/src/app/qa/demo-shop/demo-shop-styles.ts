/**
 * Стили демо-витрины — строкой в `<style>`, как у `site-sandbox`: у
 * лендинга нет CSS-модулей, а строка ещё и рендерится в тесте
 * (`renderToStaticMarkup` не умеет импортировать `.css`).
 *
 * Классы с префиксом `ds-`, чтобы не задеть общие стили лендинга и не
 * попасть под них; по той же причине на витрине нет элементов
 * `section`/`footer` — `globals.css` даёт им отступы и рамки.
 *
 * Тема — только `prefers-color-scheme` и переменные (без переключателя):
 * раннер ставит её `emulateMedia`. Глобальный `:root` лендинга объявляет
 * `color-scheme: dark`, поэтому витрина задаёт свой `color-scheme` —
 * иначе поля ввода в светлой теме рисовались бы тёмными.
 *
 * НИ ОДНОГО `transition`/`animation`: каждое действие на витрине —
 * мгновенная смена состояния, кадр ролика снимается сразу после пола
 * оседания (черновик сценариев, раздел 4.1). Это держит тест.
 *
 * Контраст — AA: текст ≥ 4.5:1, границы полей и рамка выбранного
 * ≥ 3:1 к своему фону в обеих темах (замерено при сдаче, см. отчёт).
 */
export const DEMO_SHOP_CSS = `
.ds-root {
  --ds-bg: #f6f4ef;
  --ds-surface: #ffffff;
  --ds-surface-2: #efebe2;
  --ds-fg: #1d1c1a;
  --ds-muted: #575349;
  --ds-border: #ddd7ca;
  --ds-field-border: #847e71;
  --ds-accent: #0e6656;
  --ds-accent-fg: #ffffff;
  --ds-accent-soft: #e1f0eb;
  --ds-danger: #a3241a;
  --ds-success-bg: #e2f2e9;
  --ds-success-fg: #0b4d31;
  --ds-notice-bg: #fbf0d0;
  --ds-notice-fg: #4f3b00;
  color-scheme: light;
  min-height: 100vh;
  background: var(--ds-bg);
  color: var(--ds-fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.45;
  overflow-wrap: break-word;
}
@media (prefers-color-scheme: dark) {
  .ds-root {
    --ds-bg: #141413;
    --ds-surface: #1e1d1b;
    --ds-surface-2: #2a2825;
    --ds-fg: #f2efe8;
    --ds-muted: #b8b2a5;
    --ds-border: #3b3833;
    --ds-field-border: #8d877b;
    --ds-accent: #5cc9ad;
    --ds-accent-fg: #0a1f1a;
    --ds-accent-soft: #173a32;
    --ds-danger: #ff9e92;
    --ds-success-bg: #133826;
    --ds-success-fg: #a9eac8;
    --ds-notice-bg: #3a2f0f;
    --ds-notice-fg: #f5dd98;
    color-scheme: dark;
  }
}
/* globals.css лендинга включает плавную прокрутку: раннер (Playwright)
   докручивает к цели ниже экрана и ждёт, пока она перестанет ехать, —
   на витрине это сотни мс на шаг. Здесь прокрутка мгновенная. */
html:has(.ds-root) { scroll-behavior: auto; }
body:has(.ds-root) { background: #f6f4ef; }
@media (prefers-color-scheme: dark) {
  body:has(.ds-root) { background: #141413; }
}
.ds-root *, .ds-root *::before, .ds-root *::after { box-sizing: border-box; }
/* Сброс — через :where(), с нулевой специфичностью: сброс «корень + тег»
   весит (0,1,1) и перебивал бы цвет и отступы классов .ds-btn/.ds-h1
   (0,1,0) — так кнопки в первой сборке получили тёмный текст на акценте. */
:where(.ds-root) button, :where(.ds-root) input { font: inherit; color: inherit; }
:where(.ds-root) button { cursor: pointer; }
.ds-root :focus-visible { outline: 3px solid var(--ds-accent); outline-offset: 2px; }
:where(.ds-root) :is(h1, h2, h3, p) { margin: 0; }

.ds-header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--ds-surface);
  border-bottom: 1px solid var(--ds-border);
}
.ds-header-inner {
  max-width: 960px;
  margin: 0 auto;
  padding: 10px 16px 8px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.ds-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0;
  border: 0;
  background: none;
  font-size: 18px;
  font-weight: 700;
  text-align: left;
}
.ds-brand svg { flex: none; color: var(--ds-accent); }
.ds-cart-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 8px 14px;
  border: 0;
  border-radius: 999px;
  background: var(--ds-accent);
  color: var(--ds-accent-fg);
  font-weight: 600;
}
.ds-cart-btn[aria-current="page"] { box-shadow: 0 0 0 2px var(--ds-surface), 0 0 0 4px var(--ds-accent); }
.ds-badge {
  display: inline-grid;
  place-items: center;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border-radius: 12px;
  background: var(--ds-accent-fg);
  color: var(--ds-accent);
  font-size: 14px;
  font-weight: 700;
}
.ds-nav {
  order: 3;
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-left: -8px;
}
.ds-nav-btn {
  min-height: 40px;
  padding: 8px 8px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--ds-muted);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.ds-nav-btn[aria-current="page"] { background: var(--ds-accent-soft); color: var(--ds-fg); }
@media (min-width: 720px) {
  .ds-nav { order: 1; flex-basis: auto; margin-left: 16px; }
  .ds-nav-btn { font-size: 15px; padding: 8px 12px; }
  .ds-cart-btn { order: 2; }
}

.ds-main { max-width: 960px; margin: 0 auto; padding: 16px 16px 24px; }
.ds-notice {
  margin-bottom: 16px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--ds-notice-bg);
  color: var(--ds-notice-fg);
  font-size: 14px;
}
.ds-h1 { margin-bottom: 12px; font-size: 24px; line-height: 1.2; }
.ds-h2 { margin-bottom: 8px; font-size: 20px; line-height: 1.25; }
.ds-lead { margin-bottom: 12px; color: var(--ds-muted); }
.ds-muted { color: var(--ds-muted); font-size: 14px; }

.ds-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (min-width: 720px) { .ds-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.ds-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--ds-border);
  border-radius: 14px;
  background: var(--ds-surface);
}
.ds-thumb {
  display: grid;
  place-items: center;
  aspect-ratio: 4 / 3;
  margin-bottom: 4px;
  border-radius: 10px;
  background: var(--ds-surface-2);
  color: var(--ds-accent);
}
.ds-card-name { font-size: 15px; font-weight: 600; line-height: 1.3; }
.ds-card-note { color: var(--ds-muted); font-size: 13px; }
.ds-card-price { margin: 2px 0 6px; font-weight: 700; }
.ds-card .ds-btn { margin-top: auto; }

.ds-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 10px 14px;
  border: 2px solid var(--ds-accent);
  border-radius: 10px;
  background: var(--ds-accent);
  color: var(--ds-accent-fg);
  font-weight: 600;
  line-height: 1.2;
  text-align: center;
}
.ds-btn-block { width: 100%; }
.ds-btn-secondary { background: transparent; color: var(--ds-fg); }
.ds-btn[data-demo-added="true"] { background: var(--ds-accent-soft); color: var(--ds-fg); }

.ds-panel {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--ds-border);
  border-radius: 14px;
  background: var(--ds-surface);
}
.ds-panel:first-child { margin-top: 0; }
@media (min-width: 860px) {
  .ds-cart-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  .ds-cart-layout > .ds-panel { margin-top: 0; }
}

.ds-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 0;
  border-bottom: 1px solid var(--ds-border);
}
.ds-line-name { flex: 1; min-width: 0; font-weight: 600; }
.ds-line-qty { color: var(--ds-muted); font-size: 14px; }
.ds-total { display: flex; justify-content: space-between; padding-top: 12px; font-size: 18px; font-weight: 700; }
.ds-link-btn {
  min-height: 32px;
  padding: 4px 0;
  border: 0;
  background: none;
  color: var(--ds-accent);
  font-size: 14px;
  text-decoration: underline;
}

.ds-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.ds-label { font-size: 14px; font-weight: 600; }
.ds-input {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--ds-field-border);
  border-radius: 10px;
  background: var(--ds-surface);
  font-size: 16px;
}
.ds-fieldset { margin: 0 0 12px; padding: 0; border: 0; min-width: 0; }
.ds-fieldset .ds-label { display: block; margin-bottom: 4px; padding: 0; }
.ds-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.ds-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--ds-field-border);
  border-radius: 10px;
  background: var(--ds-surface);
  text-align: left;
}
.ds-option[aria-checked="true"], .ds-option[aria-pressed="true"] {
  padding: 9px 11px;
  border: 2px solid var(--ds-accent);
  background: var(--ds-accent-soft);
}
.ds-dot {
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border: 2px solid var(--ds-field-border);
  border-radius: 50%;
}
.ds-option[aria-checked="true"] .ds-dot, .ds-option[aria-pressed="true"] .ds-dot {
  border-color: var(--ds-accent);
  background: radial-gradient(circle, var(--ds-accent) 0 4px, transparent 5px);
}
.ds-option-text { display: flex; flex-direction: column; font-weight: 600; }
.ds-option-hint { color: var(--ds-muted); font-size: 13px; font-weight: 400; }
.ds-error { margin-bottom: 12px; color: var(--ds-danger); font-size: 14px; font-weight: 600; }
.ds-note { margin-top: 10px; color: var(--ds-muted); font-size: 13px; text-align: center; }

.ds-tabs { display: flex; margin-bottom: 4px; border-bottom: 1px solid var(--ds-border); }
.ds-tab {
  flex: 1;
  min-height: 48px;
  padding: 10px 8px;
  border: 0;
  border-bottom: 3px solid transparent;
  background: none;
  color: var(--ds-muted);
  font-weight: 600;
}
.ds-tab[aria-selected="true"] { border-bottom-color: var(--ds-accent); color: var(--ds-fg); }
.ds-terms { margin: 0; padding-top: 12px; }
.ds-terms dt { color: var(--ds-muted); font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; }
.ds-terms dd { margin: 2px 0 12px; font-size: 16px; }
.ds-terms dd:last-child { margin-bottom: 0; }

.ds-slots { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 8px 0 4px; }
@media (min-width: 720px) { .ds-slots { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.ds-step { margin-top: 16px; }

.ds-success {
  padding: 16px;
  border-radius: 14px;
  background: var(--ds-success-bg);
  color: var(--ds-success-fg);
}
.ds-success-title { margin-bottom: 6px; font-size: 20px; font-weight: 700; line-height: 1.25; }
.ds-success p + p { margin-top: 4px; }
.ds-success .ds-btn { margin-top: 12px; }

.ds-footer { max-width: 960px; margin: 0 auto; padding: 8px 16px 32px; color: var(--ds-muted); font-size: 13px; }
`;
