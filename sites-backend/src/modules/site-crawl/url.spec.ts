import { matchesExcluded, normalizeCrawlUrl, originOf } from './url';

describe('normalizeCrawlUrl', () => {
  it.each([
    [
      'https://Shop.Example.COM/a/./b/../c?b=2&a=1#x',
      'https://shop.example.com/a/c?a=1&b=2',
    ],
    ['https://shop.example.com:443/', 'https://shop.example.com/'],
    ['https://shop.example.com', 'https://shop.example.com/'],
    ['https://shop.example.com./x', 'https://shop.example.com/x'],
    ['https://shop.example.com//a//b', 'https://shop.example.com/a/b'],
    [
      'https://shop.example.com/p?utm_source=tg&UTM_Medium=x&gclid=1&fbclid=2&yclid=3&_ga=4&id=7',
      'https://shop.example.com/p?id=7',
    ],
    [
      'https://пример.укр/доставка',
      'https://xn--e1afmkfd.xn--j1amh/%D0%B4%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D0%BA%D0%B0',
    ],
    [
      'https://shop.example.com/s?q=a&q=b&q=a',
      'https://shop.example.com/s?q=a&q=a&q=b',
    ],
  ])('%s → %s', (raw, want) => {
    expect(normalizeCrawlUrl(raw)).toBe(want);
  });

  it('относительный — от базы', () => {
    expect(
      normalizeCrawlUrl('../x?utm_campaign=1', 'https://a.example.com/b/c/'),
    ).toBe('https://a.example.com/b/x');
  });

  it.each([
    'http://shop.example.com/',
    'https://shop.example.com:8443/',
    'https://u:p@shop.example.com/',
    'mailto:a@b.c',
    'javascript:alert(1)',
    'ftp://x.example.com/',
    '',
    '   ',
    'https://',
  ])('%s → null', (raw) => {
    expect(normalizeCrawlUrl(raw)).toBeNull();
  });

  it('originOf', () => {
    expect(originOf('https://shop.example.com/a?b')).toBe(
      'https://shop.example.com',
    );
  });
});

describe('matchesExcluded', () => {
  const P = [
    'https://shop.example.com/promo/',
    'https://shop.example.com/sale',
  ];
  it.each([
    ['https://shop.example.com/promo/1', true],
    ['https://shop.example.com/promo/', true],
    ['https://shop.example.com/promo', false],
    ['https://shop.example.com/sale', true],
    ['https://shop.example.com/sale/x', true],
    ['https://shop.example.com/sale?p=2', true],
    ['https://shop.example.com/salenew', false],
    ['https://other.example.com/promo/1', false],
  ])('%s → %s', (url, want) => {
    expect(matchesExcluded(url, P)).toBe(want);
  });

  it('точный URL — без подстраниц; запись исключения нормализуется', () => {
    const exact = ['https://Shop.example.com/x?utm_source=1'];
    expect(matchesExcluded('https://shop.example.com/x', [], exact)).toBe(true);
    expect(matchesExcluded('https://shop.example.com/x/y', [], exact)).toBe(
      false,
    );
  });
});
