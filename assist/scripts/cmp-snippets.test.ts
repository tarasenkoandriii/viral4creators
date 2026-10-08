/**
 * Заход 9 (хвост Э3-бис (8)): готовые связки CMP → `consent` связанного
 * режима. Каждый фрагмент исполняется с подменённым window — макетом
 * API своей CMP: согласие → `consent(true)`, отказ → `consent(false)`;
 * вызов до загрузки виджета — в очередь `.q` (её разбирает загрузчик).
 * Тот же модуль проверяет e2e виджета в браузере (analytics.spec.ts).
 */
import assert from 'node:assert/strict';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import { CMP_IDS, cmpSnippet, type CmpId } from '../src/lib/cmp-snippets';
import { WIDGET_GLOBAL } from '../src/lib/widget-brand';

type Listener = (e: unknown) => void;

/** Окно с событиями и очередью глобала — без DOM. */
function sandbox() {
  const on: Record<string, Listener[]> = {};
  const target = {
    addEventListener: (t: string, f: Listener) => (on[t] ??= []).push(f),
  };
  const win: Record<string, unknown> = {
    ...target,
    document: target,
  };
  win.window = win;
  const fire = (t: string, e: unknown = {}) =>
    (on[t] ?? []).forEach((f) => f(e));
  // Аргументы — объект arguments; сравниваем JSON-копии массивов.
  const queue = (): unknown[][] =>
    JSON.parse(
      JSON.stringify(
        ((win[WIDGET_GLOBAL] as { q?: unknown[][] } | undefined)?.q ?? []).map(
          (a) => Array.from(a as ArrayLike<unknown>)
        )
      )
    );
  // Глобалы страницы — объект `win` (нестрогий режим, `with`): фрагмент
  // видит его, как на сайте видит window.
  const run = (code: string) =>
    new Function('win', `with (win) {\n${code}\n}`)(win);
  return { win, fire, queue, run };
}

const last = (q: unknown[][]) => q[q.length - 1];

// Каждый фрагмент — синтаксически цельный ES5-код с глобалом из brand.
for (const id of CMP_IDS) {
  const code = cmpSnippet(id, WIDGET_GLOBAL);
  if (id === 'gcm') {
    assert.equal(code, null, 'GCM — без фрагмента (переключатель)');
    continue;
  }
  if (code === null) throw new Error(`${id}: нет фрагмента`);
  assert.ok(
    code.includes(`window.${WIDGET_GLOBAL} = window.${WIDGET_GLOBAL} ||`)
  );
  assert.ok(!/=>|\blet\b|\bconst\b|`/.test(code), `${id}: только ES5`);
  new Function(code);
}

// custom: два вызова подряд — согласие и отказ.
{
  const s = sandbox();
  s.run(cmpSnippet('custom', WIDGET_GLOBAL) as string);
  assert.deepEqual(s.queue(), [
    ['consent', { analytics: true }],
    ['consent', { analytics: false }],
  ]);
}

// Cookiebot: CookiebotOnConsentReady + Cookiebot.consent.statistics.
{
  const s = sandbox();
  s.run(cmpSnippet('cookiebot', WIDGET_GLOBAL) as string);
  s.win.Cookiebot = { consent: { statistics: true } };
  s.fire('CookiebotOnConsentReady');
  assert.deepEqual(last(s.queue()), ['consent', { analytics: true }]);
  s.win.Cookiebot = { consent: { statistics: false, marketing: true } };
  s.fire('CookiebotOnConsentReady');
  assert.deepEqual(last(s.queue()), ['consent', { analytics: false }]);
}

// Cookiebot ответил ДО вставки фрагмента (hasResponse) — решение сразу.
{
  const s = sandbox();
  s.win.Cookiebot = { hasResponse: true, consent: { statistics: true } };
  s.run(cmpSnippet('cookiebot', WIDGET_GLOBAL) as string);
  assert.deepEqual(s.queue(), [['consent', { analytics: true }]]);
  const n = sandbox();
  n.win.Cookiebot = { hasResponse: false, consent: { statistics: false } };
  n.run(cmpSnippet('cookiebot', WIDGET_GLOBAL) as string);
  assert.deepEqual(n.queue(), [], 'нет ответа — ждём событие');
}

// OneTrust: прежний OptanonWrapper сайта зовётся; C0002 — точное совпадение.
{
  const s = sandbox();
  let prev = 0;
  s.win.OptanonWrapper = () => prev++;
  s.run(cmpSnippet('onetrust', WIDGET_GLOBAL) as string);
  const wrap = s.win.OptanonWrapper as () => void;
  s.win.OnetrustActiveGroups = ',C0001,C0002,';
  wrap();
  assert.deepEqual(last(s.queue()), ['consent', { analytics: true }]);
  s.win.OnetrustActiveGroups = ',C0001,C00020,C0004,';
  wrap();
  assert.deepEqual(last(s.queue()), ['consent', { analytics: false }]);
  s.win.OnetrustActiveGroups = 'C0002';
  wrap();
  assert.deepEqual(last(s.queue()), ['consent', { analytics: true }]);
  assert.equal(prev, 3, 'обработчик сайта не потерян');
}

// CookieYes: cookieyes_consent_update.detail.accepted.
{
  const s = sandbox();
  s.run(cmpSnippet('cookieyes', WIDGET_GLOBAL) as string);
  s.fire('cookieyes_consent_update', {
    detail: { accepted: ['necessary', 'analytics'], rejected: [] },
  });
  assert.deepEqual(last(s.queue()), ['consent', { analytics: true }]);
  s.fire('cookieyes_consent_update', {
    detail: { accepted: ['necessary'], rejected: ['analytics'] },
  });
  assert.deepEqual(last(s.queue()), ['consent', { analytics: false }]);
  s.fire('cookieyes_consent_update', {});
  assert.deepEqual(last(s.queue()), ['consent', { analytics: false }]);
}

// CookieYes: решение, данное раньше, — при загрузке баннера и сразу.
{
  const s = sandbox();
  s.run(cmpSnippet('cookieyes', WIDGET_GLOBAL) as string);
  s.fire('cookieyes_banner_load', {
    detail: {
      categories: { necessary: true, analytics: true },
      isUserActionCompleted: true,
    },
  });
  assert.deepEqual(last(s.queue()), ['consent', { analytics: true }]);
  // Посетитель ещё не решал — «без согласия», даже если категория включена.
  s.fire('cookieyes_banner_load', {
    detail: {
      categories: { necessary: true, analytics: true },
      isUserActionCompleted: false,
    },
  });
  assert.deepEqual(last(s.queue()), ['consent', { analytics: false }]);
  const g = sandbox();
  g.win.getCkyConsent = () => ({
    categories: { analytics: true },
    isUserActionCompleted: true,
  });
  g.run(cmpSnippet('cookieyes', WIDGET_GLOBAL) as string);
  assert.deepEqual(g.queue(), [['consent', { analytics: true }]]);
}

// Complianz: cmplz_has_consent('statistics') на загрузке и при смене.
{
  const s = sandbox();
  s.run(cmpSnippet('complianz', WIDGET_GLOBAL) as string);
  let ok = true;
  s.win.cmplz_has_consent = (c: string) => c === 'statistics' && ok;
  s.fire('cmplz_fire_categories');
  assert.deepEqual(last(s.queue()), ['consent', { analytics: true }]);
  ok = false;
  s.fire('cmplz_status_change');
  assert.deepEqual(last(s.queue()), ['consent', { analytics: false }]);
  // Без API Complianz — отказ, не исключение.
  delete s.win.cmplz_has_consent;
  s.fire('cmplz_status_change');
  assert.deepEqual(last(s.queue()), ['consent', { analytics: false }]);
}

// Уже загруженный виджет: заглушка не перезаписывает настоящий вход.
{
  const s = sandbox();
  const calls: unknown[][] = [];
  s.win[WIDGET_GLOBAL] = (...a: unknown[]) =>
    calls.push(JSON.parse(JSON.stringify(a)));
  s.run(cmpSnippet('cookieyes', WIDGET_GLOBAL) as string);
  s.fire('cookieyes_consent_update', { detail: { accepted: ['analytics'] } });
  assert.deepEqual(calls, [['consent', { analytics: true }]]);
}

// Подписи и подсказки — на трёх языках для каждой CMP.
for (const d of [appRu, appUk, appEn]) {
  for (const id of CMP_IDS as readonly CmpId[]) {
    assert.ok(d.e3b.settings.cmps[id], id);
    assert.ok(d.e3b.settings.cmpHints[id], id);
  }
}

console.log('cmp-snippets: ok');
