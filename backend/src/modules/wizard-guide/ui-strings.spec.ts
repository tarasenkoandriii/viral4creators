/**
 * Паритет снимка подписей с источником — по образцу
 * `assistant-knowledge.spec.ts`.
 *
 * Снимок в `ui-strings.generated.ts` собирается из
 * `frontend/src/dictionaries`, которых у собранного бэкенда нет. Тест
 * пересобирает его и сверяет с закоммиченным: переименовали кнопку —
 * красный тест в CI, а не молча исчезнувшая запись опыта у людей.
 */

import { buildUiStrings } from '../../../scripts/build-wizard-ui-strings';
import { WIZARD_UI_STRINGS } from './ui-strings.generated';
import { FIRST_EXPERIENCE } from './first-experience';
import { uiKeysOf, isKnownUiKey } from './ui-keys';
import { SUPPORTED_LOCALES } from '../../common/locale';

describe('снимок подписей интерфейса (§6.7)', () => {
  it('совпадает с тем, что собирается из словарей', () => {
    expect(WIZARD_UI_STRINGS).toEqual(buildUiStrings());
  });

  it('есть на всех пяти локалях', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(
        Object.keys(WIZARD_UI_STRINGS[locale] ?? {}).length,
      ).toBeGreaterThan(0);
    }
  });

  it('ключи первой записи корпуса существуют', () => {
    // §6.6 — приёмочный пример всего §6. Ключ, которого нет в словаре,
    // выбросил бы её из подсказки молча, и приёмка «ситуация появляется
    // на шаге записи» провалилась бы без внятной причины.
    const keys = uiKeysOf(
      [
        FIRST_EXPERIENCE.text.symptom,
        FIRST_EXPERIENCE.text.cause,
        FIRST_EXPERIENCE.text.advice,
      ].join('\n'),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(isKnownUiKey(key)).toBe(true);
  });
});
