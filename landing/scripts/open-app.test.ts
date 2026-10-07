/**
 * Ш5 (6): страница-переход «Открыть приложение» (`/<локаль>/open`) — цель
 * действия «открыть приложение» виджета ИИ-помощника (прямой `t.me`
 * фильтр ссылок платформы не пускает). Проверяется то, что ломается молча:
 *  - тексты всех пяти локалей (пустая строка — пустая кнопка);
 *  - кнопка Telegram этой страницы — тот же `t.me/<бот>/app?startapp=e_ads`,
 *    что у главной; браузерная — `TMA_URL?entry=ads`;
 *  - `noindex` и отсутствие в sitemap (служебная страница — не контент);
 *  - сегмент адреса совпадает с тем, на который ссылаются документы знаний
 *    тенанта (`backend/src/common/tutorial-knowledge/knowledge-sync.ts`,
 *    `OPEN_APP_PATH`): разъедутся — кнопка виджета поведёт на 404.
 * Схема та же, что у остальных тестов лендинга: `node:assert` + `tsx`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPEN_APP_COPY, OPEN_APP_ENTRY, OPEN_APP_SEGMENT } from '../src/app/[locale]/open/open-copy';
import { locales } from '../src/lib/i18n';
import { browserEntryLink, telegramEntryLink } from '../src/lib/telegram-entry';
import { getDictionary } from '../src/lib/get-dictionary';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(here, '..', rel), 'utf8');

// ── тексты ─────────────────────────────────────────────────────────────
for (const l of locales) {
  const t = OPEN_APP_COPY[l];
  assert.ok(t, `нет текстов локали ${l}`);
  for (const [k, v] of Object.entries(t)) {
    assert.ok(typeof v === 'string' && v.trim().length > 0, `${l}.${k} пустой`);
    // Адресов в тексте нет: ссылки — только кнопками.
    assert.doesNotMatch(v, /https?:\/\/|t\.me\//, `${l}.${k}: адрес в тексте`);
  }
  assert.ok(getDictionary(l).entryActions.telegramCta.trim(), `${l}: подпись Telegram`);
}
// Локали страницы — ровно локали лендинга (лишняя/забытая — ошибка).
assert.deepEqual(Object.keys(OPEN_APP_COPY).sort(), [...locales].sort());

// ── ссылки ─────────────────────────────────────────────────────────────
assert.equal(OPEN_APP_ENTRY, 'ads');
assert.equal(
  telegramEntryLink(OPEN_APP_ENTRY, 'v4c_bot'),
  'https://t.me/v4c_bot/app?startapp=e_ads',
);
assert.equal(
  browserEntryLink(OPEN_APP_ENTRY, 'https://app.example'),
  'https://app.example?entry=ads#/projects/new',
);

// ── страница: noindex, статическая, кнопки — EntryActions ─────────────
const page = read(`src/app/[locale]/${OPEN_APP_SEGMENT}/page.tsx`);
assert.match(page, /robots:\s*\{\s*index:\s*false,\s*follow:\s*true\s*\}/, 'страница обязана быть noindex');
assert.match(page, /generateStaticParams/, 'страница — статическая по локалям');
assert.match(page, /<EntryActions[\s\S]*entry=\{OPEN_APP_ENTRY\}/, 'кнопки — общие EntryActions');
assert.doesNotMatch(page, /force-dynamic/);
// В sitemap её нет.
assert.doesNotMatch(read('src/app/sitemap.ts'), new RegExp(`['"/]${OPEN_APP_SEGMENT}['"]`));

// ── сегмент = OPEN_APP_PATH синхронизации знаний ──────────────────────
const sync = path.resolve(here, '../../backend/src/common/tutorial-knowledge/knowledge-sync.ts');
if (existsSync(sync)) {
  const m = /export const OPEN_APP_PATH = '([^']+)'/.exec(readFileSync(sync, 'utf8'));
  assert.ok(m, 'OPEN_APP_PATH не найден в knowledge-sync.ts');
  assert.equal(m[1], OPEN_APP_SEGMENT, 'адрес документов знаний и маршрут страницы разошлись');
  console.log('open-app: сегмент совпадает с OPEN_APP_PATH синхронизации знаний');
} else {
  console.log('open-app: backend рядом нет — сверка с синхронизацией знаний пропущена');
}

console.log('open-app: тексты 5 локалей, ссылки Telegram/браузера, noindex, вне sitemap');
