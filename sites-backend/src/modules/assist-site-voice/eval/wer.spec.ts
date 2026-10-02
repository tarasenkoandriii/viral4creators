/**
 * Приёмка Э5 п.3 — инструмент WER и набор. Сам порог на живых записях
 * проверяет `npm run eval:voice` у владельца (записи дикторов и ключ
 * Soniox; В-31) — здесь детерминированно: формула, нормализация, набор из
 * 30 фраз и решение «прошёл/нет» на смоделированных распознаваниях.
 */
import { VOICE_EVAL_SET_UK } from './voice-eval-set';
import {
  VOICE_EVAL_SIZE,
  VOICE_WER_THRESHOLD,
  corpusWer,
  normalizeWords,
  wordEdits,
} from './wer';

describe('WER голоса (Э5 п.3)', () => {
  it('нормализация: регистр, пунктуация, апостроф, ё, дефис', () => {
    expect(normalizeWords('М’ЯКОГО дивана, будь-ласка!')).toEqual([
      "м'якого",
      'дивана',
      'будь',
      'ласка',
    ]);
    expect(normalizeWords('Ещё  раз… «так»')).toEqual(['еще', 'раз', 'так']);
    expect(normalizeWords('ціна 2 000 грн.')).toEqual([
      'ціна',
      '2',
      '000',
      'грн',
    ]);
  });

  it('правки по словам: замена, вставка, удаление', () => {
    expect(wordEdits(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
    expect(wordEdits(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1);
    expect(wordEdits(['a', 'b', 'c'], ['a', 'c'])).toBe(1);
    expect(wordEdits(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(2);
    expect(wordEdits(['a'], [])).toBe(1);
  });

  it('WER по набору — сумма правок / сумма слов; пустое распознавание — все слова удалены', () => {
    const r = corpusWer([
      {
        id: '1',
        reference: 'Скільки коштує доставка?',
        hypothesis: 'скільки коштує доставка',
      },
      {
        id: '2',
        reference: 'Яка гарантія на чайник?',
        hypothesis: 'яка гарантія на чайнік',
      },
      { id: '3', reference: 'Покличте оператора', hypothesis: null },
    ]);
    expect(r.words).toBe(9);
    expect(r.edits).toBe(3);
    expect(r.wer).toBeCloseTo(3 / 9);
  });

  it('набор приёмки: 30 разных украинских фраз, уникальные id', () => {
    expect(VOICE_EVAL_SET_UK).toHaveLength(VOICE_EVAL_SIZE);
    expect(new Set(VOICE_EVAL_SET_UK.map((p) => p.id)).size).toBe(30);
    expect(new Set(VOICE_EVAL_SET_UK.map((p) => p.text)).size).toBe(30);
    for (const p of VOICE_EVAL_SET_UK)
      expect(normalizeWords(p.text).length).toBeGreaterThanOrEqual(3);
  });

  it('решение порога: ≤ 15% — прошёл, больше — нет (смоделированные распознавания)', () => {
    const words = VOICE_EVAL_SET_UK.reduce(
      (n, p) => n + normalizeWords(p.text).length,
      0,
    );
    // Ошибка в одном слове у каждой k-й фразы — до порога и сверх.
    const run = (every: number) =>
      corpusWer(
        VOICE_EVAL_SET_UK.map((p, i) => ({
          id: p.id,
          reference: p.text,
          hypothesis: i % every === 0 ? p.text.replace(/^\S+/, 'шум') : p.text,
        })),
      );
    const good = run(3);
    expect(good.edits).toBe(10);
    expect(good.wer).toBeCloseTo(10 / words);
    expect(good.wer <= VOICE_WER_THRESHOLD).toBe(true);
    const bad = corpusWer(
      VOICE_EVAL_SET_UK.map((p) => ({
        id: p.id,
        reference: p.text,
        hypothesis: p.text.split(' ').slice(1).join(' '),
      })),
    );
    expect(bad.wer > VOICE_WER_THRESHOLD).toBe(true);
  });
});
