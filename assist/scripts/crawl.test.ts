import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CRAWL_RUN_STATUSES,
  SKIP_REASONS,
  crawlActive,
  parseCrawlRun,
  parseSkippedByReason,
  skipReasonText,
  sortedSkips,
  toCount,
} from '../src/kit/crawl';
import { en } from '../src/kit/dictionaries/en';
import { ru } from '../src/kit/dictionaries/ru';
import { uk } from '../src/kit/dictionaries/uk';

// ── Причины пропуска и статусы — зеркало site-crawl/types.ts ─────────
const src = readFileSync(
  new URL(
    '../../sites-backend/src/modules/site-crawl/types.ts',
    import.meta.url
  ),
  'utf8'
);
function union(re: RegExp): string[] {
  const m = src.match(re);
  assert.ok(m, `site-crawl/types.ts: не найдено ${re}`);
  // Комментарии внутри объединения (/** … 'spa' … */) не считаем.
  const body = m![1].replace(/\/\*[\s\S]*?\*\//g, '');
  return [...body.matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]).sort();
}
assert.deepEqual(
  [...SKIP_REASONS].sort(),
  union(/export type SkipReason\s*=([^;]*);/),
  'SkipReason: список кита расходится с сервером'
);
assert.deepEqual(
  [...CRAWL_RUN_STATUSES].sort(),
  union(/export interface CrawlRunView[\s\S]*?status:([^;]*);/),
  'CrawlRunView.status: список кита расходится с сервером'
);

// ── Тексты: каждая причина и статус — на трёх языках, не копией ──────
for (const d of [uk, ru, en]) {
  assert.deepEqual(
    Object.keys(d.crawl.skip).sort(),
    [...SKIP_REASONS, 'other'].sort()
  );
  assert.deepEqual(
    Object.keys(d.crawl.status).sort(),
    [...CRAWL_RUN_STATUSES].sort()
  );
}
for (const r of [...SKIP_REASONS, 'other'] as const) {
  assert.notEqual(uk.crawl.skip[r], ru.crawl.skip[r], `uk = ru: ${r}`);
  assert.notEqual(en.crawl.skip[r], ru.crawl.skip[r], `en = ru: ${r}`);
}

// ── Разбор ───────────────────────────────────────────────────────────
assert.equal(toCount(3.9), 3);
assert.equal(toCount(-1), 0);
assert.equal(toCount('5'), 0);
assert.equal(toCount(Number.NaN), 0);

// Неизвестная причина не теряется — копится в other; мусор — нет.
assert.deepEqual(
  parseSkippedByReason({ robots: 3, nova: 2, nova2: 1, spa: 0, x: 'a' }),
  { robots: 3, other: 3 }
);
assert.deepEqual(parseSkippedByReason(null), {});
assert.deepEqual(sortedSkips({ robots: 1, spa: 4, noindex: 4 }), [
  { reason: 'noindex', n: 4 },
  { reason: 'spa', n: 4 },
  { reason: 'robots', n: 1 },
]);

assert.equal(parseCrawlRun({}), null, 'прогон без id — не прогон');
assert.equal(parseCrawlRun(null), null);
const run = parseCrawlRun({
  id: 'r1',
  status: 'running',
  trigger: 'manual',
  mode: 'full',
  pagesSeen: 10,
  pagesChanged: 2,
  pagesUnchanged: 7,
  pagesSkipped: 1,
  pagesFailed: 0,
  pagesGone: 0,
  skippedByReason: { unverified_host: 1 },
  startedAt: '2026-10-01T00:00:00.000Z',
  finishedAt: null,
  error: null,
})!;
assert.equal(run.status, 'running');
assert.deepEqual(run.skippedByReason, { unverified_host: 1 });
assert.equal(crawlActive(run), true);
// Неизвестный статус — «в очереди», не «готово».
const weird = parseCrawlRun({ id: 'r2', status: 'finished!' })!;
assert.equal(weird.status, 'queued');
assert.equal(crawlActive({ ...run, status: 'done' }), false);
assert.equal(crawlActive(null), false);

assert.equal(skipReasonText('spa', en), en.crawl.skip.spa);
assert.equal(skipReasonText('новая', uk), uk.crawl.skip.other);
assert.equal(skipReasonText(null, ru), ru.crawl.skip.other);

console.log('crawl: ok');
