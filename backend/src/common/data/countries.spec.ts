import { COUNTRIES, currencyForCountry, findCountry } from './countries';

describe('countries reference data (CLDR-generated)', () => {
  it('has one entry per ISO 3166-1 alpha-2 code, no duplicates', () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
    expect(COUNTRIES.length).toBeGreaterThan(240);
  });
  it('every entry has a 3-letter ISO 4217 currency and both names', () => {
    for (const c of COUNTRIES) {
      expect(c.currency).toMatch(/^[A-Z]{3}$/);
      expect(c.nameEn.length).toBeGreaterThan(0);
      expect(c.nameRu.length).toBeGreaterThan(0);
    }
  });
  it('spot-checks well-known mappings', () => {
    expect(currencyForCountry('UA')).toBe('UAH');
    expect(currencyForCountry('US')).toBe('USD');
    expect(currencyForCountry('DE')).toBe('EUR');
    expect(currencyForCountry('PL')).toBe('PLN');
    expect(currencyForCountry('GB')).toBe('GBP');
    expect(currencyForCountry('KZ')).toBe('KZT');
    expect(currencyForCountry('BG')).toBe('EUR'); // override, euro since 2026-01-01
  });
  it('is case-insensitive and tolerant of whitespace', () => {
    expect(currencyForCountry('ua')).toBe('UAH');
    expect(findCountry(' pl ')?.nameRu).toBe('Польша');
  });
  it('returns undefined for non-countries and garbage', () => {
    for (const bad of ['XX', 'EU', 'ZZ', 'XK', '', 'UKR', '001']) {
      expect(currencyForCountry(bad)).toBeUndefined();
    }
  });
});

describe('language (CLDR likely subtag → SerpApi hl)', () => {
  it('every entry has a 2-letter language', () => {
    for (const c of COUNTRIES) expect(c.language).toMatch(/^[a-z]{2,3}$/);
  });
  it('spot-checks', () => {
    expect(findCountry('UA')?.language).toBe('uk');
    expect(findCountry('PL')?.language).toBe('pl');
    expect(findCountry('US')?.language).toBe('en');
    expect(findCountry('DE')?.language).toBe('de');
  });
});
