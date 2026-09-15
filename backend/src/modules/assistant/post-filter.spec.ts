import { containsForbiddenPromise, maskSensitiveEcho } from './post-filter';

describe('maskSensitiveEcho (ТЗ §5.5)', () => {
  it('маскирует e-mail', () => {
    expect(maskSensitiveEcho('Пишите на ivan@example.com, ок?')).toBe(
      'Пишите на [e-mail скрыт], ок?',
    );
  });

  it('маскирует похожий на телефон ряд цифр', () => {
    expect(maskSensitiveEcho('Мой номер +380 67 123 45 67')).toContain(
      '[телефон скрыт]',
    );
  });

  it('маскирует похожий на ключ токен', () => {
    expect(maskSensitiveEcho('вот ключ AIzaSyD1234567890abcdef')).toBe(
      'вот ключ [ключ скрыт]',
    );
  });

  it('не трогает обычные числа', () => {
    expect(maskSensitiveEcho('ролик длиной 25 секунд, до 100 МБ')).toBe(
      'ролик длиной 25 секунд, до 100 МБ',
    );
  });
});

describe('containsForbiddenPromise (ТЗ §5.5)', () => {
  it('находит запрещённые фразы независимо от регистра', () => {
    expect(containsForbiddenPromise('У нас Безлимит на все тарифы')).toBe(true);
    expect(containsForbiddenPromise('unlimited generations for everyone')).toBe(
      true,
    );
  });

  it('обычный ответ — не флагуется', () => {
    expect(
      containsForbiddenPromise('Standard даёт дубляж и библиотеку разборов.'),
    ).toBe(false);
  });
});
