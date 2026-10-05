/**
 * Заголовки CDN виджета (`vercel.json`): шрифты iframe (§3, О-6) — immutable
 * с долгим max-age (гарнитуры кириллицы тяжёлые, грузятся при каждом
 * открытии чата; замена файла шрифта = новое имя файла). Загрузчик и чат —
 * короткий кэш (новая версия у заказчиков за 5 мин). `ignoreCommand` —
 * зона scripts/check-vercel-ignore.mjs, здесь только «есть».
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface Rule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}
const cfg = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
) as { ignoreCommand?: string; headers: Rule[] };

function header(path: string, key: string): string | undefined {
  // Vercel: source — path-to-regexp; здесь хватает «(…)» как группы.
  const rule = cfg.headers.find((r) =>
    new RegExp(`^${r.source.replace(/\(\.\*\)/g, '.*')}$`).test(path)
  );
  return rule?.headers.find((h) => h.key === key)?.value;
}

const fontCache = header('/v1/fonts/inter-cyrillic.woff2', 'Cache-Control');
assert.ok(fontCache, 'нет правила кэша для /v1/fonts/*');
assert.match(fontCache!, /\bimmutable\b/);
const maxAge = Number(/max-age=(\d+)/.exec(fontCache!)?.[1] ?? 0);
assert.ok(maxAge >= 31536000, `max-age шрифтов ${maxAge} < года`);
assert.equal(
  header('/v1/fonts/inter-cyrillic.woff2', 'X-Content-Type-Options'),
  'nosniff'
);
assert.match(
  header('/v1/loader.js', 'Cache-Control') ?? '',
  /max-age=300\b/,
  'загрузчик — короткий кэш'
);
// Чанк вовлечения и целей — ES-модуль, загрузчик берёт его import() с
// origin виджета на странице заказчика: без CORS модуль не исполнится.
assert.match(
  header('/v1/engage.js', 'Cache-Control') ?? '',
  /max-age=300\b/,
  'engage.js — короткий кэш, как у загрузчика'
);
assert.equal(header('/v1/engage.js', 'Access-Control-Allow-Origin'), '*');
assert.equal(header('/v1/engage.js', 'X-Content-Type-Options'), 'nosniff');
// Э5: чанк голоса — грузит iframe со своего origin (CORS не нужен), кэш
// короткий: новая версия записи/детектора речи — у всех за 5 минут.
assert.match(
  header('/v1/voice.js', 'Cache-Control') ?? '',
  /max-age=300\b/,
  'voice.js — короткий кэш'
);
assert.equal(header('/v1/voice.js', 'X-Content-Type-Options'), 'nosniff');
assert.equal(header('/v1/voice.js', 'Access-Control-Allow-Origin'), undefined);
// Э6: чанк подсветки — как engage.js: import() с origin виджета на
// странице заказчика (нужен CORS), кэш короткий.
assert.match(
  header('/v1/highlight.js', 'Cache-Control') ?? '',
  /max-age=300\b/,
  'highlight.js — короткий кэш'
);
assert.equal(header('/v1/highlight.js', 'Access-Control-Allow-Origin'), '*');
assert.equal(header('/v1/highlight.js', 'X-Content-Type-Options'), 'nosniff');
// Э6-бис: чанк голосового управления — тоже import() загрузчика с origin
// виджета на странице заказчика (CORS), короткий кэш: откат версии — 5 мин.
assert.match(
  header('/v1/act.js', 'Cache-Control') ?? '',
  /max-age=300\b/,
  'act.js — короткий кэш'
);
assert.equal(header('/v1/act.js', 'Access-Control-Allow-Origin'), '*');
assert.equal(header('/v1/act.js', 'X-Content-Type-Options'), 'nosniff');
// Э6-бис (д): «Вернуть» для полей — import() из act.js с origin виджета.
assert.match(header('/v1/undo.js', 'Cache-Control') ?? '', /max-age=300\b/);
assert.equal(header('/v1/undo.js', 'Access-Control-Allow-Origin'), '*');
assert.equal(header('/v1/undo.js', 'X-Content-Type-Options'), 'nosniff');
// Э7: «Админка» — отдельный origin (`wa.`, ТЗ §4.12, У-13). На домене
// «Админки» Vercel пропускает к API ТОЛЬКО `/wa/v1/*` и `/assist-admin/v1/*`,
// на домене виджета — только публичные `/w/v1/*` и `/widget/v1/*`: публичный
// чат не открывается на origin сотрудника (и наоборот) даже при ошибке ссылки.
type Cond = Array<{ type: string; value: string }>;
const rewrites = (
  cfg as unknown as {
    rewrites: Array<{ source: string; has?: Cond; missing?: Cond }>;
  }
).rewrites;
const rw = (src: string) => rewrites.find((r) => r.source === src);
const adminHost = rw('/wa/v1/:path*')?.has?.find(
  (c) => c.type === 'host'
)?.value;
assert.ok(adminHost, '/wa/v1/* — только на домене «Админки» (has host)');
assert.equal(
  rw('/assist-admin/v1/:path*')?.has?.find((c) => c.type === 'host')?.value,
  adminHost,
  '/assist-admin/v1/* — только на домене «Админки»'
);
for (const pub of ['/w/v1/:path*', '/widget/v1/:path*']) {
  assert.equal(
    rw(pub)?.missing?.find((c) => c.type === 'host')?.value,
    adminHost,
    `${pub} не должен работать на домене «Админки»`
  );
}
assert.equal(header('/v1/admin.js', 'Access-Control-Allow-Origin'), '*');
assert.match(header('/v1/admin.js', 'Cache-Control') ?? '', /max-age=300\b/);
assert.match(
  header('/v1/admin-chat.js', 'Cache-Control') ?? '',
  /max-age=300\b/
);
assert.equal(
  header('/v1/admin-chat.js', 'Access-Control-Allow-Origin'),
  undefined
);
// Э6-бис (б): исполнитель «Админки» — import() со страницы админки
// заказчика (нужен CORS); чанк iframe `wa.` — со своего origin (CORS нет).
assert.equal(header('/v1/admin-act.js', 'Access-Control-Allow-Origin'), '*');
assert.match(
  header('/v1/admin-act.js', 'Cache-Control') ?? '',
  /max-age=300\b/
);
assert.equal(
  header('/v1/admin-vc.js', 'Access-Control-Allow-Origin'),
  undefined
);
assert.equal(header('/v1/admin-vc.js', 'X-Content-Type-Options'), 'nosniff');
assert.ok(cfg.ignoreCommand, 'ignoreCommand пропал');
console.log(
  'vercel.json: шрифты immutable, загрузчик, engage.js, voice.js, highlight.js и act.js — 5 мин'
);
