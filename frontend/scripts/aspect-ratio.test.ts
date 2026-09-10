import assert from 'node:assert/strict';
import {
  aspectRatioFamily,
  aspectRatioFromSize,
  EXPORT_PRESETS,
  normaliseAspectRatio,
  veoFrameFor,
} from '../src/lib/aspect-ratio';

assert.equal(aspectRatioFromSize(1080, 1920), '9:16');
assert.equal(aspectRatioFromSize(1920, 1080), '16:9');
assert.equal(aspectRatioFromSize(1080, 1440), '3:4');
assert.equal(aspectRatioFromSize(1080, 1350), '4:5');
assert.equal(aspectRatioFromSize(1080, 2340), '6:13');
assert.equal(normaliseAspectRatio('1080x1920'), '9:16');
assert.equal(normaliseAspectRatio('21:9'), '21:9');
assert.equal(normaliseAspectRatio('abc'), null);
assert.equal(veoFrameFor('3:4'), '9:16');
assert.equal(veoFrameFor('4:3'), '16:9');
assert.equal(veoFrameFor('16:9'), '16:9');

// Этап 75 (TODO §III, п.35, автоэкспорт под площадки) — та же обёртка,
// что на бэкенде: aspectRatioFamily === veoFrameFor, только другое имя
// для контекста экспорта.
for (const t of ['9:16', '3:4', '1:1', '4:5']) {
  assert.equal(aspectRatioFamily(t), '9:16');
}
for (const t of ['16:9', '4:3']) {
  assert.equal(aspectRatioFamily(t), '16:9');
}
assert.equal(aspectRatioFamily('7:3'), veoFrameFor('7:3'));

// Пресеты — зеркало backend/src/common/aspect-ratio.ts's
// PLATFORM_EXPORT_PRESETS: та же длина, те же ключи/форматы, чтобы
// экран экспорта не разошёлся молча с тем, что реально принимает сервер.
assert.equal(EXPORT_PRESETS.length, 7);
const byKey = Object.fromEntries(EXPORT_PRESETS.map((p) => [p.key, p.format]));
assert.deepEqual(byKey, {
  tiktok: '9:16',
  youtube: '16:9',
  'youtube-shorts': '9:16',
  'instagram-feed': '4:5',
  'instagram-reels': '9:16',
  square: '1:1',
  classic: '4:3',
});

console.log('aspect-ratio: 20 cases ok');
