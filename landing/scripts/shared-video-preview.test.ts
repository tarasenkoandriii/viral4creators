/**
 * Выбор картинки превью для страницы ролика. Проверяется здесь, а не
 * глазами на странице, по той же причине, что и заголовок: ошибку в
 * этом порядке видно только в чужом мессенджере, куда переслали ссылку.
 */
import assert from 'node:assert/strict';
import { previewImageOf } from '../src/lib/shared-video-preview';
import { locales } from '../src/lib/i18n';

const ORIGIN = 'https://viral4creators.app';

const page = (over: Record<string, unknown> = {}) =>
  ({
    posterUrl: null,
    productImageUrl: null,
    projectType: 'GREETING_VIDEO',
    ...over,
  }) as Parameters<typeof previewImageOf>[0];

// 1. Свой кадр важнее всего остального.
assert.deepEqual(
  previewImageOf(
    page({ posterUrl: 'https://blob/p.jpg', productImageUrl: 'https://blob/t.jpg' }),
    'ru',
    ORIGIN,
  ),
  { url: 'https://blob/p.jpg', own: true },
);

// 2. Фото товара — следующим: у товарных роликов оно было и до постера,
//    уронить его было бы регрессом.
assert.deepEqual(
  previewImageOf(
    page({ projectType: null, productImageUrl: 'https://blob/t.jpg' }),
    'ru',
    ORIGIN,
  ),
  { url: 'https://blob/t.jpg', own: true },
);

// 3. Ничего своего нет — запасная обложка, и она помечена как НЕ своя:
//    в `poster` у <video> такую ставить нельзя.
const fallback = previewImageOf(page(), 'ru', ORIGIN);
assert.equal(fallback.own, false);
assert.equal(fallback.url, `${ORIGIN}/og/greetings-ru.jpg`);

// Запасная обложка — по типу проекта: поздравлению обложка поздравлений,
// товарному ролику — главная.
assert.equal(
  previewImageOf(page({ projectType: null }), 'ru', ORIGIN).url,
  `${ORIGIN}/og/main-ru.jpg`,
);

// …и по локали страницы, а не по одной русской: страница
// показывается на языке публикации.
for (const locale of locales) {
  assert.equal(
    previewImageOf(page(), locale, ORIGIN).url,
    `${ORIGIN}/og/greetings-${locale}.jpg`,
    locale,
  );
}

// Картинка есть ВСЕГДА — именно этого не было до постера: у
// поздравления `og:image` отсутствовал вовсе.
for (const projectType of ['GREETING_VIDEO', null]) {
  const got = previewImageOf(page({ projectType }), 'en', ORIGIN);
  assert.ok(got.url.startsWith('https://'), String(projectType));
}

console.log('shared-video-preview: ok (порядок из трёх источников, 5 локалей)');
