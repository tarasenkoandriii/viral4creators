/**
 * Подсказка поддоменов (ТЗ помощника §3.3, QA-ТЗ §2.2): UX вместо
 * наследования подтверждения. После обхода главной показываем хосты того
 * же регистрируемого домена (ссылки страницы) — «добавить и подтвердить».
 *
 * «Тот же сайт» — по eTLD+1 с приватной частью списка суффиксов (как
 * `assertSameSite` backend): `evil-example.com` не «похож» на
 * `example.com`, а `bob.github.io` — не поддомен `alice.github.io`.
 */

import { isIP } from 'net';
import { registrableDomain, wwwTwin } from '../hosts/host-normalize';

const URL_ATTR_RE = /\b(?:href|src|action|content)\s*=\s*["']([^"']+)["']/gi;
/** Голые https-ссылки в тексте/скриптах (JSON-LD, sitemap в ссылке). */
const BARE_URL_RE = /https:\/\/[a-z0-9.-]+/gi;

/**
 * Кандидаты-хосты из HTML: только https на 443, тот же регистрируемый
 * домен, что у `baseHost`, без уже известных. Порядок — по первому
 * появлению на странице (обычно меню — самые важные поддомены).
 */
export function suggestFromHtml(
  html: string,
  baseUrl: string,
  baseHost: string,
  known: ReadonlySet<string>,
  limit: number,
): string[] {
  const domain = registrableDomain(baseHost);
  if (!domain) return [];
  const raws: string[] = [];
  for (const m of html.matchAll(URL_ATTR_RE)) raws.push(m[1]);
  for (const m of html.matchAll(BARE_URL_RE)) raws.push(m[0]);
  const out: string[] = [];
  const seen = new Set<string>(known);
  for (const raw of raws) {
    let u: URL;
    try {
      u = new URL(raw.replace(/&amp;/g, '&'), baseUrl);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || (u.port && u.port !== '443')) continue;
    const host = u.hostname.replace(/\.$/, '').toLowerCase();
    if (!host || isIP(host) !== 0 || seen.has(host)) continue;
    if (registrableDomain(host) !== domain) continue;
    seen.add(host);
    out.push(host);
    if (out.length >= limit) break;
  }
  return out;
}

/** `www` ↔ apex для каждого хоста сайта, которых ещё нет. */
export function twinSuggestions(
  hosts: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const h of hosts) {
    const t = wwwTwin(h);
    if (t && !known.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}
