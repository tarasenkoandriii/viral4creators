/**
 * Формы запросов лендинга ↔ типы и правила `sites-backend` (Л2–Л3).
 * Лендинг держит КОПИИ (код бэкенда в сборку лендинга не тянем — у
 * Vercel-проекта свой корень), этот тест ловит расхождение копии с
 * источником:
 *
 *  1. Типы — компилятором TypeScript по исходникам бэкенда: наши
 *     `LandingEventBatch` присваиваются серверному, ответ
 *     `WidgetDraftCreated` даёт поля, которые мы читаем, наш черновик
 *     `DraftConfig` присваивается `Omit<WidgetConfig, 'hosts'>`.
 *  2. Пределы — по тексту исходника: регулярки имён/ключей и
 *     `LANDING_DEFAULTS` (батч 20, тело 4 КБ, черновик 2 КБ).
 *  3. Каждое событие, которое может собрать лендинг (все имена × все
 *     допустимые значения свойств), проходит серверный `cleanLandingEvent`
 *     (если зависимости бэкенда не установлены — та же проверка по
 *     регуляркам из его исходника, с пометкой).
 *  4. Формулы контраста — на 700 цветах совпадают с серверными
 *     (`contrastRatio`, `autoTextColor`, тёмная тема, автокоррекция =
 *     поправка `parseWidgetConfig`).
 *  5. Наши черновики (умолчание, крайние, случайные) проходят настоящий
 *     `parseWidgetConfig` БЕЗ поправок и не больше 2 КБ.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { EVENT_LIMITS, EVENT_PROPS, LANDING_EVENT_NAMES, makeEvent, packBatches } from '../src/lib/landing-events';
import {
  COLOR_PRESETS,
  DRAFT_MAX_BYTES,
  ICONS,
  MOBILE_MODES,
  POSITIONS,
  PRESETS,
  THEMES,
  FONTS_AVAILABLE,
  TEXT_LIMITS,
  UI_LANGS,
  autoTextColor,
  contrastRatio,
  defaultDraft,
  draftBytes,
  enforceContrast,
  serializeDraft,
  themeColors,
  type DraftConfig,
} from '../src/lib/widget-draft';

const REPO = path.resolve(__dirname, '..', '..');
const BACK = path.join(REPO, 'sites-backend', 'src');
const LANDING_TYPES = path.join(BACK, 'modules/assist-widget/landing/landing-types.ts');
const LANDING_SERVICE = path.join(BACK, 'modules/assist-widget/landing/landing.service.ts');
const WIDGET_CONFIG = path.join(BACK, 'modules/assist-site-setup/widget-config.ts');
const DEFAULTS = path.join(BACK, 'config/assist-defaults.ts');
const OURS = path.resolve(__dirname, '..', 'src/lib');

for (const f of [LANDING_TYPES, LANDING_SERVICE, WIDGET_CONFIG, DEFAULTS]) assert.ok(fs.existsSync(f), `нет источника ${f}`);

// ── 1. Типы ──
{
  const noExt = (p: string) => p.replace(/\.ts$/, '');
  const src = `
import type * as B from ${JSON.stringify(noExt(LANDING_TYPES))};
import type { WidgetConfig } from ${JSON.stringify(noExt(WIDGET_CONFIG))};
import type * as E from ${JSON.stringify(path.join(OURS, 'landing-events'))};
import type * as D from ${JSON.stringify(path.join(OURS, 'widget-draft'))};
declare const ours: E.LandingEventBatch;
export const toServer: B.LandingEventBatch = ours;
declare const created: B.WidgetDraftCreated;
export const readable: { id: string; expiresAt: string } = created;
declare const draft: D.DraftConfig;
export const asConfig: Omit<WidgetConfig, 'hosts'> = draft;
`;
  const file = path.join(os.tmpdir(), `l23-contract-${process.pid}.ts`);
  fs.writeFileSync(file, src);
  try {
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      resolveJsonModule: true,
      esModuleInterop: true,
      types: [],
    });
    const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === file || !d.file);
    const text = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    assert.deepEqual(text, [], `типы лендинга разошлись с sites-backend:\n${text.join('\n')}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ── 2. Пределы по тексту исходника ──
const serviceSrc = fs.readFileSync(LANDING_SERVICE, 'utf8');
const defaultsSrc = fs.readFileSync(DEFAULTS, 'utf8');
const reFrom = (name: string) => {
  const m = new RegExp(`const ${name} = (/.+/[a-z]*);`).exec(serviceSrc);
  assert.ok(m, `в landing.service.ts нет ${name}`);
  return m[1];
};
const numFrom = (src: string, name: string) => {
  const m = new RegExp(`${name}\\s*[=:]\\s*([0-9 *]+)[,;]`).exec(src);
  assert.ok(m, `нет числа ${name}`);
  return Function(`return (${m[1]})`)() as number;
};
assert.equal(reFrom('NAME_RE'), String(EVENT_LIMITS.nameRe));
assert.equal(reFrom('PROP_KEY_RE'), String(EVENT_LIMITS.propKeyRe));
assert.equal(numFrom(serviceSrc, 'MAX_PROPS'), EVENT_LIMITS.maxProps);
assert.equal(numFrom(serviceSrc, 'MAX_PROP_CHARS'), EVENT_LIMITS.maxPropChars);
assert.equal(numFrom(serviceSrc, 'MAX_PATH_CHARS'), EVENT_LIMITS.maxPathChars);
assert.equal(numFrom(defaultsSrc, 'eventsPerBatch'), EVENT_LIMITS.eventsPerBatch);
assert.equal(numFrom(defaultsSrc, 'eventBodyMaxBytes'), EVENT_LIMITS.bodyMaxBytes);
assert.equal(numFrom(defaultsSrc, 'widgetDraftMaxBytes'), DRAFT_MAX_BYTES);

// Все события, которые лендинг вообще может собрать.
const allEvents = LANDING_EVENT_NAMES.flatMap((name) => {
  const spec = EVENT_PROPS[name];
  const keys = Object.keys(spec);
  if (keys.length === 0) return [makeEvent(name, {}, { locale: 'uk', path: '/uk/assistant' })];
  return keys.flatMap((k) => {
    const values = spec[k];
    return (values === 'number' ? [1] : values).map((v) => makeEvent(name, { [k]: v }, { locale: 'ru', path: '/ru/assistant/widget' }));
  });
});
assert.ok(allEvents.every(Boolean), 'makeEvent отверг допустимое событие');

async function main() {
  // ── 3. Серверная очистка событий ──
  let how = '';
  type Clean = (raw: unknown) => unknown;
  let clean: Clean | null = null;
  try {
    const mod = (await import(pathToFileURL(LANDING_SERVICE).href)) as { cleanLandingEvent: Clean };
    clean = mod.cleanLandingEvent;
    how = 'серверным cleanLandingEvent';
  } catch (e) {
    const msg = String(e);
    assert.match(msg, /Cannot find (module|package)/, `landing.service.ts не импортируется: ${msg}`);
    const NAME = new RegExp(EVENT_LIMITS.nameRe);
    const KEY = new RegExp(EVENT_LIMITS.propKeyRe);
    clean = (raw) => {
      const o = raw as { name: string; props?: Record<string, unknown>; path?: string; locale?: string };
      if (!NAME.test(o.name)) return null;
      for (const [k, v] of Object.entries(o.props ?? {})) if (!KEY.test(k) || (typeof v === 'string' && v.length > EVENT_LIMITS.maxPropChars)) return null;
      if (o.path && (o.path.length > EVENT_LIMITS.maxPathChars || /[?#\s<>"']/.test(o.path))) return null;
      return o;
    };
    how = 'регулярками из исходника (зависимости sites-backend не установлены)';
  }
  for (const e of allEvents) assert.deepEqual(clean!(e), e, `сервер отбросил/изменил событие ${JSON.stringify(e)}`);
  // Батч любого размера режется на тела в пределах сервера.
  const many = Array.from({ length: 95 }, (_, i) => allEvents[i % allEvents.length]!);
  for (const body of packBatches(many)) {
    const parsed = JSON.parse(body) as { events: unknown[] };
    assert.ok(parsed.events.length <= EVENT_LIMITS.eventsPerBatch && Buffer.byteLength(body) <= EVENT_LIMITS.bodyMaxBytes);
  }
  assert.equal(packBatches(many).reduce((s, b) => s + (JSON.parse(b) as { events: unknown[] }).events.length, 0), 95);

  // ── 4–5. Контраст и черновики против настоящего parseWidgetConfig ──
  const wc = (await import(pathToFileURL(WIDGET_CONFIG).href)) as {
    contrastRatio: (a: string, b: string) => number;
    autoTextColor: (bg: string) => string;
    widgetThemeColors: (b: { primaryColor: string; buttonTextColor: string }) => unknown;
    parseWidgetConfig: (input: unknown) => { ok: boolean; config?: Record<string, unknown> & { brand: Record<string, unknown> }; adjustments?: unknown[]; errors?: unknown[] };
    WIDGET_COLOR_PRESETS: readonly string[];
    WIDGET_POSITIONS: readonly string[];
    WIDGET_THEMES: readonly string[];
    WIDGET_PRESETS: readonly string[];
    WIDGET_MOBILE_MODES: readonly string[];
    WIDGET_FONTS: readonly string[];
    WIDGET_LAUNCHER_ICONS: readonly string[];
    WIDGET_UI_LANGS: readonly string[];
    WIDGET_TEXT_LIMITS: Record<string, number>;
  };
  assert.deepEqual([...COLOR_PRESETS], [...wc.WIDGET_COLOR_PRESETS]);
  assert.deepEqual([...POSITIONS], [...wc.WIDGET_POSITIONS]);
  assert.deepEqual([...THEMES], [...wc.WIDGET_THEMES]);
  assert.deepEqual([...PRESETS], [...wc.WIDGET_PRESETS]);
  assert.deepEqual([...MOBILE_MODES], [...wc.WIDGET_MOBILE_MODES]);
  assert.deepEqual([...UI_LANGS], [...wc.WIDGET_UI_LANGS]);
  for (const f of FONTS_AVAILABLE) assert.ok(wc.WIDGET_FONTS.includes(f), `шрифт ${f} неизвестен серверу`);
  for (const i of ICONS) assert.ok(wc.WIDGET_LAUNCHER_ICONS.includes(i), `иконка ${i} неизвестна серверу`);
  for (const k of ['name', 'greeting', 'suggestion', 'suggestions', 'offsetMax'] as const) assert.equal(TEXT_LIMITS[k], wc.WIDGET_TEXT_LIMITS[k], `лимит ${k}`);

  let seed = 20261002;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const hex = () => `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
  const colors = [...COLOR_PRESETS, '#FFFFFF', '#000000', '#FFFF00', '#00FFFF', '#808080', '#777777', '#767676', ...Array.from({ length: 700 }, hex)];
  let adjustedCount = 0;
  for (const c of colors) {
    assert.equal(contrastRatio(c, '#FFFFFF'), wc.contrastRatio(c, '#FFFFFF'), `contrastRatio ${c}`);
    assert.equal(autoTextColor(c), wc.autoTextColor(c), `autoTextColor ${c}`);
    for (const text of ['auto', '#FFFFFF', '#111111', hex()]) {
      assert.deepEqual(themeColors({ primaryColor: c, buttonTextColor: text }), wc.widgetThemeColors({ primaryColor: c, buttonTextColor: text }), `тёмная тема ${c}/${text}`);
      const ours = enforceContrast(c, text);
      const server = wc.parseWidgetConfig({ brand: { primaryColor: c, buttonTextColor: text, name: 'X' } });
      assert.ok(server.ok, `сервер отверг ${c}`);
      assert.equal(ours.primaryColor, server.config!.brand.primaryColor, `автокоррекция ${c}/${text}`);
      assert.equal(ours.buttonTextColor, server.config!.brand.buttonTextColor, `текст на кнопке ${c}/${text}`);
      if (ours.adjusted) adjustedCount++;
      assert.ok(ours.text >= 4.5 && ours.ui >= 3, `после поправки не AA: ${c}/${text}`);
    }
  }
  assert.ok(adjustedCount > 100, `подозрительно мало поправок: ${adjustedCount}`);

  // Черновики: умолчание, «всё на максимуме» (один язык), случайные.
  const drafts: DraftConfig[] = [defaultDraft('Помічник')];
  const max = defaultDraft('Я'.repeat(40));
  max.texts.uk = { greeting: 'Ї'.repeat(400), suggestions: ['Щ'.repeat(90), 'Ж'.repeat(90), 'Є'.repeat(90), 'зайва'] };
  max.layout.offset.desktop = { x: 999, y: -5 };
  drafts.push(max);
  for (let i = 0; i < 200; i++) {
    const d = defaultDraft(`Name ${i}`);
    d.brand.primaryColor = hex();
    d.brand.buttonTextColor = rnd() < 0.3 ? hex() : 'auto';
    d.brand.avatar = { kind: 'icon', icon: ICONS[i % ICONS.length] };
    d.brand.launcherIcon = ICONS[(i + 1) % ICONS.length];
    d.brand.font = FONTS_AVAILABLE[i % FONTS_AVAILABLE.length];
    d.brand.preset = PRESETS[i % PRESETS.length];
    d.brand.theme = THEMES[i % THEMES.length];
    d.layout.position = POSITIONS[i % POSITIONS.length];
    d.layout.mobile = MOBILE_MODES[i % MOBILE_MODES.length];
    d.layout.launcher = i % 5 === 0 ? 'none' : 'default';
    d.layout.openAt = i % 2 ? 'center' : 'corner';
    d.layout.offset.mobile = { x: Math.floor(rnd() * 250), y: Math.floor(rnd() * 250) };
    const lang = UI_LANGS[i % UI_LANGS.length];
    d.texts[lang] = { greeting: `Привіт ${i}\nрядок`, suggestions: ['Ціни?', 'Доставка?'] };
    drafts.push(d);
  }
  for (const d of drafts) {
    const s = serializeDraft(d);
    assert.ok(draftBytes(s) <= DRAFT_MAX_BYTES, `черновик ${draftBytes(s)} Б > 2 КБ`);
    const r = wc.parseWidgetConfig({ ...s, hosts: [] });
    assert.ok(r.ok, `сервер отверг черновик: ${JSON.stringify(r.errors)}`);
    assert.deepEqual(r.adjustments, [], `сервер поправил наш черновик: ${JSON.stringify(r.adjustments)}`);
    const { hosts, ...config } = r.config!;
    assert.deepEqual(hosts, []);
    assert.deepEqual(config, s, 'сервер понял черновик иначе');
  }

  console.log(
    `ok   контракт с sites-backend: типы (события, ответ черновика, вид) сходятся; пределы событий и черновика совпадают; ${allEvents.length} возможных событий проходят ${how}; контраст и автокоррекция совпадают на ${colors.length} цветах × 4 цвета текста; ${drafts.length} черновиков проходят parseWidgetConfig без поправок и ≤ 2 КБ`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
