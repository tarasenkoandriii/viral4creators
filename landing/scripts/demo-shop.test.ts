/**
 * Демо-витрина `/qa/demo-shop` (`src/app/qa/demo-shop/`) — шов «каталог =
 * страница» и полнота словаря.
 *
 * Каталог-контракт — `backend/src/modules/tutorial-runner/polygon-catalog.ts`
 * (`DEMO_SHOP_HOOKS`): по нему раннер валидирует селекторы демо-семейства
 * `site-tutorial-demo-*`. Если страница отстанет от каталога, сценарий
 * С2/С3/С4 упадёт не потому, что плох раннер, а потому, что на витрине нет
 * элемента; если на странице появится `data-qa` вне каталога — им начнут
 * пользоваться в обход контракта.
 *
 * Что держит этот тест:
 *  1. каталог читается из backend-файла (регэкспом — landing не тянет
 *     backend в свою сборку) и не пуст, id уникальны;
 *  2. в исходниках витрины (без комментариев) каждый id каталога записан
 *     литералом `data-qa="…"` РОВНО один раз, других `data-qa` нет, и
 *     вычисленных (`data-qa={…}`, `'data-qa'`) нет вовсе — их шов не видит;
 *  3. серверная отрисовка на пяти языках: `lang`, только каталожные
 *     `data-qa`, каждый не больше одного раза;
 *  4. словарь страницы полон для uk/ru/en/de/es: одна форма, непустые
 *     строки, одинаковые подстановки `{…}`; языки действительно разные;
 *     ключевые надписи сценариев на uk — как в решении владельца;
 *  5. `?lang=` → язык, по умолчанию uk;
 *  6. слоты записи статичны и без дат, «Пн, 10:00» есть;
 *  7. ни сети, ни таймеров, ни анимаций в исходниках витрины;
 *  8. служебность: `noindex`, `/qa/` закрыт в `robots.ts` и исключён из
 *     middleware локалей, в `sitemap.ts` и в остальном лендинге ссылок на
 *     витрину нет, маршрут каталога `POLYGON_ROUTES` ведёт на эту страницу.
 *
 * Живой проход сценариев (Playwright, 390×844, обе темы) — в отчёте сдачи,
 * не здесь: `npm test` браузера не поднимает.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DemoShopClient } from '../src/app/qa/demo-shop/DemoShopClient';
import { DEMO_SHOP_CSS } from '../src/app/qa/demo-shop/demo-shop-styles';
import {
  DEMO_SHOP_COPY,
  DEMO_SHOP_DELIVERY_FEE,
  DEMO_SHOP_LANGS,
  DEMO_SHOP_ORDER_NUMBER,
  DEMO_SHOP_SLOTS,
  fill,
  resolveDemoShopLang,
} from '../src/app/qa/demo-shop/demo-shop-copy';

// См. greeting-sections.test.ts: tsx собирает JSX в `React.createElement`.
(globalThis as { React?: typeof React }).React = React;

const LANDING = path.join(__dirname, '..');
const REPO = path.join(LANDING, '..');
const SHOP_DIR = path.join(LANDING, 'src', 'app', 'qa', 'demo-shop');
const CATALOG_FILE = path.join(
  REPO,
  'backend',
  'src',
  'modules',
  'tutorial-runner',
  'polygon-catalog.ts',
);

/** Комментарии вон: id в доккомментарии — не элемент страницы. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

// ── 1. Каталог из backend ──
const catalogSrc = stripComments(fs.readFileSync(CATALOG_FILE, 'utf8'));
const hooksBlock = /DEMO_SHOP_HOOKS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(catalogSrc)?.[1];
assert.ok(hooksBlock, 'шов ослеп: в polygon-catalog.ts не найден DEMO_SHOP_HOOKS = [...] as const');
const HOOKS = [...hooksBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
assert.ok(HOOKS.length >= 10, `шов ослеп: в каталоге всего ${HOOKS.length} id`);
assert.equal(new Set(HOOKS).size, HOOKS.length, 'в каталоге есть повторяющиеся id');
for (const hook of HOOKS) {
  assert.match(hook, /^demo-shop-[a-z0-9-]+$/, `id каталога «${hook}» не в форме demo-shop-*`);
}
// Каждая строка-литерал блока — id: регэксп не пропустил ни одного.
assert.equal(
  HOOKS.length,
  (hooksBlock.match(/['"`]/g) ?? []).length / 2,
  'шов ослеп: в DEMO_SHOP_HOOKS есть элементы не в одинарных кавычках',
);

// ── 2. Исходники витрины: каждый id ровно один раз, лишних нет ──
const sources = walk(SHOP_DIR).filter((f) => /\.(ts|tsx)$/.test(f));
assert.ok(
  sources.some((f) => f.endsWith('page.tsx')),
  'нет src/app/qa/demo-shop/page.tsx',
);
const seen = new Map<string, number>();
let literalTotal = 0;
let tokenTotal = 0;
for (const file of sources) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  tokenTotal += (src.match(/data-qa\b/g) ?? []).length;
  for (const m of src.matchAll(/data-qa="([^"]*)"/g)) {
    literalTotal++;
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
}
assert.equal(
  tokenTotal,
  literalTotal,
  'на витрине есть data-qa не литералом data-qa="…" (вычисленный или в объекте) — шов его не видит',
);
for (const hook of HOOKS) {
  assert.equal(
    seen.get(hook) ?? 0,
    1,
    `каталог ждёт «${hook}» на витрине ровно один раз, а он встречается ${seen.get(hook) ?? 0}`,
  );
}
for (const id of seen.keys()) {
  assert.ok(
    HOOKS.includes(id),
    `data-qa="${id}" есть на витрине, но не в DEMO_SHOP_HOOKS — добавьте в каталог или уберите`,
  );
}
assert.equal(literalTotal, HOOKS.length);

// ── 3. Серверная отрисовка на пяти языках ──
for (const lang of DEMO_SHOP_LANGS) {
  const html = renderToStaticMarkup(React.createElement(DemoShopClient, { lang }));
  assert.match(html, new RegExp(`^<div class="ds-root" lang="${lang}"`), `${lang}: корень витрины`);
  const ids = [...html.matchAll(/data-qa="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(ids.includes('demo-shop-root'), `${lang}: нет demo-shop-root`);
  for (const id of [
    'demo-shop-nav-delivery',
    'demo-shop-nav-cart',
    'demo-shop-nav-booking',
    'demo-shop-product-mug-add',
    'demo-shop-booking-open',
  ]) {
    assert.ok(ids.includes(id), `${lang}: первый экран без ${id}`);
  }
  assert.equal(new Set(ids).size, ids.length, `${lang}: data-qa повторяется в DOM`);
  for (const id of ids) assert.ok(HOOKS.includes(id), `${lang}: data-qa="${id}" вне каталога`);
  assert.ok(html.includes(DEMO_SHOP_COPY[lang].brand.replace(/"/g, '&quot;')), `${lang}: бренд`);
}

// ── 4. Словарь: пять языков, одна форма, непустые строки ──
assert.deepEqual([...DEMO_SHOP_LANGS], ['uk', 'ru', 'en', 'de', 'es']);
assert.deepEqual(Object.keys(DEMO_SHOP_COPY).sort(), [...DEMO_SHOP_LANGS].sort());

function leaves(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === 'string') {
    out.set(prefix, value);
    return out;
  }
  assert.ok(value && typeof value === 'object', `словарь: ${prefix} — не строка и не объект`);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    for (const [kk, vv] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(kk, vv);
  }
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const reference = leaves(DEMO_SHOP_COPY.uk);
assert.ok(reference.size > 50, `словарь uk подозрительно мал: ${reference.size}`);
for (const lang of DEMO_SHOP_LANGS) {
  const own = leaves(DEMO_SHOP_COPY[lang]);
  assert.deepEqual(
    [...own.keys()].sort(),
    [...reference.keys()].sort(),
    `словарь ${lang}: форма не совпадает с uk`,
  );
  for (const [key, value] of own) {
    assert.ok(value.trim().length > 0, `словарь ${lang}: пустая строка ${key}`);
    assert.deepEqual(
      placeholders(value),
      placeholders(reference.get(key)!),
      `словарь ${lang}: подстановки в ${key}`,
    );
  }
  for (const key of ['checkout.deliveryHint', 'delivery.courierPrice']) {
    assert.ok(
      own.get(key)!.includes(String(DEMO_SHOP_DELIVERY_FEE)),
      `словарь ${lang}: ${key} расходится с тарифом`,
    );
  }
}
// Языки действительно разные, а не копия uk.
for (const key of [
  'notice',
  'checkout.submit',
  'order.confirmed',
  'booking.confirmed',
  'delivery.lead',
]) {
  const values = DEMO_SHOP_LANGS.map((l) => leaves(DEMO_SHOP_COPY[l]).get(key));
  assert.equal(
    new Set(values).size,
    DEMO_SHOP_LANGS.length,
    `словарь: ${key} совпадает у двух языков`,
  );
}
// Надписи сценариев С2/С3/С4 на uk — как в решении владельца.
{
  const uk = DEMO_SHOP_COPY.uk;
  assert.equal(uk.nav.cart, 'Кошик');
  assert.equal(uk.checkout.pickup, 'Самовивіз');
  assert.equal(uk.checkout.delivery, 'Доставка');
  assert.equal(uk.checkout.submit, 'Оформити замовлення');
  assert.equal(
    fill(uk.order.confirmed, { order: DEMO_SHOP_ORDER_NUMBER }),
    'Тестове замовлення DEMO-0001 прийнято',
  );
  assert.equal(uk.nav.delivery, 'Доставка й оплата');
  assert.equal(uk.delivery.courier, 'Кур’єром');
  assert.equal(uk.delivery.pickup, 'Самовивіз');
  assert.equal(uk.booking.open, 'Записатися');
  assert.equal(uk.booking.submit, 'Підтвердити запис');
  assert.equal(uk.booking.confirmed, 'Ви записані (тестовий запис)');
  assert.equal(
    fill(uk.order.confirmed, { order: DEMO_SHOP_ORDER_NUMBER }).includes('DEMO-0001'),
    true,
  );
}

// ── 5. ?lang= ──
assert.equal(resolveDemoShopLang(undefined), 'uk');
assert.equal(resolveDemoShopLang(null), 'uk');
assert.equal(resolveDemoShopLang(''), 'uk');
assert.equal(resolveDemoShopLang('fr'), 'uk');
assert.equal(resolveDemoShopLang('RU'), 'ru');
assert.equal(resolveDemoShopLang(' de '), 'de');
assert.equal(resolveDemoShopLang(['en', 'es']), 'en');
for (const lang of DEMO_SHOP_LANGS) assert.equal(resolveDemoShopLang(lang), lang);

// ── 6. Слоты: статичные, без дат ──
{
  const mon10 = DEMO_SHOP_SLOTS.find((s) => s.id === 'mon-10');
  assert.ok(mon10 && mon10.day === 'mon' && mon10.time === '10:00', 'нет слота mon-10 = Пн, 10:00');
  assert.equal(
    fill(DEMO_SHOP_COPY.uk.booking.slot, {
      day: DEMO_SHOP_COPY.uk.booking.days.mon,
      time: mon10.time,
    }),
    'Пн, 10:00',
  );
  for (const s of DEMO_SHOP_SLOTS)
    assert.match(s.time, /^\d{2}:\d{2}$/, `слот ${s.id}: время без даты`);
}

// ── 7. Ни сети, ни таймеров, ни анимаций ──
for (const file of sources) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(LANDING, file);
  assert.doesNotMatch(
    src,
    /\b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|fetch|XMLHttpRequest|WebSocket|EventSource|lazy|Suspense)\b|next\/dynamic|transition|animation|@keyframes|behavior:\s*"smooth"/,
    `${rel}: на витрине нет места сети, таймерам, ленивым блокам и анимациям — каждое действие мгновенно`,
  );
}

// Плавная прокрутка лендинга (`globals.css`) на витрине выключена: иначе
// раннер на каждой цели ниже экрана ждёт, пока прокрутка доедет (замер
// при сдаче: ~0,4–0,9 с на шаг «Підтвердити запис» в С4).
assert.match(
  DEMO_SHOP_CSS,
  /html:has\(\.ds-root\)\s*\{\s*scroll-behavior:\s*auto;\s*\}/,
  'витрина не гасит плавную прокрутку лендинга',
);

// Сброс стилей элементов — только с нулевой специфичностью (`:where`):
// `.ds-root button` перебивал цвет `.ds-btn`, и текст кнопок становился
// тёмным на тёмном акценте (контраст 2,5:1, найдено замером при сдаче).
assert.ok(
  !/(^|[\s,}])\.ds-root\s+(button|input|h1|h2|h3|p)\b/m.test(DEMO_SHOP_CSS),
  'сброс элементов витрины с весом класса перебивает классы кнопок и заголовков',
);

// ── 8. Служебность ──
{
  const page = stripComments(fs.readFileSync(path.join(SHOP_DIR, 'page.tsx'), 'utf8'));
  assert.match(
    page,
    /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/,
    'page.tsx: нет noindex',
  );
  const robots = stripComments(
    fs.readFileSync(path.join(LANDING, 'src', 'app', 'robots.ts'), 'utf8'),
  );
  assert.match(robots, /DISALLOWED_PATHS = \[[^\]]*'\/qa\/'/, 'robots.ts не закрывает /qa/');
  const middleware = fs.readFileSync(path.join(LANDING, 'src', 'middleware.ts'), 'utf8');
  assert.match(
    middleware,
    /\|qa\/\|/,
    'middleware: /qa/ не исключён из локалей — витрина уедет на /<locale>/qa/…',
  );
  const sitemap = fs.readFileSync(path.join(LANDING, 'src', 'app', 'sitemap.ts'), 'utf8');
  assert.doesNotMatch(sitemap, /demo-shop/, 'витрина попала в sitemap.ts');
  for (const file of walk(path.join(LANDING, 'src'))) {
    if (file.startsWith(SHOP_DIR + path.sep) || !/\.(ts|tsx|json|css)$/.test(file)) continue;
    assert.doesNotMatch(
      fs.readFileSync(file, 'utf8'),
      /qa\/demo-shop/,
      `${path.relative(LANDING, file)} ссылается на служебную витрину`,
    );
  }
  const route = /'qa-demo-shop':\s*'([^']+)'/.exec(catalogSrc)?.[1];
  assert.equal(route, '/qa/demo-shop', 'POLYGON_ROUTES.qa-demo-shop в каталоге не /qa/demo-shop');
  assert.ok(
    fs.existsSync(path.join(LANDING, 'src', 'app', route, 'page.tsx')),
    'маршрут каталога ведёт на 404',
  );
}

console.log(
  `demo-shop: ${HOOKS.length} элементов каталога = страница, ${DEMO_SHOP_LANGS.length} языков × ${reference.size} строк`,
);
