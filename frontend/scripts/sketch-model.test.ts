/**
 * Чистые правила окна скетча (doc/AI-SKETCH-SPEC.md §3.2, §8.2).
 * Запускается как `npx tsx scripts/sketch-model.test.ts`, вместе с
 * остальными — `npm test`.
 *
 * Проверяется то, что ломается тихо: «убрать логотипы» у персонажа
 * (обещание, которого модель не даёт, §4, п. 3), остаток квоты
 * (счётчик, который врёт ровно на одну оплаченную попытку) и выбор
 * режима без фото — единственный случай, когда «по фото» выбрать нельзя.
 */

import assert from 'node:assert/strict';
import {
  availableModes,
  canGenerate,
  DEFAULT_SKETCH_STYLE,
  defaultMode,
  defaultSketchOptions,
  isAnonymizeForced,
  quotaLeft,
  quotaLine,
  quotaState,
  showsRealisticNote,
  sketchSubject,
  SKETCH_STYLES,
  supportsRemoveLogos,
} from '../src/features/sketch/sketch-model';
import type { SketchQuota } from '../src/types/sketch';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('sketch-model (ИИ-скетч, §3.2)');

it('sketchSubject — шесть слотов сводятся к трём видам содержимого', () => {
  assert.equal(sketchSubject('session-character'), 'character');
  assert.equal(sketchSubject('brand-character'), 'character');
  assert.equal(sketchSubject('session-scene'), 'scene');
  assert.equal(sketchSubject('brand-scene'), 'scene');
  assert.equal(sketchSubject('session-product'), 'product');
  assert.equal(sketchSubject('project-item'), 'product');
});

it('стили — четыре из §5.3, «Карандаш» первым и по умолчанию', () => {
  assert.deepEqual(SKETCH_STYLES, ['pencil', 'lineart', 'flat', 'watercolor']);
  assert.equal(DEFAULT_SKETCH_STYLE, 'pencil');
  assert.equal(SKETCH_STYLES[0], DEFAULT_SKETCH_STYLE);
});

it('«убрать логотипы» — только у товаров и сцен, не у персонажей', () => {
  assert.equal(supportsRemoveLogos('session-product'), true);
  assert.equal(supportsRemoveLogos('project-item'), true);
  assert.equal(supportsRemoveLogos('session-scene'), true);
  assert.equal(supportsRemoveLogos('brand-scene'), true);
  assert.equal(supportsRemoveLogos('session-character'), false);
  assert.equal(supportsRemoveLogos('brand-character'), false);
});

it('умолчания опций: у сцен логотипы убираются сразу, у товаров — нет', () => {
  assert.deepEqual(defaultSketchOptions('session-scene'), {
    removeLogos: true,
    keepColors: true,
    sketchRendering: 'realistic',
  });
  assert.deepEqual(defaultSketchOptions('session-product'), {
    removeLogos: false,
    keepColors: true,
    sketchRendering: 'realistic',
  });
  // У персонажа опции нет вовсе — значение остаётся выключенным, чтобы
  // на сервер не уходил флаг, которого для этого слота не существует.
  assert.equal(defaultSketchOptions('brand-character').removeLogos, false);
});

it('обезличивание — только у персонажей и только в режиме «по фото»', () => {
  assert.equal(isAnonymizeForced('session-character', 'from-image'), true);
  assert.equal(isAnonymizeForced('brand-character', 'from-image'), true);
  // «По описанию» лицо и так вымышленное — переключатель не нужен.
  assert.equal(isAnonymizeForced('session-character', 'from-text'), false);
  assert.equal(isAnonymizeForced('session-product', 'from-image'), false);
});

it('без фото остаётся один режим — «по описанию» (аудит А-10)', () => {
  assert.deepEqual(availableModes(false), ['from-text']);
  assert.equal(defaultMode(false), 'from-text');
  assert.deepEqual(availableModes(true), ['from-image', 'from-text']);
  assert.equal(defaultMode(true), 'from-image');
});

it('«Сгенерировать» — пустое описание в режиме «по описанию» не пускает', () => {
  assert.equal(canGenerate('from-text', ''), false);
  assert.equal(canGenerate('from-text', '   \n '), false);
  assert.equal(canGenerate('from-text', 'рыжий кот'), true);
  // В режиме «по фото» описание не участвует вовсе.
  assert.equal(canGenerate('from-image', ''), true);
  // Нижняя граница совпадает с DTO (`@Length(3, 2000)`): форма не
  // должна пускать в платный вызов то, что сервер отвергнет валидацией
  // (аудит A-15).
  assert.equal(canGenerate('from-text', 'ко'), false);
  assert.equal(canGenerate('from-text', ' ко '), false);
  assert.equal(canGenerate('from-text', 'кот'), true);
  assert.equal(canGenerate('from-text', 'x'.repeat(2001)), false);
});

const q = (
  dayUsed: number,
  dayLimit: number,
  monthUsed: number,
  monthLimit: number
): SketchQuota => ({ dayUsed, dayLimit, monthUsed, monthLimit });

it('квота — показывается остаток, а не израсходованное', () => {
  assert.deepEqual(quotaLeft(q(1, 3, 5, 20)), { day: 2, month: 15 });
});

it('квота — перерасход не уходит в минус (сервер мог списать больше)', () => {
  assert.deepEqual(quotaLeft(q(5, 3, 25, 20)), { day: 0, month: 0 });
});

it('quotaLine — обе подстановки шаблона словаря', () => {
  assert.equal(
    quotaLine(
      q(1, 3, 3, 20),
      'Скетчей: осталось {{day}} сегодня · {{month}} в этом месяце'
    ),
    'Скетчей: осталось 2 сегодня · 17 в этом месяце'
  );
});

it('месячный лимит важнее суточного: у них разный текст и разный CTA', () => {
  assert.equal(quotaState(q(0, 3, 0, 20)), 'ok');
  assert.equal(quotaState(q(3, 3, 5, 20)), 'day-over');
  assert.equal(quotaState(q(3, 3, 20, 20)), 'month-over');
  // Месячный кончился раньше суточного — всё равно месячный.
  assert.equal(quotaState(q(0, 3, 20, 20)), 'month-over');
  // Квоты нет (ответ 429 без тела) — не врём про исчерпанный месяц.
  assert.equal(quotaState(null), 'ok');
});

it('подсказка про «Реалистично» — только при реалистичном рендере', () => {
  assert.equal(showsRealisticNote({ sketchRendering: 'realistic' }), true);
  assert.equal(showsRealisticNote({ sketchRendering: 'stylized' }), false);
  // Умолчание сервера — «реалистично», поэтому и подсказка показывается.
  assert.equal(showsRealisticNote({}), true);
});

console.log(`sketch-model: ${passed} проверок пройдено`);
