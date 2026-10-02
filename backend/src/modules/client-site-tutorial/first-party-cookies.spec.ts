/**
 * Ш0.5 аудита 02.10.2026 (риск В-1): в `cookiesEnc` — только куки сайта
 * заказчика. Правило — регистрируемый домен базы (как у доменного
 * замка), с приватной частью списка суффиксов.
 */

import { firstPartyCookies, isFirstPartyCookie } from './first-party-cookies';

const c = (domain: string) => ({
  name: 'n',
  value: 'v',
  domain,
  path: '/',
  secure: true,
  httpOnly: true,
  expires: -1,
});

describe('isFirstPartyCookie', () => {
  const BASE = 'https://www.shop.example.com/login';

  it.each([
    '.shop.example.com',
    'www.shop.example.com',
    'auth.example.com',
    '.example.com',
    'EXAMPLE.COM',
  ])('свой регистрируемый домен: %s — сохраняется', (domain) => {
    expect(isFirstPartyCookie(c(domain), BASE)).toBe(true);
  });

  it.each([
    '.google.com',
    'accounts.google.com',
    '.facebook.com',
    '.doubleclick.net',
    'example.com.evil.net',
    '',
  ])('чужой домен: %s — отбрасывается', (domain) => {
    expect(isFirstPartyCookie(c(domain), BASE)).toBe(false);
  });

  it('сайт на платформе: кука на общий суффикс (.myshopify.com) — чужая', () => {
    const base = 'https://alice.myshopify.com';
    expect(isFirstPartyCookie(c('alice.myshopify.com'), base)).toBe(true);
    expect(isFirstPartyCookie(c('.myshopify.com'), base)).toBe(false);
    expect(isFirstPartyCookie(c('bob.myshopify.com'), base)).toBe(false);
  });

  it('IP-адрес без регистрируемого домена — только точный хост', () => {
    expect(isFirstPartyCookie(c('203.0.113.5'), 'http://203.0.113.5')).toBe(
      true,
    );
    expect(isFirstPartyCookie(c('203.0.113.6'), 'http://203.0.113.5')).toBe(
      false,
    );
  });

  it('кривой baseUrl — ничего не сохраняем', () => {
    expect(isFirstPartyCookie(c('.example.com'), 'не ссылка')).toBe(false);
  });
});

describe('firstPartyCookies', () => {
  it('считает отброшенные', () => {
    const r = firstPartyCookies(
      [c('.example.com'), c('.google.com'), c('.facebook.com')],
      'https://example.com',
    );
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toBe(2);
  });
});
