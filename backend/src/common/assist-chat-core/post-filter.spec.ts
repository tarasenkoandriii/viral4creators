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
