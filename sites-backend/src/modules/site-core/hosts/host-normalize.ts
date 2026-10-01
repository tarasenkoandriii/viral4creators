/**
 * Хост = единица подтверждения владения: схема + FQDN (punycode) + порт
 * (ТЗ помощника §3.3, QA-ТЗ §2.2). Здесь — разбор того, что ввёл человек,
 * и сравнение хостов. Зеркало на клиенте — site-tma-kit/src/hosts.ts;
 * авторитетна эта копия (клиент лишь не предлагает заведомо отклоняемое).
 */

import { isIP } from 'net';
import { getDomain } from 'tldts';
import { badHost } from '../site-core.constants';

export interface HostAddress {
  scheme: 'https';
  /** FQDN в нижнем регистре, punycode, без точки на конце. */
  host: string;
  port: number;
}

/**
 * Хосты публичных платформ — подтверждение ТОЛЬКО через DNS (ТЗ §3.3):
 * файл/мета на `shop.myshopify.com` доказывают доступ к магазину на
 * платформе, но не к домену. Список общий с QA и с клиентом
 * (site-tma-kit/src/hosts.ts — там подмножество для подсказки UI).
 */
export const PUBLIC_PLATFORM_SUFFIXES = [
  'myshopify.com',
  'tilda.ws',
  'github.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'wixsite.com',
  'webflow.io',
  'herokuapp.com',
  'blogspot.com',
  'wordpress.com',
  'squarespace.com',
  'framer.website',
  'onrender.com',
  'fly.dev',
  'web.app',
  'firebaseapp.com',
  'azurewebsites.net',
  'cloudfront.net',
  'gitlab.io',
] as const;

export function isPublicPlatformHost(host: string): boolean {
  const h = host.toLowerCase();
  return PUBLIC_PLATFORM_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Имена, которые не бывают публичным сайтом заказчика. */
const INTERNAL_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home.arpa',
  'corp',
  'test',
  'invalid',
  'example',
  'onion',
];

/**
 * Разбор ввода: `example.com`, `https://Shop.Example.com/x?y`, `пример.укр`.
 * Путь и query отбрасываются — подтверждается хост, а не страница. `www`
 * НЕ срезается: это отдельный хост (QA §2.2).
 *
 * В MVP — только https на 443 (ТЗ §3.3): инструкция для http или другого
 * порта пообещала бы то, что виджет и обход потом не сделают.
 *
 * Бросает 400 `HOST_INVALID` с понятной фразой.
 */
export function normalizeHostInput(raw: unknown): HostAddress {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw badHost('Укажите адрес сайта');
  }
  const input = raw.trim();
  if (input.length > 2048) throw badHost('Слишком длинный адрес');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw badHost('Не похоже на адрес сайта');
  }
  if (url.protocol !== 'https:') {
    throw badHost('Подтверждаются только https-адреса');
  }
  if (url.port && url.port !== '443') {
    throw badHost('Подтверждаются только адреса на стандартном порту 443');
  }
  if (url.username || url.password) {
    throw badHost('Адрес не должен содержать логин и пароль');
  }
  // WHATWG URL уже перевёл IDN в punycode и опустил регистр.
  const host = url.hostname.replace(/\.$/, '');
  if (!host) throw badHost('Не похоже на адрес сайта');
  if (host.startsWith('[') || isIP(host) !== 0) {
    throw badHost('Укажите доменное имя, а не IP-адрес');
  }
  if (!host.includes('.')) {
    throw badHost('Укажите полное доменное имя (например, example.com)');
  }
  if (host.length > 253 || host.split('.').some((l) => l.length > 63)) {
    throw badHost('Слишком длинное доменное имя');
  }
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) {
    throw badHost('Недопустимые символы в доменном имени');
  }
  const lower = host.toLowerCase();
  if (INTERNAL_SUFFIXES.some((s) => lower === s || lower.endsWith(`.${s}`))) {
    throw badHost('Это внутреннее имя — укажите публичный адрес сайта');
  }
  return { scheme: 'https', host: lower, port: 443 };
}

/** Ключ уникальности — тот же, что в базе: (схема, хост, порт). */
export function hostKey(h: HostAddress): string {
  return `${h.scheme}://${h.host}:${h.port}`;
}

/** Origin для запросов и показа: порт 443 не пишется. */
export function hostOrigin(h: HostAddress): string {
  return h.port === 443
    ? `${h.scheme}://${h.host}`
    : `${h.scheme}://${h.host}:${h.port}`;
}

/**
 * Покрывает ли подтверждение хоста `verified` хост `candidate`. ТОЛЬКО
 * точное совпадение: поддомены не наследуются, wildcard по apex — нет
 * (Р-18, QA §2.4). Поддомен бывает делегирован Shopify/Zendesk, и
 * контроль DNS apex не равен контролю его содержимого.
 */
export function verificationCovers(
  verified: HostAddress,
  candidate: HostAddress,
): boolean {
  return hostKey(verified) === hostKey(candidate);
}

/**
 * Регистрируемый домен (eTLD+1) с ПРИВАТНОЙ частью списка суффиксов:
 * `alice.github.io` и `bob.github.io` — разные сайты (как в
 * backend/…/draft-rounds.ts). `null` — у имени регистрируемого домена нет.
 */
export function registrableDomain(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true });
}

/** Парный хост `www.x.com` ↔ `x.com` — только для apex и его `www`. */
export function wwwTwin(host: string): string | null {
  const domain = registrableDomain(host);
  if (!domain) return null;
  if (host === domain) return `www.${domain}`;
  if (host === `www.${domain}`) return domain;
  return null;
}

/**
 * Сам хост и все родительские имена (кроме TLD) — кандидаты в opt-out:
 * отказ `example.com` распространяется на `shop.example.com`.
 */
export function optOutCandidates(host: string): string[] {
  const parts = host.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join('.'));
  }
  return out;
}
