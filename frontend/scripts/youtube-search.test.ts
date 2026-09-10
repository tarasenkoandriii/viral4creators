import assert from 'node:assert/strict';
import { formatCount, sortResults } from '../src/lib/youtube-search';
import type { YoutubeSearchResultView } from '../src/types';

const row = (p: Partial<YoutubeSearchResultView>): YoutubeSearchResultView => ({
  videoId: 'v',
  url: 'u',
  title: 't',
  channelTitle: 'c',
  channelId: 'ch',
  publishedAt: '',
  thumbnailUrl: null,
  durationSeconds: null,
  durationLabel: null,
  viewCount: null,
  likeCount: null,
  ...p,
});
const rows = [
  row({
    videoId: 'a',
    title: 'Яблоко',
    channelTitle: 'B',
    viewCount: 10,
    durationSeconds: 60,
  }),
  row({
    videoId: 'b',
    title: 'банан',
    channelTitle: 'a',
    viewCount: null,
    durationSeconds: 30,
  }),
  row({
    videoId: 'c',
    title: 'Вишня',
    channelTitle: 'C',
    viewCount: 500,
    durationSeconds: null,
  }),
];
const ids = (r: YoutubeSearchResultView[]) => r.map((x) => x.videoId).join('');

assert.equal(
  ids(sortResults(rows, null)),
  'abc',
  'null sort keeps relevance order'
);
assert.equal(
  ids(sortResults(rows, { key: 'viewCount', dir: 'desc' })),
  'cab',
  'nulls sink (desc)'
);
assert.equal(
  ids(sortResults(rows, { key: 'viewCount', dir: 'asc' })),
  'acb',
  'nulls sink (asc)'
);
assert.equal(
  ids(sortResults(rows, { key: 'durationSeconds', dir: 'asc' })),
  'bac'
);
assert.equal(
  ids(sortResults(rows, { key: 'title', dir: 'asc' })),
  'bca',
  'case-insensitive ru collation'
);
assert.equal(
  ids(sortResults(rows, { key: 'channelTitle', dir: 'desc' })),
  'cab'
);
assert.equal(ids(rows), 'abc', 'input not mutated');

// Intl.NumberFormat вставляет U+00A0 (неразрывный пробел) между числом и
// суффиксом — типографски правильнее обычного пробела (не даёт числу
// оторваться от единицы при переносе строки), но делает литералы теста
// нечитаемыми, если писать его как невидимый символ; нормализуем перед
// сравнением, а ожидаемые строки ниже — с обычным пробелом.
// eslint-disable-next-line no-irregular-whitespace -- U+00A0 в паттерне намеренный, см. комментарий выше
const norm = (s: string) => s.replace(/ /g, ' ');

assert.equal(formatCount(null), '—');
assert.equal(formatCount(999), '999');
assert.equal(norm(formatCount(12345)), '12,3 тыс.');
assert.equal(norm(formatCount(1_200_000)), '1,2 млн');
assert.equal(norm(formatCount(2_000_000_000)), '2 млрд');

// Этап 56: formatCount принимает локаль вместо жёстко зашитых
// русских суффиксов — Intl.NumberFormat даёт настоящее локальное
// сокращение на каждый из пяти языков интерфейса.
assert.equal(norm(formatCount(12345, 'en')), '12.3K');
assert.equal(norm(formatCount(1_200_000, 'en')), '1.2M');
assert.equal(norm(formatCount(2_000_000_000, 'en')), '2B');
assert.equal(norm(formatCount(12345, 'uk')), '12,3 тис.');
assert.equal(norm(formatCount(1_200_000, 'de')), '1,2 Mio.');
assert.equal(norm(formatCount(1_200_000, 'es')), '1,2 M');

// sortResults тоже принимает локаль (была жёстко 'ru') — на данных без
// диакритики результат не меняется, но параметр должен приниматься и
// не ломать сортировку.
assert.equal(
  ids(sortResults(rows, { key: 'title', dir: 'asc' }, 'en')),
  'bca',
  'locale param accepted, sort unaffected on plain ASCII/Cyrillic input'
);

console.log('youtube-search: 18 cases ok');
