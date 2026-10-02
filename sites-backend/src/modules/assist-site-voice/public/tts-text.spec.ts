import { speakableText } from './tts-text';

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
