import {
  containsAnyPhrase,
  DEFAULT_MASK_LABELS,
  maskSensitiveEcho,
} from './post-filter';

describe('maskSensitiveEcho (ядро)', () => {
  it('маскирует e-mail, ключ и телефон подписями по умолчанию', () => {
    expect(
      maskSensitiveEcho(
        'a@b.io, AIzaSyD1234567890abcdef, sk-ABCDEFGHIJKL, +380 67 123 45 67',
      ),
    ).toBe(
      `${DEFAULT_MASK_LABELS.email}, ${DEFAULT_MASK_LABELS.token}, ${DEFAULT_MASK_LABELS.token}, ${DEFAULT_MASK_LABELS.phone}`,
    );
  });

  it('ключ с длинным рядом цифр целиком становится ключом, а не «телефоном» с видимым префиксом', () => {
    expect(maskSensitiveEcho('AIzaSy12345678901234')).toBe('[ключ скрыт]');
  });

  it('обычные числа не трогает', () => {
    expect(maskSensitiveEcho('25 секунд, 100 МБ, 2026 год')).toBe(
      '25 секунд, 100 МБ, 2026 год',
    );
  });

  it('свои подписи — параметром', () => {
    expect(
      maskSensitiveEcho('x@y.com и 1234567890', {
        email: '<email>',
        phone: '<phone>',
        token: '<key>',
      }),
    ).toBe('<email> и <phone>');
  });

  it('телефон с кодом в скобках и пробелом: «(067) 123-45-67»', () => {
    const phone = DEFAULT_MASK_LABELS.phone;
    expect(maskSensitiveEcho('звоните (067) 123-45-67!')).toBe(
      `звоните ${phone}!`,
    );
    expect(maskSensitiveEcho('(044)1234567')).toBe(phone);
    expect(maskSensitiveEcho('+38 (067) 123-45-67')).toBe(phone);
    expect(maskSensitiveEcho('8 (067) 123 45 67, вечером')).toBe(
      `${phone}, вечером`,
    );
    expect(maskSensitiveEcho('+380 (67) 123-45-67')).toBe(phone);
  });

  it('даты — не телефоны: ISO, с точками, с дефисами, со временем', () => {
    for (const text of [
      'оплата до 2026-10-03',
      'с 2026-10-03 по 2026-10-05',
      'создано 2026-10-03T12:30:00Z',
      'срок 03.10.2026, потом 2026.10.03',
      'дата 03-10-2026 и 3.1.2026',
      '(2026-10-03)',
    ]) {
      expect(maskSensitiveEcho(text)).toBe(text);
    }
  });

  it('дата рядом с телефоном: телефон скрыт, дата видна', () => {
    expect(
      maskSensitiveEcho('2026-10-03 звонил +380 67 123 45 67 (до 03.10.2026)'),
    ).toBe(`2026-10-03 звонил ${DEFAULT_MASK_LABELS.phone} (до 03.10.2026)`);
  });

  it('похожее на дату, но не дата — по-прежнему телефон', () => {
    const phone = DEFAULT_MASK_LABELS.phone;
    // месяц 34 и день 45 — не календарь
    expect(maskSensitiveEcho('12.34.5678')).toBe(phone);
    expect(maskSensitiveEcho('2026-45-67')).toBe(phone);
    expect(maskSensitiveEcho('2026-13-05')).toBe(phone);
    expect(maskSensitiveEcho('05.13.2026')).toBe(phone);
    expect(maskSensitiveEcho('2026-10-32')).toBe(phone);
    // за датой идут ещё цифры — это длинный номер, а не дата
    expect(maskSensitiveEcho('2026-10-0312')).toBe(phone);
    expect(maskSensitiveEcho('067-123-45-67')).toBe(phone);
  });

  it('короткое в скобках — не телефон: «(12) 34567», «(1) 2024»', () => {
    expect(maskSensitiveEcho('пункт (12) 34567')).toBe('пункт (12) 34567');
    expect(maskSensitiveEcho('(1) 2024 рік')).toBe('(1) 2024 рік');
  });

  it('несколько совпадений — все (флаг g)', () => {
    expect(maskSensitiveEcho('a@b.io b@c.io')).toBe(
      '[e-mail скрыт] [e-mail скрыт]',
    );
  });
});

describe('containsAnyPhrase', () => {
  const phrases = ['безлимит', 'free forever'];

  it('находит фразу без учёта регистра', () => {
    expect(containsAnyPhrase('У нас БЕЗЛИМИТ', phrases)).toBe(true);
    expect(containsAnyPhrase('Free Forever!', phrases)).toBe(true);
  });

  it('нет фраз — false; пустой список — всегда false', () => {
    expect(containsAnyPhrase('обычный ответ', phrases)).toBe(false);
    expect(containsAnyPhrase('безлимит', [])).toBe(false);
  });
});
