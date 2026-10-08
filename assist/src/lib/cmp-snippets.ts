/**
 * Готовые связки баннеров согласия (CMP) со связанным режимом аналитики
 * (заход 9, хвост Э3-бис (8); ТЗ §5-тер.9, DEPLOYMENT §6.21). Без
 * зависимостей: этот же модуль читает e2e виджета (`widget/e2e/
 * analytics.spec.ts`) — каждый фрагмент проверен на макете API своей CMP.
 *
 * Каждый фрагмент: заглушка очереди `<global>` (вызов до загрузки виджета
 * не теряется — загрузчик разбирает `.q`), затем слушатель события CMP →
 * `<global>('consent', { analytics: true|false })`. Отказ и отзыв тоже
 * передаются — ключ визита удаляется сразу.
 *
 * Google Consent Mode v2 (его поддерживают Cookiebot, CookieYes, OneTrust,
 * Usercentrics, Didomi, Complianz, iubenda и др.) фрагмента не требует:
 * достаточно переключателя «Брать согласие из Google Consent Mode».
 */

export const CMP_IDS = [
  'custom',
  'gcm',
  'cookiebot',
  'onetrust',
  'cookieyes',
  'complianz',
] as const;
export type CmpId = (typeof CMP_IDS)[number];

const stub = (g: string) =>
  `window.${g} = window.${g} || function () { (${g}.q = ${g}.q || []).push(arguments); };`;

const send = (g: string, expr: string) =>
  `${g}('consent', { analytics: ${expr} });`;

/** Фрагмент для вставки на сайт (null — фрагмент не нужен, см. `gcm`). */
export function cmpSnippet(cmp: CmpId, g: string): string | null {
  switch (cmp) {
    case 'custom':
      return [
        stub(g),
        '// accepted analytics:',
        send(g, 'true'),
        '// declined or withdrawn:',
        send(g, 'false'),
      ].join('\n');
    case 'gcm':
      return null;
    case 'cookiebot':
      // CookiebotOnConsentReady — при загрузке с прежним решением и после
      // выбора; если Cookiebot уже ответил до вставки фрагмента — сразу.
      return [
        stub(g),
        '(function () {',
        '  var f = function () {',
        '    var c = window.Cookiebot && window.Cookiebot.consent;',
        `    ${send(g, '!!(c && c.statistics)')}`,
        '  };',
        "  window.addEventListener('CookiebotOnConsentReady', f);",
        '  if (window.Cookiebot && window.Cookiebot.hasResponse) f();',
        '})();',
      ].join('\n');
    case 'onetrust':
      // OptanonWrapper OneTrust зовёт при загрузке и после каждого выбора;
      // C0002 — категория «Производительность» (Performance) по умолчанию.
      return [
        stub(g),
        '(function (prev) {',
        '  window.OptanonWrapper = function () {',
        "    if (typeof prev === 'function') prev();",
        "    var groups = ',' + (window.OnetrustActiveGroups || '') + ',';",
        `    ${send(g, "groups.indexOf(',C0002,') >= 0")}`,
        '  };',
        '})(window.OptanonWrapper);',
      ].join('\n');
    case 'cookieyes':
      // Документация CookieYes: `cookieyes_consent_update` (detail.accepted)
      // — выбор в баннере; `cookieyes_banner_load` и `getCkyConsent()`
      // (categories.analytics, isUserActionCompleted) — решение, данное
      // раньше. Без решения посетителя — «без согласия».
      return [
        stub(g),
        '(function () {',
        '  var prior = function (d) {',
        `    ${send(g, '!!(d && d.isUserActionCompleted && d.categories && d.categories.analytics)')}`,
        '  };',
        "  document.addEventListener('cookieyes_consent_update', function (e) {",
        '    var accepted = (e.detail && e.detail.accepted) || [];',
        `    ${send(g, "accepted.indexOf('analytics') >= 0")}`,
        '  });',
        "  document.addEventListener('cookieyes_banner_load', function (e) {",
        '    prior(e.detail);',
        '  });',
        "  if (typeof window.getCkyConsent === 'function') prior(window.getCkyConsent());",
        '})();',
      ].join('\n');
    case 'complianz':
      // Категория Complianz «statistics»; события — при загрузке и смене.
      return [
        stub(g),
        '(function () {',
        '  var f = function () {',
        `    ${send(g, "typeof cmplz_has_consent === 'function' && cmplz_has_consent('statistics')")}`,
        '  };',
        "  document.addEventListener('cmplz_fire_categories', f);",
        "  document.addEventListener('cmplz_status_change', f);",
        '})();',
      ].join('\n');
  }
}
