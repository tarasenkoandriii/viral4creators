/**
 * Первый тест лендинга. До него `landing/` проверялся только `tsc`,
 * `next lint` и сборкой — то есть ничего из поведения не проверялось
 * вовсе (найдено при приёмке страницы поздравлений, раздел 3 плана
 * docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md).
 *
 * Схема та же, что у фронтенда: `node:assert` + `tsx`, без jest.
 * Заводить сюда полноценный тест-раннер ради чистых функций было бы
 * дороже пользы; когда понадобится рендер компонентов — будет повод.
 */
import assert from 'node:assert/strict';
import { headingOf } from '../src/lib/shared-video-heading';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';
import type { PublicSharedVideoPage } from '../src/lib/shared-video-api';

const ru = getDictionary('ru');

const page = (over: Partial<PublicSharedVideoPage>) =>
  ({
    id: 'p1',
    title: 'BIRTHDAY',
    projectType: 'GREETING_VIDEO',
    occasion: 'BIRTHDAY',
    ...over,
  }) as PublicSharedVideoPage;

// Главное: код повода получателю не показывается.
assert.equal(headingOf(page({}), ru), ru.sharedVideo.occasion.BIRTHDAY);
assert.notEqual(headingOf(page({}), ru), 'BIRTHDAY');

// Заголовок автора не трогаем — даже если он похож на код.
assert.equal(
  headingOf(page({ title: 'С днём рождения, Марина!' }), ru),
  'С днём рождения, Марина!',
);
assert.equal(
  headingOf(page({ title: 'BIRTHDAY', occasion: 'WEDDING' }), ru),
  'BIRTHDAY',
);

// Товарный ролик подмену не проходит ни при каких данных.
assert.equal(
  headingOf(page({ projectType: null, title: 'Термокружка' }), ru),
  'Термокружка',
);

// …включая комбинацию, которой сегодня быть не может: у товарного
// снимка `occasion` всегда NULL (его заполняет только ветка
// поздравления в `snapshotFromSession`). Проверка по `projectType`
// поэтому и держится отдельно от проверки по `occasion` — чтобы, если
// повод когда-нибудь появится и у товарных роликов, название товара не
// начало молча подменяться названием повода. Без этого случая ту
// проверку можно было бы удалить, и ни один тест бы не покраснел.
assert.equal(
  headingOf(page({ projectType: null, title: 'BIRTHDAY' }), ru),
  'BIRTHDAY',
);

// Повода может не быть — тогда показываем что есть, а не пустоту.
assert.equal(headingOf(page({ occasion: null }), ru), 'BIRTHDAY');

// Подмена работает во всех локалях, а не только в русской: страница
// показывается на языке ПУБЛИКАЦИИ, и получатель может быть любым.
for (const locale of locales) {
  const dict = getDictionary(locale);
  const heading = headingOf(page({}), dict);
  assert.equal(heading, dict.sharedVideo.occasion.BIRTHDAY, locale);
  assert.notEqual(heading, 'BIRTHDAY', locale);
}

// Каждый из 24 поводов имеет читаемое название в каждой локали —
// иначе подмена молча вернула бы код обратно.
for (const locale of locales) {
  const dict = getDictionary(locale);
  for (const code of Object.keys(dict.sharedVideo.occasion)) {
    const heading = headingOf(
      page({ title: code, occasion: code as PublicSharedVideoPage['occasion'] }),
      dict,
    );
    assert.notEqual(heading, code, `${locale}/${code}`);
  }
}

console.log(
  `shared-video-heading: ok (5 локалей × ${
    Object.keys(ru.sharedVideo.occasion).length
  } поводов)`,
);
