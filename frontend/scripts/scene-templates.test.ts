import assert from 'node:assert/strict';
import {
  canChoose,
  initialSourceMode,
  templateCards,
  type SceneTemplateRow,
} from '../src/lib/scene-templates';

const row = (over: Partial<SceneTemplateRow> = {}): SceneTemplateRow => ({
  id: 'unboxing',
  frame: '9:16',
  presenter: 'hands',
  beats: 3,
  speaksOnCamera: false,
  ...over,
});

const dict: Record<string, string> = {
  unboxingLabel: 'Распаковка',
  unboxingHint: 'Посылка, вскрытие, товар в руках.',
  testimonialLabel: 'Отзыв',
  testimonialHint: 'Съёмка с рук телефоном.',
};

// Подписи берутся из словаря, а не с сервера: на сервере тексты
// английские и уходят в модель.
const cards = templateCards([row()], null, dict);
assert.equal(cards.length, 1);
assert.equal(cards[0].label, 'Распаковка');
assert.equal(cards[0].beats, 3);

// Приём, которого экран не знает по имени, пропускается МОЛЧА:
// бэкенд может уехать вперёд на деплой, и сырой идентификатор в списке
// приёмов — это не подпись, а протечка.
assert.deepEqual(templateCards([row({ id: 'нечто' })], null, dict), []);
// Подпись есть, подсказки нет — тоже пропуск: половина карточки хуже,
// чем её отсутствие.
assert.deepEqual(
  templateCards([row()], null, { unboxingLabel: 'Распаковка' }),
  []
);

// Выбранный отмечается, и только он.
const two = templateCards(
  [row(), row({ id: 'testimonial', presenter: 'face' })],
  'testimonial',
  dict
);
assert.deepEqual(
  two.map((c) => c.chosen),
  [false, true]
);

// Оговорка про молчание — только там, где человек в кадре ЕСТЬ.
assert.equal(
  templateCards([row({ id: 'testimonial', presenter: 'face' })], null, dict)[0]
    .silent,
  true
);
assert.equal(
  templateCards(
    [row({ id: 'testimonial', presenter: 'face', speaksOnCamera: true })],
    null,
    dict
  )[0].silent,
  false
);
// Где лица нет, говорить некому и без нас — объяснять нечего.
assert.equal(templateCards([row()], null, dict)[0].silent, false);

// Разобранный референс закрывает выбор, и экран говорит это ДО нажатия.
assert.equal(canChoose({ analysed: false }), true);
assert.equal(canChoose({ analysed: true }), false);
assert.equal(canChoose(null), false);

// Первой открывается вкладка уже сделанного выбора: по степперу
// человек может вернуться на «Видео», и вкладка файла поверх его приёма
// прятала бы его собственный ответ на тот же вопрос (А-4).
const mode = (over: Partial<Parameters<typeof initialSourceMode>[0]> = {}) =>
  initialSourceMode({
    templateChosen: false,
    templatesOffered: true,
    libraryOffered: true,
    seeded: false,
    ...over,
  });
assert.equal(mode({ templateChosen: true }), 'template');
// Выбранный приём сильнее любой подсказки.
assert.equal(mode({ templateChosen: true, seeded: true }), 'template');
// Но не там, где вкладки приёмов нет вовсе.
assert.equal(
  mode({ templateChosen: true, templatesOffered: false, seeded: true }),
  'library'
);
// Прежнее поведение без приёма — как было.
assert.equal(mode({ seeded: true }), 'library');
assert.equal(mode({ seeded: true, libraryOffered: false }), 'search');
assert.equal(mode(), 'upload');
assert.equal(mode({ libraryOffered: false }), 'upload');

console.log('scene-templates: ok');
