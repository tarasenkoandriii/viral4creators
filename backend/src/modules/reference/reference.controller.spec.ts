import { ReferenceController } from './reference.controller';
import { COUNTRIES } from '../../common/data/countries';

describe('GET /reference/countries', () => {
  const list = new ReferenceController().countries();

  it('returns every country from the reference data, once', () => {
    expect(list).toHaveLength(COUNTRIES.length);
    expect(new Set(list.map((c) => c.code)).size).toBe(list.length);
  });

  it('exposes exactly the picker fields — no server-only `language`', () => {
    for (const c of list) {
      expect(Object.keys(c).sort()).toEqual([
        'code',
        'currency',
        'nameEn',
        'nameRu',
      ]);
    }
  });

  it('carries the values ProjectService will derive from', () => {
    const ua = list.find((c) => c.code === 'UA');
    expect(ua).toEqual({
      code: 'UA',
      currency: 'UAH',
      nameEn: 'Ukraine',
      nameRu: 'Украина',
    });
    expect(list.find((c) => c.code === 'BG')?.currency).toBe('EUR');
  });

  it('is small enough to ship whole (client-side search)', () => {
    expect(JSON.stringify(list).length).toBeLessThan(30_000);
  });
});
