/**
 * События §10 (Л2): `lib/landing-events.ts` + `lib/track.ts`.
 *  1. Только имена из списка §10.2 и только перечисленные свойства с
 *     допустимыми значениями — всё остальное отбрасывается (никакого
 *     текста, который ввёл человек: e-mail в свойстве — отказ).
 *  2. Путь — без query и якоря (utm, токены, e-mail из адреса не уходят).
 *  3. Отправка: `sendBeacon` с телом `text/plain` (без preflight) на адрес
 *     API; при скрытии страницы; без адреса (события выключены) — ничего.
 *     Ни cookie, ни localStorage/sessionStorage не трогаются.
 *  4. Батчи ≤ 20 событий и ≤ 4 КБ.
 */
import assert from 'node:assert/strict';
import { EVENT_LIMITS, EVENT_PROPS, LANDING_EVENT_NAMES, cleanPath, makeEvent, packBatches } from '../src/lib/landing-events';

// ── 1–2. Форма события ──
assert.deepEqual(makeEvent('page_view', {}, { locale: 'uk', path: '/uk/assistant?utm_source=x&email=a@b.c#top' }), {
  name: 'page_view',
  locale: 'uk',
  path: '/uk/assistant',
});
assert.equal(makeEvent('widget_question'), null, 'widget_question: загрузчик не отдаёт факт вопроса — события нет');
assert.equal(makeEvent('page_view', { email: 'a@b.c' }), null, 'чужое свойство');
assert.equal(makeEvent('cta_click', { place: 'a@b.c' }), null, 'значение вне перечня');
assert.equal(makeEvent('cta_click', { place: 'hero', extra: 1 }), null);
assert.equal(makeEvent('configurator_change', { param: 'greeting', value: 'Привіт, я Олена' }), null, 'введённый текст не уходит');
assert.deepEqual(makeEvent('configurator_change', { param: 'greeting', place: 'configurator' }), {
  name: 'configurator_change',
  props: { param: 'greeting', place: 'configurator' },
});
assert.deepEqual(makeEvent('tma_click', { payload: 'wd', place: 'configurator' })?.props, { payload: 'wd', place: 'configurator' });
assert.equal(makeEvent('tma_click', { payload: 'wd_AbCdEf1234567890' }), null, 'id черновика в события не пишем — только вид payload');
assert.equal(makeEvent('page_view', {}, { locale: 'de' })?.locale, undefined, 'чужая локаль не пишется');
assert.equal(cleanPath('/uk/assistant/widget'), '/uk/assistant/widget');
assert.equal(cleanPath('/uk/<script>'), null);
assert.equal(cleanPath('uk/assistant'), null);
assert.equal(cleanPath('/' + 'a'.repeat(250)), null);
for (const name of LANDING_EVENT_NAMES) assert.match(name, EVENT_LIMITS.nameRe);
// Свойства событий — закрытый список (§10.2); новое свойство — осознанная
// правка этого теста, а не случайная утечка. Значения — только перечни
// машинных слов (никакого «свободного» текста или числа от посетителя).
assert.deepEqual(
  Object.fromEntries(Object.entries(EVENT_PROPS).map(([n, spec]) => [n, Object.keys(spec).sort()])),
  {
    page_view: [],
    cta_click: ['place'],
    widget_open: ['place'],
    widget_corner_change: ['corner', 'place'],
    configurator_change: ['param', 'place'],
    configurator_save: ['result'],
    tma_click: ['payload', 'place'],
    pilot_submit: ['result'],
  },
);
for (const spec of Object.values(EVENT_PROPS)) {
  for (const allowed of Object.values(spec)) {
    assert.ok(Array.isArray(allowed), 'свойство события без перечня значений');
    for (const v of allowed as readonly string[]) assert.match(v, /^[a-z0-9_-]{1,40}$/);
  }
}

// ── 4. Батчи ──
const big = Array.from({ length: 47 }, () => makeEvent('cta_click', { place: 'hero' }, { locale: 'ru', path: '/ru/assistant' })!);
const bodies = packBatches(big);
assert.equal(bodies.length, 3);
assert.deepEqual(
  bodies.map((b) => (JSON.parse(b) as { events: unknown[] }).events.length),
  [20, 20, 7],
);
for (const b of bodies) assert.ok(Buffer.byteLength(b) <= EVENT_LIMITS.bodyMaxBytes);

// ── 3. Отправка в «браузере» ──
type Listener = () => void;
const docListeners: Record<string, Listener[]> = {};
const winListeners: Record<string, Listener[]> = {};
const beacons: Array<{ url: string; type: string; body: string }> = [];
const fetches: unknown[] = [];
let storageTouched = 0;
const trap = new Proxy({}, { get: () => (storageTouched++, () => null) });
const g = globalThis as unknown as Record<string, unknown>;
g.document = {
  documentElement: { lang: 'uk' },
  visibilityState: 'visible',
  addEventListener: (t: string, f: Listener) => (docListeners[t] ??= []).push(f),
  get cookie() {
    storageTouched++;
    return '';
  },
  set cookie(_v: string) {
    storageTouched++;
  },
};
g.window = { addEventListener: (t: string, f: Listener) => (winListeners[t] ??= []).push(f) };
g.location = { pathname: '/uk/assistant/widget', search: '?utm_source=ads' };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    sendBeacon: (url: string, blob: Blob) => {
      void blob.text().then((body) => beacons.push({ url, type: blob.type, body }));
      return true;
    },
  },
});
g.fetch = (...a: unknown[]) => (fetches.push(a), Promise.resolve());
g.localStorage = trap;
g.sessionStorage = trap;

async function main() {
  const track = await import('../src/lib/track');
  // Без адреса — ничего не копится и не уходит.
  track.configureTracking({ endpoint: null });
  track.track('page_view');
  track.flush();
  assert.equal(beacons.length + fetches.length, 0);

  track.configureTracking({ endpoint: 'https://api.example/public/landing/event' });
  track.track('page_view');
  track.track('configurator_change', { param: 'color', place: 'configurator' });
  track.track('nonsense_event');
  assert.equal(track.pendingEvents().length, 2);
  (g.document as { visibilityState: string }).visibilityState = 'hidden';
  for (const f of docListeners.visibilitychange ?? []) f();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, 'https://api.example/public/landing/event');
  assert.equal(beacons[0].type, 'text/plain', 'тело text/plain — без preflight');
  const sent = JSON.parse(beacons[0].body) as { events: Array<Record<string, unknown>> };
  assert.deepEqual(sent.events, [
    { name: 'page_view', locale: 'uk', path: '/uk/assistant/widget' },
    { name: 'configurator_change', props: { param: 'color', place: 'configurator' }, locale: 'uk', path: '/uk/assistant/widget' },
  ]);
  assert.ok(!beacons[0].body.includes('utm_source'), 'query страницы не уходит');
  // 10 событий — отправка сразу (страница может не дожить до скрытия).
  for (let i = 0; i < 10; i++) track.track('cta_click', { place: 'hero' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(beacons.length, 2);
  assert.equal(storageTouched, 0, 'track() не трогает cookie/localStorage/sessionStorage');
  assert.equal(fetches.length, 0);

  console.log(`ok   события §10: ${LANDING_EVENT_NAMES.length} имён, свойства — только из перечней (введённый текст и e-mail не уходят), путь без query, sendBeacon text/plain при скрытии, батчи ≤ 20/4 КБ, без записи на устройство`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
