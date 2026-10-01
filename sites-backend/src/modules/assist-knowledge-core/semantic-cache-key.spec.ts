import { normalizeQuestion, semanticCacheKey } from './semantic-cache-key';

const base = {
  siteId: 'site1',
  mode: 'site' as const,
  knowledgeVersion: 3,
  configVersion: 1,
  question: 'Скільки коштує доставка?',
};

describe('ключ семантического кэша (§4.5, §4-тер.15 п.5)', () => {
  it('смена knowledgeVersion / configVersion / режима / сайта — другой ключ', () => {
    const k = semanticCacheKey(base);
    expect(semanticCacheKey({ ...base, knowledgeVersion: 4 })).not.toBe(k);
    expect(semanticCacheKey({ ...base, configVersion: 2 })).not.toBe(k);
    expect(semanticCacheKey({ ...base, mode: 'admin' })).not.toBe(k);
    expect(semanticCacheKey({ ...base, siteId: 'site2' })).not.toBe(k);
  });

  it('регистр, пробелы и концевые знаки вопроса не меняют ключ', () => {
    expect(
      semanticCacheKey({
        ...base,
        question: '  скільки   КОШТУЄ доставка ?? ',
      }),
    ).toBe(semanticCacheKey(base));
    expect(normalizeQuestion('Привіт!!!')).toBe('привіт');
  });

  it('вопроса в ключе нет в открытом виде; плохая версия — ошибка', () => {
    expect(semanticCacheKey(base)).not.toContain('доставка');
    expect(() => semanticCacheKey({ ...base, knowledgeVersion: -1 })).toThrow();
    expect(() => semanticCacheKey({ ...base, siteId: '' })).toThrow();
  });
});
