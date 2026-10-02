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
assert.ok(cfg.ignoreCommand, 'ignoreCommand пропал');
console.log(
  'vercel.json: шрифты immutable, загрузчик, engage.js и voice.js — 5 мин'
);
