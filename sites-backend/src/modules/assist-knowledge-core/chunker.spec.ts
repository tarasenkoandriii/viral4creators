import type { ExtractedBlock } from '../site-crawl/types';
import {
  chunkBlocks,
  chunkFaq,
  estimateTokens,
  HEADING_SEPARATOR,
} from './chunker';
import { contentHash } from './hashing';

const OPTS = { minTokens: 300, maxTokens: 500, overlapTokens: 50, lang: 'uk' };

function words(seed: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
}

describe('чанкер (§4.3)', () => {
  it('оценка токенов: кириллица «дороже» латиницы, пусто — 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('абвгд')).toBe(2);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('длинный раздел режется на фрагменты ≤ max с перекрытием ≈ 50 токенов', () => {
    const blocks: ExtractedBlock[] = [
      { t: 'h', level: 1, text: 'Доставка', path: [] },
      ...Array.from({ length: 12 }, (_, i) => ({
        t: 'p' as const,
        text: words(`w${i}x`, 60),
        path: ['Доставка'],
      })),
    ];
    const chunks = chunkBlocks(blocks, OPTS);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.tokens).toBeLessThanOrEqual(
        OPTS.maxTokens + OPTS.overlapTokens + 20,
      );
      expect(c.headingPath).toBe('Доставка');
      expect(c.ugc).toBe(false);
      expect(c.lang).toBe('uk');
      expect(c.contentHash).toBe(contentHash(c.text));
    }
    // Перекрытие: начало второго фрагмента — хвост первого.
    const tail = chunks[0].text.split(/\s+/).slice(-5).join(' ');
    expect(
      chunks[1].text.startsWith(tail) || chunks[1].text.includes(tail),
    ).toBe(true);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('заголовки дают путь «Доставка › По Україні»; мелкие разделы склеиваются', () => {
    const blocks: ExtractedBlock[] = [
      { t: 'h', level: 1, text: 'Доставка', path: [] },
      { t: 'h', level: 2, text: 'По Україні', path: ['Доставка'] },
      {
        t: 'p',
        text: 'Новою поштою 1–3 дні.',
        path: ['Доставка', 'По Україні'],
      },
      { t: 'h', level: 2, text: 'По Києву', path: ['Доставка'] },
      { t: 'p', text: 'Кур’єром за 2 години.', path: ['Доставка', 'По Києву'] },
    ];
    const chunks = chunkBlocks(blocks, OPTS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toBe('Доставка');
    expect(chunks[0].text).toContain('По Україні');
    expect(chunks[0].text).toContain('Кур’єром');
    const deep = chunkBlocks(blocks.slice(0, 3), OPTS);
    expect(deep[0].headingPath).toBe(
      ['Доставка', 'По Україні'].join(HEADING_SEPARATOR),
    );
  });

  it('новый раздел закрывает фрагмент, если в нём уже ≥ min токенов', () => {
    const blocks: ExtractedBlock[] = [
      { t: 'h', level: 1, text: 'Оплата', path: [] },
      { t: 'p', text: words('pay', 160), path: ['Оплата'] },
      { t: 'h', level: 1, text: 'Повернення', path: [] },
      { t: 'p', text: words('ret', 160), path: ['Повернення'] },
    ];
    const chunks = chunkBlocks(blocks, OPTS);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].headingPath).toBe('Оплата');
    expect(chunks[1].headingPath).toBe('Повернення');
    expect(chunks[1].text).not.toContain('pay');
  });

  it('строка таблицы не режется, FAQ — пара целиком отдельным фрагментом', () => {
    const row = `Модель: ABC-1234; Ціна: 2 400 грн; ${words('spec', 300)}`;
    const blocks: ExtractedBlock[] = [
      { t: 'tr', text: row, path: ['Ціни'] },
      { t: 'faq', text: 'Чи є гарантія? Так, 12 місяців.', path: ['FAQ'] },
      { t: 'p', text: 'Після FAQ.', path: ['FAQ'] },
    ];
    const chunks = chunkBlocks(blocks, OPTS);
    expect(chunks.some((c) => c.text === row)).toBe(true);
    const faq = chunks.find((c) => c.text.includes('гарантія'))!;
    expect(faq.text).toBe('Чи є гарантія? Так, 12 місяців.');
    expect(
      chunks.find((c) => c.text.includes('Після FAQ'))!.text,
    ).not.toContain('гарантія');
  });

  it('UGC — отдельными фрагментами с ugc=true, не смешан с текстом владельца', () => {
    const blocks: ExtractedBlock[] = [
      { t: 'p', text: 'Опис товару від магазину.', path: ['Товар'] },
      {
        t: 'p',
        text: 'Відгук: доставка — 1 день, а не 3.',
        path: ['Відгуки'],
        ugc: true,
      },
      { t: 'p', text: 'Відгук: все добре.', path: ['Відгуки'], ugc: true },
      { t: 'p', text: 'Ще текст магазину.', path: ['Товар'] },
    ];
    const chunks = chunkBlocks(blocks, OPTS);
    const owner = chunks.filter((c) => !c.ugc);
    const ugc = chunks.filter((c) => c.ugc);
    expect(owner).toHaveLength(1);
    expect(owner[0].text).toContain('Ще текст магазину');
    expect(owner[0].text).not.toContain('Відгук');
    expect(ugc).toHaveLength(1);
    expect(ugc[0].text).toContain('1 день');
    expect(ugc[0].text).toContain('все добре');
  });

  it('очень длинный абзац без точек режется по словам', () => {
    const chunks = chunkBlocks(
      [{ t: 'p', text: words('x', 2000), path: [] }],
      OPTS,
    );
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(600);
  });

  it('пустые блоки и пустой вход — без фрагментов; результат детерминирован', () => {
    expect(chunkBlocks([], OPTS)).toEqual([]);
    expect(chunkBlocks([{ t: 'p', text: '   ', path: [] }], OPTS)).toEqual([]);
    const b: ExtractedBlock[] = [
      { t: 'p', text: words('d', 900), path: ['A'] },
    ];
    expect(chunkBlocks(b, OPTS)).toEqual(chunkBlocks(b, OPTS));
  });

  it('chunkFaq: вопрос и ответ одним фрагментом', () => {
    const c = chunkFaq(' Як повернути? ', 'Протягом 14 днів.', 'uk');
    expect(c.text).toBe('Як повернути?\nПротягом 14 днів.');
    expect(c.ugc).toBe(false);
    expect(c.headingPath).toBeNull();
    expect(c.lang).toBe('uk');
  });
});
