import {
  contentHash,
  digitsMaskedHash,
  maskDigits,
  normalizeChunkText,
} from './hashing';

describe('хеши фрагментов (§4-тер.2)', () => {
  it('пробелы и NFC не меняют contentHash, регистр — меняет', () => {
    expect(contentHash('Ціна  70 грн\n')).toBe(contentHash('Ціна 70 грн'));
    // «й» составной (и + бреве) и готовый — один текст.
    expect(contentHash('Київ й'.normalize('NFD'))).toBe(contentHash('Київ й'));
    expect(contentHash('ABC-1234')).not.toBe(contentHash('abc-1234'));
  });

  it('сменилась только цена → тот же digitsMaskedHash, другой contentHash', () => {
    const a = 'Доставка — 70 грн, 1–3 дні';
    const b = 'Доставка — 80 грн, 2–4 дні';
    expect(contentHash(a)).not.toBe(contentHash(b));
    expect(digitsMaskedHash(a)).toBe(digitsMaskedHash(b));
  });

  it('число с разделителями — один маркер: 1 200,50 / 1.200 / 12:30', () => {
    expect(maskDigits('Ціна 1 200,50 грн о 12:30')).toBe('Ціна # грн о #');
    expect(digitsMaskedHash('Ціна 1 200 грн')).toBe(
      digitsMaskedHash('Ціна 999 грн'),
    );
    expect(digitsMaskedHash('1.200 $')).toBe(digitsMaskedHash('7 $'));
  });

  it('сменились слова — digitsMaskedHash другой (вектор пересчитается)', () => {
    expect(digitsMaskedHash('Доставка 70 грн')).not.toBe(
      digitsMaskedHash('Самовивіз 70 грн'),
    );
  });

  it('хеш маскированного текста не совпадает с contentHash того же текста', () => {
    expect(digitsMaskedHash('без цифр')).not.toBe(contentHash('без цифр'));
  });

  it('normalizeChunkText обрезает края и схлопывает пробелы', () => {
    expect(normalizeChunkText('  a \t b \n\n c ')).toBe('a b c');
  });
});
