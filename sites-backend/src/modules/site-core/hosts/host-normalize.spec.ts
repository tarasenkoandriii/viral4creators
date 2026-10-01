import { HttpException } from '@nestjs/common';
import {
  isPublicPlatformHost,
  normalizeHostInput,
  optOutCandidates,
  registrableDomain,
  verificationCovers,
  wwwTwin,
} from './host-normalize';

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e instanceof HttpException
      ? (e.getResponse() as { code?: string }).code
      : 'other';
  }
  return 'no-throw';
}

describe('normalizeHostInput', () => {
  it.each([
    ['example.com', 'example.com'],
    ['https://Shop.Example.com/x?y=1#z', 'shop.example.com'],
    ['  https://example.com.  ', 'example.com'],
    ['https://example.com:443/', 'example.com'],
    ['пример.укр', 'xn--e1afmkfd.xn--j1amh'],
  ])('%s → %s', (input, host) => {
    expect(normalizeHostInput(input)).toEqual({
      scheme: 'https',
      host,
      port: 443,
    });
  });

  it('www НЕ срезается: это отдельный хост', () => {
    expect(normalizeHostInput('www.example.com').host).toBe('www.example.com');
  });

  it.each([
    ['', 'пусто'],
    ['http://example.com', 'http'],
    ['https://example.com:8443', 'не 443'],
    ['https://1.2.3.4', 'IPv4'],
    ['https://[::1]', 'IPv6'],
    ['https://intranet', 'одно слово'],
    ['https://user:pw@example.com', 'логин в адресе'],
    ['https://api.localhost', 'localhost'],
    ['https://printer.local', '.local'],
    ['ftp://example.com', 'не https'],
  ])('%s — отказ (%s)', (input) => {
    expect(codeOf(() => normalizeHostInput(input))).toBe('HOST_INVALID');
  });
});

describe('подтверждение покрывает только точный хост', () => {
  const apex = normalizeHostInput('example.com');
  it('поддомен НЕ покрывается подтверждением apex (и наоборот)', () => {
    const shop = normalizeHostInput('shop.example.com');
    expect(verificationCovers(apex, shop)).toBe(false);
    expect(verificationCovers(shop, apex)).toBe(false);
  });
  it('apex и www — разные хосты', () => {
    expect(
      verificationCovers(apex, normalizeHostInput('www.example.com')),
    ).toBe(false);
  });
  it('тот же хост в другой записи — покрывается', () => {
    expect(
      verificationCovers(apex, normalizeHostInput('https://EXAMPLE.com/a')),
    ).toBe(true);
  });
});

describe('публичные платформы и домены', () => {
  it('платформы распознаются по суффиксу, а не по подстроке', () => {
    expect(isPublicPlatformHost('shop.myshopify.com')).toBe(true);
    expect(isPublicPlatformHost('alice.github.io')).toBe(true);
    expect(isPublicPlatformHost('evilmyshopify.com')).toBe(false);
    expect(isPublicPlatformHost('example.com')).toBe(false);
  });
  it('регистрируемый домен — с приватной частью списка', () => {
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io');
  });
  it('пара www/apex — только для apex и его www', () => {
    expect(wwwTwin('example.com')).toBe('www.example.com');
    expect(wwwTwin('www.example.com')).toBe('example.com');
    expect(wwwTwin('shop.example.com')).toBeNull();
  });
  it('opt-out: сам хост и родители без TLD', () => {
    expect(optOutCandidates('a.shop.example.com')).toEqual([
      'a.shop.example.com',
      'shop.example.com',
      'example.com',
    ]);
  });
});
