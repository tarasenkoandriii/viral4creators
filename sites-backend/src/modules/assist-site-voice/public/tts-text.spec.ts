import { speakableText, speechPhrases } from './tts-text';

describe('текст для озвучки (Э5)', () => {
  it('без меток источников, markdown и адресов; ссылки — подписью', () => {
    expect(
      speakableText(
        '## Доставка\n**Новою поштою** — 1–2 дні [S1]. Деталі: [умови доставки](https://shop.example.com/delivery) [S1, S2]\n- оплата при отриманні\n- `картка`\nhttps://shop.example.com/x',
        1200,
      ),
    ).toBe(
      'Доставка Новою поштою — 1–2 дні. Деталі: умови доставки оплата при отриманні картка',
    );
  });

  it('длинный ответ — по границе предложения, не длиннее потолка', () => {
    const t = 'Перше речення тут. '.repeat(100);
    const out = speakableText(t, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('.')).toBe(true);
    expect(
      speakableText('без крапок '.repeat(40), 50).length,
    ).toBeLessThanOrEqual(50);
  });
});

describe('phrase playback', () => {
  it('separates the first sentence and preserves decimals, order and all words', () => {
    const text =
      'Raffle uses TON Testnet. The fee is 10.5 percent. Test coins only.';
    const parts = speechPhrases(text);
    expect(parts[0]).toBe('Raffle uses TON Testnet.');
    expect(parts.join(' ')).toBe(text);
    expect(parts[1]).toContain('10.5');
  });
  it('never cuts a grouped monetary amount at a word boundary', () => {
    const prefix = 'a'.repeat(177);
    const parts = speechPhrases(prefix + ' 1 000 TON.');
    expect(parts[0]).toContain('1 000');
    expect(parts.join(' ')).toBe(prefix + ' 1 000 TON.');
  });
  it('bounds a long first sentence without losing content or creating excessive calls', () => {
    const text = 'Довга фраза без крапки '
      .repeat(70)
      .trim()
      .slice(0, 1200)
      .trim();
    const parts = speechPhrases(text);
    expect(parts[0].length).toBeLessThanOrEqual(180);
    expect(parts.every((p) => p.length <= 240)).toBe(true);
    expect(parts.length).toBeLessThanOrEqual(16);
    expect(parts.join(' ')).toBe(text);
    expect(speechPhrases('')).toEqual([]);
  });
});
