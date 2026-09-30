/**
 * Копия подписей (`greeting-voice-intent-labels.ts`) сверяется со
 * словарями фронтенда: помощник обязан называть тон и повод ТЕМИ ЖЕ
 * словами, что кнопки брифа. Разошлось — падает здесь, а не у человека,
 * который слышит «весёлый», а видит «С юмором».
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  BRIEF_FIELD_LABELS,
  HEDRA_PREMIUM_ONLY,
  OCCASION_LABELS,
  PRESENTER_HEDRA_LABEL,
  SESSION_SCREEN_LABELS,
  TONE_LABELS,
  TONE_UNAVAILABLE,
} from './greeting-voice-intent-labels';
import { SUPPORTED_LOCALES } from './locale';
import { GREETING_OCCASIONS, GREETING_TONES } from './types/greeting.types';

const DICT_DIR = path.resolve(__dirname, '../../../frontend/src/dictionaries');

function wizard(locale: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(DICT_DIR, `${locale}.json`), 'utf8');
  return (JSON.parse(raw) as Record<string, Record<string, unknown>>)
    .greetingVideoWizard;
}

describe('подписи карточки голоса = словари фронтенда', () => {
  it('словари на месте — иначе сверка ослепла бы молча', () => {
    expect(fs.existsSync(DICT_DIR)).toBe(true);
  });

  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale}: поводы, тоны, ведущий, отказы`, () => {
      const w = wizard(locale);
      expect(OCCASION_LABELS[locale]).toEqual(w.occasion);
      expect(TONE_LABELS[locale]).toEqual(w.tone);
      expect(PRESENTER_HEDRA_LABEL[locale]).toBe(w.providerHedra);
      expect(TONE_UNAVAILABLE[locale]).toBe(w.toneUnavailable);
      expect(HEDRA_PREMIUM_ONLY[locale]).toBe(w.providerHedraPremiumOnly);
      // Подписи полей — из них выводятся названия в карточке и переспросе.
      for (const [key, label] of Object.entries(BRIEF_FIELD_LABELS[locale])) {
        expect({ key, label }).toEqual({ key, label: w[key] });
      }
      expect(Object.keys(BRIEF_FIELD_LABELS[locale])).toHaveLength(11);
      // K5: подписи и причины карточек сессии.
      for (const [key, label] of Object.entries(
        SESSION_SCREEN_LABELS[locale],
      )) {
        expect({ key, label }).toEqual({ key, label: w[key] });
      }
      expect(Object.keys(SESSION_SCREEN_LABELS[locale])).toEqual(
        Object.keys(SESSION_SCREEN_LABELS.ru),
      );
    });
  }

  it('покрыты все коды', () => {
    for (const l of SUPPORTED_LOCALES) {
      expect(Object.keys(OCCASION_LABELS[l]).sort()).toEqual(
        [...GREETING_OCCASIONS].sort(),
      );
      expect(Object.keys(TONE_LABELS[l]).sort()).toEqual(
        [...GREETING_TONES].sort(),
      );
    }
  });
});
