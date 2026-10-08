#!/usr/bin/env node
/**
 * Размерный бюджет виджета в CI (ТЗ §4.12: «бюджет проверяется в CI»;
 * приёмка Э2 п.1): загрузчик ≤ 12 КБ gzip, чат (js + css) ≤ 60 КБ gzip.
 * Свой скрипт вместо `size-limit` (тот же замер gzip, без 30 зависимостей).
 *
 * Плюс проверка собранного ЗАГРУЗЧИКА на HTML-приёмники и eval (§4.12,
 * аудит 1.2): линт ловит исходники, а здесь — то, что могло прийти из
 * сборки/зависимостей.
 *
 *   npm run build && npm run size
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = 1024;

export const BUDGETS = [
  { name: 'loader', files: ['dist/v1/loader.js'], maxGzip: 12 * KB },
  {
    name: 'chat',
    files: ['dist/v1/chat.js', 'dist/v1/chat.css'],
    maxGzip: 60 * KB,
  },
  // Э3: режим выбора цели (только владельцу по `?v4c_goal=`, §5-тер.1).
  { name: 'picker', files: ['dist/v1/picker.js'], maxGzip: 10 * KB },
  // Э3 (интеграция): вовлечение и цели — ленивый чанк загрузчика (после
  // load + простоя или при первом взаимодействии, только при целях/триггерах).
  { name: 'engage', files: ['dist/v1/engage.js'], maxGzip: 8 * KB },
  // Э5: голос — ленивый чанк iframe-чата (запись, детектор речи, плеер);
  // грузится, только когда голос включён в конфиге сайта.
  { name: 'voice', files: ['dist/v1/voice.js'], maxGzip: 4 * KB },
  // Э6: «показать на экране» — ленивый чанк загрузчика, только по клику
  // посетителя на «Показать на странице» (исполняется в origin заказчика).
  { name: 'highlight', files: ['dist/v1/highlight.js'], maxGzip: 3 * KB },
  // Э6-бис: голосовое управление — снимок страницы и исполнитель шагов;
  // ленивый чанк загрузчика, только по команде своего iframe (после речи
  // или набора посетителя), исполняется в origin заказчика.
  { name: 'act', files: ['dist/v1/act.js'], maxGzip: 9 * KB },
  // Э6-бис (д): «Вернуть как было» для полей — ленивый чанк act.js (только
  // после «Вернуть»/«отмени последнее» посетителя); act.js не растёт.
  { name: 'undo', files: ['dist/v1/undo.js'], maxGzip: 2 * KB },
  // Э6-тер (и): компенсация объявленной пары («убрать из корзины» строки того
  // же товара, ТЗ §5-бис.15 п.6) — НОВЫЙ ленивый чанк undo.js (только после
  // «Вернуть»/«отмени последнее» и отметки `dispatched` на сервере). Внутри —
  // поиск строки, те же запреты живой цели, что у act.js (стоп-лист uk/ru/en
  // ≈ 0,6 КБ, denylist/зоны, оплата, origin, жест), подсветка и проверка
  // результата: ≈ 3,0 КБ. В act.js (9 КБ, тогда запас 9 байт; после
  // аудита C — сжатие имён `_x`, vite.mangle.ts — ≈ 0,25 КБ) и undo.js (2 КБ,
  // ≈ 0,2 КБ запаса) это не помещается, а их бюджеты не повышаем — поэтому
  // отдельный чанк со своим бюджетом 4 КБ (запас под порт правил строки).
  { name: 'comp', files: ['dist/v1/comp.js'], maxGzip: 4 * KB },
  // Э6-бис (г): мастер проверки Т-2 — окружение и разметка страницы; ленивый
  // чанк загрузчика только в тестовой сессии владельца (у посетителей нет).
  { name: 'check', files: ['dist/v1/check.js'], maxGzip: 6 * KB },
  // Э6-бис (г): мастер проверки — логика и тексты (uk/ru/en); ленивый чанк
  // iframe-чата только в тестовой сессии владельца (chat.js не растёт).
  { name: 'vt', files: ['dist/v1/vt.js'], maxGzip: 10 * KB },
  // Э7: «Админка» — ленивый чанк на странице админки заказчика (кнопка,
  // iframe `wa.`, JWT сотрудника) и чат сотрудника в iframe `wa.`; загрузчик
  // только отдаёт управление (его бюджет 12 КБ не растёт).
  { name: 'admin', files: ['dist/v1/admin.js'], maxGzip: 4 * KB },
  {
    name: 'admin-chat',
    files: ['dist/v1/admin-chat.js', 'dist/v1/admin-chat.css'],
    maxGzip: 12 * KB,
  },
  // Э6-бис (б): голосовое управление «Админкой» — исполнитель на странице
  // админки (ленивый чанк admin.js по команде своего iframe `wa.`; снимок с
  // фильтром строк таблиц, регистратор мастера) и сторона iframe `wa.`
  // (ленивый чанк admin-chat.js, только при включённом режиме или ссылке
  // мастера). admin.js, admin-chat.js и act.js не растут.
  { name: 'admin-act', files: ['dist/v1/admin-act.js'], maxGzip: 11 * KB },
  { name: 'admin-vc', files: ['dist/v1/admin-vc.js'], maxGzip: 22 * KB },
  // Э3-бис: связанный режим по согласию (ленивый чанк engage.js, только при
  // поле `analytics` конфига) и поведение (ленивый чанк ana.js, только с
  // согласием и включённым поведением; §5-тер.8 — ≤ 4 КБ gzip).
  { name: 'ana', files: ['dist/v1/ana.js'], maxGzip: 4 * KB },
  // Э6-тер: редактор голосовой карты — пикер в origin заказчика (только по
  // ссылке владельца `?v4c_edit=`; ТЗ §5-кватер.3: ≤ 40 КБ) и панель в
  // iframe `we.`; загрузчик лишь отдаёт управление.
  { name: 'editor', files: ['dist/v1/editor.js'], maxGzip: 40 * KB },
  {
    name: 'editor-panel',
    files: ['dist/v1/editor-panel.js', 'dist/v1/editor-panel.css'],
    maxGzip: 16 * KB,
  },
  // Заход 10 (разгрузка `editor-panel`, 15,73 → ≈ 13,1 КБ): словари ru/en
  // панели — ленивые ES-модули по `ready` пикера (в панели — только uk);
  // №113 «Промахи»/«Пропозиції»/ИИ-синонимы — ленивый `editor-assist.js`
  // (только по вкладке или кнопке в карточке). Все — iframe `we.`.
  {
    name: 'editor-panel-ru',
    files: ['dist/v1/editor-panel-ru.js'],
    maxGzip: 4 * KB,
  },
  {
    name: 'editor-panel-en',
    files: ['dist/v1/editor-panel-en.js'],
    maxGzip: 4 * KB,
  },
  {
    name: 'editor-assist',
    files: ['dist/v1/editor-assist.js'],
    maxGzip: 6 * KB,
  },
  { name: 'bf', files: ['dist/v1/bf.js'], maxGzip: 4 * KB },
];

export const LOADER_SINKS = [
  /\.innerHTML\s*=/,
  /\.outerHTML\s*=/,
  /insertAdjacentHTML\s*\(/,
  /document\.write(ln)?\s*\(/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /createContextualFragment\s*\(/,
];

function gzipSize(buf) {
  return zlib.gzipSync(buf, { level: 9 }).length;
}

let ok = true;
for (const b of BUDGETS) {
  let total = 0;
  for (const f of b.files) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) {
      console.error(`size-budget: нет ${f} — сначала npm run build`);
      process.exit(1);
    }
    total += gzipSize(fs.readFileSync(abs));
  }
  const line = `${b.name}: ${(total / KB).toFixed(2)} КБ gzip (бюджет ${b.maxGzip / KB} КБ)`;
  if (total > b.maxGzip) {
    ok = false;
    console.error(`ПРЕВЫШЕН ${line}`);
  } else {
    console.log(`ok   ${line}`);
  }
}

// Загрузчик и режим выбора цели исполняются в origin заказчика.
for (const [label, file] of [
  ['загрузчик', 'dist/v1/loader.js'],
  ['режим выбора цели', 'dist/v1/picker.js'],
  ['чанк вовлечения и целей', 'dist/v1/engage.js'],
  // Э5: чанк голоса живёт в iframe, но HTML-приёмников и eval в нём тоже
  // нет и не будет (Trusted Types iframe — 'none').
  ['чанк голоса', 'dist/v1/voice.js'],
  // Э6: подсветка — в origin заказчика, как загрузчик.
  ['чанк подсветки', 'dist/v1/highlight.js'],
  // Э6-бис: голосовое управление — в origin заказчика, как загрузчик.
  ['чанк голосового управления', 'dist/v1/act.js'],
  // Э6-бис (д): возврат полей — в origin заказчика, как загрузчик.
  ['чанк возврата полей', 'dist/v1/undo.js'],
  // Э6-тер (и): компенсации — в origin заказчика, как загрузчик.
  ['чанк компенсаций', 'dist/v1/comp.js'],
  // Э6-бис (г): мастер проверки — в origin заказчика, как загрузчик.
  ['чанк проверки мастера', 'dist/v1/check.js'],
  // Мастер в iframe: HTML-приёмников нет (Trusted Types iframe — 'none').
  ['чанк мастера iframe', 'dist/v1/vt.js'],
  // Э7: «Админка» — чанк в origin админки заказчика и чат сотрудника `wa.`.
  ['чанк «Админки»', 'dist/v1/admin.js'],
  ['чат сотрудника', 'dist/v1/admin-chat.js'],
  // Э6-бис (б): исполнитель «Админки» — в origin админки заказчика; сторона
  // iframe `wa.` — Trusted Types 'none'.
  ['исполнитель «Админки»', 'dist/v1/admin-act.js'],
  ['голосовое управление «Админкой» (iframe)', 'dist/v1/admin-vc.js'],
  // Э3-бис: связанный режим и поведение — в origin заказчика.
  ['чанк связанного режима', 'dist/v1/ana.js'],
  ['чанк поведения', 'dist/v1/bf.js'],
  // Э6-тер: пикер редактора — в origin заказчика; панель — iframe `we.`.
  ['пикер редактора', 'dist/v1/editor.js'],
  ['панель редактора', 'dist/v1/editor-panel.js'],
  // Заход 10: ленивые модули панели (iframe `we.`, Trusted Types 'none').
  ['словарь панели ru', 'dist/v1/editor-panel-ru.js'],
  ['словарь панели en', 'dist/v1/editor-panel-en.js'],
  ['подсказки панели (№113)', 'dist/v1/editor-assist.js'],
]) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const re of LOADER_SINKS) {
    if (re.test(code)) {
      ok = false;
      console.error(`${label}: найден запрещённый приёмник ${re} (§4.12)`);
    }
  }
}
// Аудит 06.10: lookbehind `(?<=…)`/`(?<!…)` в регулярке — SyntaxError разбора
// ВСЕГО чанка в Safari < 16.4 (iOS 15/16.3): чанк не исполняется вовсе.
// Начало слова — группой `(?:^|[^\p{L}])`; проверяем собранное (могло
// прийти из зависимостей/портов).
export const LOOKBEHIND = /\(\?<[=!]/;
for (const b of BUDGETS) {
  for (const f of b.files) {
    if (!f.endsWith('.js')) continue;
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const m = LOOKBEHIND.exec(code);
    if (m) {
      ok = false;
      console.error(
        `ОШИБКА ${f}: lookbehind в регулярке («${code.slice(m.index, m.index + 40)}…») — ` +
          'чанк не разберётся в Safari < 16.4; замените на (?:^|[^\\p{L}])'
      );
    }
  }
}
// Аудит C (vite.mangle.ts): имена `_x` загрузчика, act.js и admin-act.js
// сжаты сборкой — в собранном чанке нет ни одного `._x` из исходников
// (иначе сжатие не сработало или имя ушло мимо — scripts/mangle.test.ts).
for (const [file, srcs] of [
  ['dist/v1/loader.js', ['src/loader/index.ts', 'src/loader/ui.ts']],
  ['dist/v1/act.js', ['src/act/exec.ts', 'src/act/index.ts']],
  ['dist/v1/admin-act.js', ['src/act/exec.ts', 'src/admin-act/index.ts']],
]) {
  const names = new Set();
  for (const f of srcs)
    for (const m of fs
      .readFileSync(path.join(ROOT, f), 'utf8')
      .matchAll(/\.(_[A-Za-z][\w$]+)/g))
      names.add(m[1]);
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const left = [...names].filter((n) =>
    new RegExp(`\\.${n.replace('$', '\\$')}(?![\\w$])`).test(code)
  );
  if (!names.size || left.length) {
    ok = false;
    console.error(
      `${file}: имена не сжаты (${left.join(', ') || 'нет имён `_x`'}) — mangleProps`
    );
  } else console.log(`ok   ${file}: ${names.size} имён \`_x\` сжато`);
}
// Э6-бис (§5-бис.10 п.13): в боевом чанке голоса нет тестового хука WebAudio.
{
  const voice = fs.readFileSync(path.join(ROOT, 'dist/v1/voice.js'), 'utf8');
  if (/__v4cTestAudio|createMediaStreamDestination/.test(voice)) {
    ok = false;
    console.error(
      'чанк голоса: в боевой сборке найден тестовый хук WebAudio (§5-бис.12)'
    );
  } else console.log('ok   чанк голоса: тестового хука WebAudio нет');
}
process.exit(ok ? 0 : 1);
