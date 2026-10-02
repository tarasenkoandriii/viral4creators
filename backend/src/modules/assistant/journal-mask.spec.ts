/**
 * Маскирование журнала консультанта (Ш0.7, риск В-4). Векторы — те же,
 * что у `maskForJournal` платформы
 * (`sites-backend/src/modules/assist-site-chat/answer-checks.spec.ts`):
 * копия обязана вести себя так же, как оригинал.
 */

import { luhnValid, maskForJournal } from './journal-mask';

describe('maskForJournal (копия платформенного правила)', () => {
  it('карта — по Луну (не любое длинное число), IBAN, телефон, e-mail', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(maskForJournal('Карта 4111-1111-1111-1111')).toBe(
      'Карта [номер карты скрыт]',
    );
    expect(maskForJournal('IBAN UA213223130000026007233566001')).toBe(
      'IBAN [счёт скрыт]',
    );
    expect(maskForJournal('+380 (67) 123-45-67 та a.b@c.ua')).toBe(
      '[телефон скрыт] та [e-mail скрыт]',
    );
    expect(maskForJournal('Ціна 1299 грн за 2 дні')).toBe(
      'Ціна 1299 грн за 2 дні',
    );
  });

  it('ключ API в вопросе тоже скрыт', () => {
    expect(maskForJournal('мой ключ sk-abcdefghijklmnop')).toBe(
      'мой ключ [ключ скрыт]',
    );
  });
});
