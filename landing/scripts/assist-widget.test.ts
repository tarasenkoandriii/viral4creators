/**
 * Э-С Ш5: переключатель консультанта лендинга (`src/lib/assist-widget.ts`).
 *
 *  1. По умолчанию — СТАРЫЙ консультант: без явного `platform` прод не
 *     меняется; `platform` с пустым/кривым адресом или ключом — тоже старый
 *     (опечатка в env не убирает консультанта со страницы).
 *  2. Обе страницы, где стоял старый консультант, ветвятся по переключателю
 *     и не вставляют загрузчик синхронно (только `PlatformAssist`, который
 *     грузит его после `load`/idle — бюджет JS лендинга не растёт), а
 *     неиспользуемый в этом режиме виджет — через `next/dynamic`
 *     (`components/AssistLazy.tsx`), не в First Load JS.
 *  3. CSP: у лендинга своего CSP нет. Если он появится — в нём обязан
 *     быть origin виджета (иначе загрузчик молча не загрузится).
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  platformLang,
  resolveAssistWidget,
  widgetCspSources,
} from '../src/lib/assist-widget';

const PK = 'pk_live_ABCDEFGHIJKLMNOPQRSTUVWX';
const SRC = 'https://w.v4c.example.invalid/v1/loader.js';

// 1. Умолчание и закрытый отказ.
assert.deepEqual(resolveAssistWidget({}), { mode: 'legacy' });
assert.deepEqual(
  resolveAssistWidget({ NEXT_PUBLIC_ASSIST_WIDGET_SRC: SRC, NEXT_PUBLIC_ASSIST_WIDGET_SITE_KEY: PK }),
  { mode: 'legacy' },
  'адрес и ключ без явного platform — всё ещё старый'
);
assert.deepEqual(
  resolveAssistWidget({ NEXT_PUBLIC_ASSIST_WIDGET: 'legacy', NEXT_PUBLIC_ASSIST_WIDGET_SRC: SRC, NEXT_PUBLIC_ASSIST_WIDGET_SITE_KEY: PK }),
  { mode: 'legacy' }
);
assert.deepEqual(
  resolveAssistWidget({ NEXT_PUBLIC_ASSIST_WIDGET: 'platform', NEXT_PUBLIC_ASSIST_WIDGET_SRC: SRC, NEXT_PUBLIC_ASSIST_WIDGET_SITE_KEY: PK }),
  { mode: 'platform', src: SRC, siteKey: PK }
);
assert.deepEqual(
  resolveAssistWidget({
    NEXT_PUBLIC_ASSIST_WIDGET: 'platform',
    NEXT_PUBLIC_ASSIST_WIDGET_SRC: 'http://localhost:5180/v1/loader.js',
    NEXT_PUBLIC_ASSIST_WIDGET_SITE_KEY: 'pk_test_ABCDEFGHIJKLMNOPQRSTUVWX',
  }).mode,
  'platform',
  'стенд разработки на localhost'
);

// Поддельные ключи собираются во время выполнения: литерал вида
// sk_live_… в исходнике блокирует пуш (GitHub push protection).
function fakeKey(prefix: string, mode?: string): string {
  return [prefix, mode, 'ABCDEFGHIJKLMNOPQRSTUVWX'].filter(Boolean).join('_');
}

for (const [src, key, why] of [
  ['', PK, 'нет адреса'],
  [SRC, '', 'нет ключа'],
  ['http://w.example.com/v1/loader.js', PK, 'не https'],
  ['javascript:alert(1)', PK, 'не http(s)'],
  ['https://w.example.com/v1/loader.js?x=1', PK, 'параметры в адресе'],
  ['https://user:pw@w.example.com/v1/loader.js', PK, 'учётные данные в адресе'],
  ['https://w.example.com/v1/loader', PK, 'не .js'],
  [SRC, fakeKey('whsec'), 'секрет вместо публичного ключа'],
  [SRC, 'pk_live_short', 'ключ не того вида'],
  // Аудит Ш5: только загрузчик виджета, только публичный ключ.
  ['https://cdn.attacker.example/evil.js', PK, 'не путь загрузчика'],
  ['https://w.example.com/v1/loader.js.map', PK, 'не путь загрузчика (хвост)'],
  ['https://w.example.com:8443/v1/loader.js', PK, 'нестандартный порт'],
  ['http://localhost:5180/v1/loader.js', PK, 'стенд localhost — только с pk_test_'],
  [SRC, fakeKey('sk', 'live'), 'секретный ключ Stripe-вида вместо pk_'],
  [SRC, fakeKey('rk', 'test'), 'не pk_'],
] as const) {
  assert.deepEqual(
    resolveAssistWidget({ NEXT_PUBLIC_ASSIST_WIDGET: 'platform', NEXT_PUBLIC_ASSIST_WIDGET_SRC: src, NEXT_PUBLIC_ASSIST_WIDGET_SITE_KEY: key }),
    { mode: 'legacy' },
    why
  );
}
assert.equal(platformLang('ru'), 'ru');
assert.equal(platformLang('uk'), 'uk');
assert.equal(platformLang('en'), 'en');
assert.equal(platformLang('de'), null, 'немецкого интерфейса у виджета нет — язык страницы/браузера');
assert.equal(platformLang('es'), null);

// 2. Страницы ветвятся по переключателю; загрузчик — только отложенно.
const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
for (const page of ['src/app/[locale]/page.tsx', 'src/app/[locale]/how-it-works/page.tsx']) {
  const src = read(page);
  assert.match(src, /assistWidgetFromBuildEnv\(\)/, `${page}: читает переключатель`);
  assert.match(src, /assist\.mode === '(?:platform|legacy)'/, `${page}: ветвится по нему`);
  assert.match(src, /<(?:Floating|Embedded)?AssistantWidget/, `${page}: старый консультант остался (за флагом)`);
  assert.match(src, /<(?:Lazy)?PlatformAssist/, `${page}: виджет платформы`);
  assert.doesNotMatch(src, /<script/i, `${page}: загрузчик не вставляется тегом в разметку`);
}
// Аудит лендинга: на главной оба виджета плавающие, и неиспользуемый в
// этом режиме не должен попадать в First Load JS — оба через next/dynamic.
// На how-it-works next/dynamic нет: ленивый загрузчик платформы там дороже
// (рантайм next/dynamic), чем сам загрузчик, а встроенную панель выбирает
// константа сборки (EmbeddedAssistant.tsx; замеры — в его шапке).
{
  const home = read('src/app/[locale]/page.tsx');
  for (const name of ['AssistantWidget', 'PlatformAssist']) {
    assert.doesNotMatch(
      home,
      new RegExp(`from '[./]+/components/${name}'`),
      `главная: ${name} импортирован статически`,
    );
  }
}
{
  const lazy = read('src/components/AssistLazy.tsx');
  assert.match(lazy, /^'use client';/, 'AssistLazy: клиентский модуль');
  assert.match(lazy, /dynamic\(\s*\(\) => import\('\.\/AssistantWidget'\)/, 'AssistLazy: AssistantWidget через next/dynamic');
  assert.match(lazy, /dynamic\(\s*\(\) => import\('\.\/PlatformAssist'\)/, 'AssistLazy: PlatformAssist через next/dynamic');
}
// how-it-works: код чата не в First Load JS сборки `platform`, а в
// `legacy` панель синхронная (без лишнего запроса чанка). Число держит
// второй прогон CI (`next build` в `platform` + `budget:js -- --platform`),
// форма — здесь: без сборки и раньше, на `npm test`.
{
  const hiw = read('src/app/[locale]/how-it-works/page.tsx');
  assert.doesNotMatch(
    hiw,
    /from '[./]+\/components\/AssistantWidget'/,
    'how-it-works: AssistantWidget импортирован статически — чат в First Load JS и в режиме platform',
  );
  assert.match(hiw, /from '[./]+\/components\/EmbeddedAssistant'/, 'how-it-works: панель через EmbeddedAssistant');

  const emb = read('src/components/EmbeddedAssistant.tsx');
  assert.match(emb, /^'use client';/, 'EmbeddedAssistant: клиентский модуль');
  // Сворачиваемая `next build` форма: имя переменной целиком, строгое
  // сравнение со строкой; синхронная ветка — `require` (импорт был бы в
  // бандле всегда), ленивая — `import()`.
  assert.match(
    emb,
    /process\.env\.NEXT_PUBLIC_ASSIST_WIDGET === 'platform'\s*\?\s*lazyEmbedded\(\)\s*:\s*\(require\('\.\/AssistantWidget'\)/,
    'EmbeddedAssistant: выбор ветки не сворачивается сборкой',
  );
  assert.match(emb, /lazy\(\(\) => import\('\.\/AssistantWidget'\)/, 'EmbeddedAssistant: в platform — React.lazy');
  assert.doesNotMatch(emb, /^import (?!type )[^;]*'\.\/AssistantWidget'/m, 'EmbeddedAssistant: значимый импорт AssistantWidget');
  assert.doesNotMatch(emb, /'next\/dynamic'/, 'EmbeddedAssistant: рантайм next/dynamic лёг бы в чанк страницы и в legacy');
  // Ветка `platform` действительно выбирается этим значением переключателя.
  assert.equal(
    resolveAssistWidget({
      NEXT_PUBLIC_ASSIST_WIDGET: 'platform',
      NEXT_PUBLIC_ASSIST_WIDGET_SRC: SRC,
      NEXT_PUBLIC_ASSIST_WIDGET_SITE_KEY: PK,
    }).mode,
    'platform',
  );

  // Поведение модуля: без переменной и с `legacy` — сам AssistantWidget,
  // с `platform` — ленивая обёртка.
  const embFile = path.join(ROOT, 'src/components/EmbeddedAssistant.tsx');
  const loadEmbedded = (mode: string | undefined) => {
    const saved = process.env.NEXT_PUBLIC_ASSIST_WIDGET;
    try {
      if (mode === undefined) delete process.env.NEXT_PUBLIC_ASSIST_WIDGET;
      else process.env.NEXT_PUBLIC_ASSIST_WIDGET = mode;
      delete require.cache[require.resolve(embFile)];
      return (require(embFile) as typeof import('../src/components/EmbeddedAssistant')).EmbeddedAssistantWidget;
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_ASSIST_WIDGET;
      else process.env.NEXT_PUBLIC_ASSIST_WIDGET = saved;
    }
  };
  const { AssistantWidget } = require('../src/components/AssistantWidget') as typeof import('../src/components/AssistantWidget');
  assert.equal(loadEmbedded(undefined), AssistantWidget, 'без переменной — синхронная панель');
  assert.equal(loadEmbedded('legacy'), AssistantWidget, 'legacy — синхронная панель');
  const lazyPanel = loadEmbedded('platform');
  assert.notEqual(lazyPanel, AssistantWidget, 'platform — не синхронный импорт');
  assert.equal(lazyPanel.name, 'LazyEmbeddedAssistantWidget', 'platform — ленивая обёртка');
}
const comp = read('src/components/PlatformAssist.tsx');
assert.match(comp, /requestIdleCallback/, 'загрузчик — после load + idle');
assert.match(comp, /s\.async = true/, 'загрузчик — async');
assert.doesNotMatch(comp, /from '\.\.\/lib\/|from 'react-dom'|import .* from '(?!react')/, 'без зависимостей кроме react');

// Имя глобала загрузчика — заглушка бренда В-1 (`WIDGET_GLOBAL`): сменят в
// brand.ts — очередь `V4CAssist.q` лендинга перестанет читаться загрузчиком.
const brandFile = path.resolve(ROOT, '..', 'sites-backend', 'src', 'brand.ts');
if (existsSync(brandFile)) {
  const g = /export const WIDGET_GLOBAL = '([^']+)'/.exec(readFileSync(brandFile, 'utf8'))?.[1];
  assert.ok(g, 'brand.ts: нет WIDGET_GLOBAL');
  assert.match(comp, new RegExp(`const GLOBAL = '${g}';`), `PlatformAssist: глобал загрузчика не ${g} (brand.ts)`);
}

// 3. CSP.
const csp = widgetCspSources(SRC);
assert.deepEqual(csp, {
  'script-src': 'https://w.v4c.example.invalid',
  'frame-src': 'https://w.v4c.example.invalid',
  'img-src': 'https://w.v4c.example.invalid data:',
  'connect-src': 'https://w.v4c.example.invalid',
});
for (const rel of ['next.config.js', 'src/middleware.ts', 'vercel.json']) {
  if (!existsSync(path.join(ROOT, rel))) continue;
  const text = read(rel);
  if (/Content-Security-Policy/i.test(text)) {
    assert.match(
      text,
      /widgetCspSources|NEXT_PUBLIC_ASSIST_WIDGET_SRC/,
      `${rel}: появился CSP — допишите в него origin виджета (widgetCspSources)`
    );
  }
}

console.log('assist-widget: ok');
