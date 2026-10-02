/**
 * Конфигуратор (Л3) и отложенный виджет (Л2) — чистая логика:
 *  1. HEX из поля, автокоррекция контраста (AA после поправки всегда),
 *     пресеты проходят без поправки.
 *  2. Черновик: без картинок и хостов, тексты очищены от управляющих и
 *     bidi-символов, обрезаны по лимитам, отступы зажаты, ≤ 2 КБ;
 *     `previewPatch` не трогает z-index и не несёт хостов.
 *  3. Сниппет — только `data-*` позиции/отступов, ключ — заглушка.
 *  4. Deeplink `t.me/<бот>?startapp=wd_<id>` — только для id сервера,
 *     payload ≤ 64 и разбирается реестром префиксов TMA (`site-tma-kit`).
 *  5. Ответ сервера — строгий разбор конверта; коды ошибок.
 *  6. Логотип — только растр по сигнатуре байтов, SVG — нет.
 *  7. Загрузчик виджета не вставляется до взаимодействия/idle; вызовы до
 *     загрузки копятся в очереди в том виде, в каком её читает загрузчик.
 *  8. Замер «с виджетом и без» показывается только целиком.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  COLOR_PRESETS,
  DRAFT_MAX_BYTES,
  cleanLine,
  cleanMultiline,
  contrastRatio,
  defaultDraft,
  draftBytes,
  enforceContrast,
  installSnippet,
  logoProblem,
  normalizeHex,
  parseDraftResponse,
  previewPatch,
  serializeDraft,
  sniffRaster,
  tmaDraftLink,
} from '../src/lib/widget-draft';
import { widgetMeasurement } from '../src/lib/widget-measure';

// ── 1 ──
assert.equal(normalizeHex('#abc'), '#AABBCC');
assert.equal(normalizeHex(' 1f2937 '), '#1F2937');
assert.equal(normalizeHex('red;background:url(//x)'), null);
assert.equal(normalizeHex('#12345'), null);
for (const c of COLOR_PRESETS) assert.equal(enforceContrast(c, 'auto').adjusted, null, `пресет ${c} требует поправки`);
const yellow = enforceContrast('#FFEE00', 'auto');
assert.ok(yellow.adjusted && yellow.adjusted.reason === 'darkened', 'жёлтый на белом затемняется');
assert.ok(yellow.ui >= 3 && yellow.text >= 4.5);
const badText = enforceContrast('#2563EB', '#2563EC');
assert.ok(badText.adjusted, 'текст цвета кнопки не читается — поправка');
assert.ok(badText.text >= 4.5);
assert.ok(contrastRatio('#000000', '#FFFFFF') > 20.9);

// ── 2 ──
const d = defaultDraft('Помічник');
d.brand.name = '‮німоп ‮ Олена\u0007  ';
d.texts.uk = { greeting: 'Привіт!\r\nЯк справи?​', suggestions: ['Ціни?', '', 'x'.repeat(200), 'четверта'] };
d.layout.offset.desktop = { x: 999, y: -4 };
(d.brand as unknown as Record<string, unknown>).logoAssetId = 'asset123';
const s = serializeDraft(d);
assert.equal(s.brand.name, 'німоп  Олена');
assert.equal(s.brand.logoAssetId, null, 'логотип в черновик не попадает');
assert.deepEqual(s.brand.avatar, { kind: 'icon', icon: 'chat' });
assert.equal(s.brand.poweredBy, true);
assert.equal(s.texts.uk!.greeting, 'Привіт!\nЯк справи?');
assert.deepEqual(s.texts.uk!.suggestions, ['Ціни?', 'x'.repeat(80), 'четверта']);
assert.deepEqual(s.layout.offset.desktop, { x: 200, y: 0 });
assert.ok(!('hosts' in s), 'хостов в черновике нет');
assert.ok(draftBytes(s) <= DRAFT_MAX_BYTES);
assert.equal(cleanLine('a\tb\nc', 10), 'abc');
assert.equal(cleanMultiline('a\r\nb⁦c', 10), 'a\nbc');
assert.equal(Array.from(cleanLine('😀'.repeat(40), 30)).length, 30, 'обрезка по кодовым точкам');
const patch = previewPatch(d) as { layout: Record<string, unknown>; hosts?: unknown };
assert.ok(!('zIndex' in patch.layout) && !('hosts' in patch));

// ── 3 ──
d.layout.position = 'top-left';
d.layout.launcher = 'none';
const snip = installSnippet('https://w.example/v1/loader.js', d, 'pk_live_YOUR_KEY');
assert.equal(
  snip,
  '<script async src="https://w.example/v1/loader.js" data-site="pk_live_YOUR_KEY" data-position="top-left" data-offset-x="200" data-offset-y="0" data-mobile="fullscreen" data-launcher="none"></script>',
);

// ── 4 ──
const id = 'Q2hhdEJvdERyYWZ0SWQx';
const link = tmaDraftLink('assist_helper_bot', id);
assert.equal(link, `https://t.me/assist_helper_bot?startapp=wd_${id}`);
const startapp = new URL(link).searchParams.get('startapp')!;
assert.ok(startapp.length <= 64 && /^[A-Za-z0-9_-]+$/.test(startapp));
assert.throws(() => tmaDraftLink('assist_helper_bot', 'bad id'));
assert.throws(() => tmaDraftLink('assist_helper_bot', 'x'.repeat(61)));
// Реестр префиксов — общий для TMA (site-tma-kit): `wd_` разбирается как черновик.
const kit = fs.readFileSync(path.resolve(__dirname, '../../site-tma-kit/src/start-param.ts'), 'utf8');
assert.match(kit, /wd: 'wd_'/, 'в site-tma-kit нет префикса wd_');
const valueRe = new RegExp(/const VALUE_RE = \/(.+)\/;/.exec(kit)![1]);
assert.ok(valueRe.test(id), 'id черновика не проходит VALUE_RE TMA');
// 128 бит base64url — то, что выдаёт сервер (randomBytes(16).toString('base64url')).
assert.ok(valueRe.test('AAAAAAAAAAAAAAAAAAAAAA') && 'AAAAAAAAAAAAAAAAAAAAAA'.length === 22);

// ── 5 ──
assert.deepEqual(parseDraftResponse(200, { success: true, data: { id, expiresAt: '2026-10-09T10:00:00.000Z' } }), {
  ok: true,
  id,
  expiresAt: '2026-10-09T10:00:00.000Z',
});
assert.deepEqual(parseDraftResponse(200, { success: true, data: { id: '<x>', expiresAt: '2026-10-09' } }), { ok: false, code: 'UNEXPECTED' });
assert.deepEqual(parseDraftResponse(200, { id, expiresAt: '2026-10-09' }), { ok: false, code: 'UNEXPECTED' }, 'без конверта — не принимаем');
assert.deepEqual(parseDraftResponse(429, { success: false, error: { code: 'RATE_LIMITED', message: '' } }), { ok: false, code: 'RATE_LIMITED' });
assert.deepEqual(parseDraftResponse(403, { success: false, error: { code: 'ORIGIN_DENIED' } }), { ok: false, code: 'ORIGIN_DENIED' });
assert.deepEqual(parseDraftResponse(400, null), { ok: false, code: 'BAD_REQUEST' });
assert.deepEqual(parseDraftResponse(500, null), { ok: false, code: 'UNEXPECTED' });

// ── 6 ──
assert.equal(logoProblem({ type: 'image/svg+xml', size: 10 }), 'type');
assert.equal(logoProblem({ type: 'image/png', size: 3 * 1024 * 1024 }), 'size');
assert.equal(logoProblem({ type: 'image/webp', size: 10 }), null);
assert.equal(sniffRaster(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
assert.equal(sniffRaster(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
assert.equal(sniffRaster(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')), null, 'SVG под видом PNG');

// ── 7. Отложенная вставка загрузчика ──
type L = (...a: unknown[]) => void;
const listeners: Record<string, L[]> = {};
const added: Array<Record<string, unknown>> = [];
const g = globalThis as unknown as Record<string, unknown>;
let idleCb: L | null = null;
g.window = {
  addEventListener: (t: string, f: L) => (listeners[t] ??= []).push(f),
  removeEventListener: (t: string, f: L) => (listeners[t] = (listeners[t] ?? []).filter((x) => x !== f)),
  dispatchEvent: (e: { type: string }) => (listeners[e.type] ?? []).slice().forEach((f) => f(e)),
  requestIdleCallback: (cb: L) => ((idleCb = cb), 1),
  cancelIdleCallback: () => (idleCb = null),
  setTimeout,
  clearTimeout,
};
g.document = {
  readyState: 'loading',
  querySelector: () => (added.length ? {} : null),
  createElement: () => {
    const attrs: Record<string, string> = {};
    return { setAttribute: (k: string, v: string) => (attrs[k] = v), attrs };
  },
  body: { appendChild: (el: Record<string, unknown>) => added.push(el) },
};
const fire = (t: string) => (listeners[t] ?? []).slice().forEach((f) => f({ type: t }));

async function main() {
  const wl = await import('../src/lib/widget-loader');
  const w = g.window as Record<string, unknown>;
  // Очередь до загрузки — в формате, который читает загрузчик (`.q`, без `.l`).
  wl.assistCall('position', 'bottom-left');
  wl.assistCall('preview', { brand: { theme: 'dark' } });
  const stub = w.V4CAssist as { q: unknown[][]; l?: number };
  assert.deepEqual(stub.q, [
    ['position', 'bottom-left'],
    ['preview', { brand: { theme: 'dark' } }],
  ]);
  assert.equal(stub.l, undefined, 'заглушка не должна выглядеть загруженным загрузчиком');
  assert.equal(wl.isWidgetReady(), false);
  // Загрузчик (widget/src/loader/index.ts boot) читает `existing.q` и проверяет `existing.l`.
  const loaderSrc = fs.readFileSync(path.resolve(__dirname, '../../widget/src/loader/index.ts'), 'utf8');
  assert.match(loaderSrc, /existing && existing\.l\) return/);
  assert.match(loaderSrc, /\(existing && existing\.q\) \|\| \[\]/);

  let starts = 0;
  const start = () => {
    starts++;
    wl.injectLoader({ src: 'https://w.example/v1/loader.js', pk: 'pk_live_abcdefgh12', lang: 'uk' });
  };
  // а) до load и взаимодействия — ничего.
  const cancel1 = wl.scheduleWidget(start);
  assert.equal(starts, 0);
  // load → только idle-колбэк, не сразу.
  fire('load');
  assert.equal(starts, 0, 'сразу после load загрузчик не вставляется — ждём idle');
  assert.ok(idleCb);
  (idleCb as unknown as L)();
  assert.equal(starts, 1);
  fire('pointerdown');
  assert.equal(starts, 1, 'второй раз не стартует');
  cancel1();
  assert.equal(added.length, 1);
  const tag = added[0] as { async: boolean; src: string; attrs: Record<string, string> };
  assert.equal(tag.async, true);
  assert.equal(tag.src, 'https://w.example/v1/loader.js');
  assert.deepEqual(tag.attrs, { 'data-site': 'pk_live_abcdefgh12', 'data-lang': 'uk', 'data-assist-landing': '' });
  // б) взаимодействие раньше idle.
  added.length = 0;
  idleCb = null;
  let s2 = 0;
  wl.scheduleWidget(() => s2++);
  fire('keydown');
  assert.equal(s2, 1);
  // в) явная просьба (кнопка «Открыть помощника»).
  let s3 = 0;
  wl.scheduleWidget(() => s3++);
  wl.requestWidgetLoad();
  assert.equal(s3, 1);
  // Повторная вставка тега — нет.
  added.push({});
  assert.equal(wl.injectLoader({ src: 'x', pk: 'pk_live_abcdefgh12', lang: 'uk' }), null);

  // ── 8 ──
  const base = { date: '2026-10-02', runs: 5, loaderKb: 10.44, chatKb: 22.51, dLcpMs: 12.4, dTbtMs: -3, dCls: 0, how: '' };
  const m = widgetMeasurement(base as never)!;
  assert.equal(m.loaderKb, '10.4');
  assert.equal(m.dLcpMs, '+12');
  assert.equal(m.dTbtMs, '-3');
  assert.equal(m.dCls, '0.000');
  assert.match(m.dateText('uk'), /2026/);
  assert.equal(widgetMeasurement({ ...base, dTbtMs: null } as never), null, 'неполный замер не показывается');

  console.log('ok   конфигуратор и живой виджет: контраст с автокоррекцией, черновик без картинок/хостов/управляющих символов ≤ 2 КБ, сниппет, deeplink wd_ под реестр TMA, строгий разбор ответа, логотип только растр; загрузчик — после idle/взаимодействия, очередь в формате загрузчика; замер — только целиком');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
