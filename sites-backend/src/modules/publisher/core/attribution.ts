/**
 * AI Publisher — атрибуция заявки (P-A1, проектный документ §9.3; ТЗ §14,
 * §15; AT-F11-01/02). Основная модель — последний непрямой контакт за 30
 * календарных дней Kyiv до заявки (`last_non_direct_30d`); первая
 * известная — отдельным блоком, не суммируется. Без допустимой истории —
 * `'unknown'` (догадки нет): неизвестные обращения не распределяются по
 * каналам.
 *
 * `paid_placement` — только если размещение найдено в реестре
 * (`placementId` задан обогащением P-D), а не по слову в `utm_medium`.
 *
 * Чистый модуль; когорты — `reports/metrics/cohorts.ts` (P-E).
 */
import type { ChannelGroup } from '../contracts/states';
import { addKyivCalendarDays } from './kyiv-time';

export const ATTRIBUTION_MODEL = 'last_non_direct_30d';
export const ATTRIBUTION_LOOKBACK_DAYS = 30;

export interface Touch {
  at: Date;
  channelGroup: ChannelGroup;
  source: string | null;
  placementId: string | null;
}

/** Касание допустимо для заявки: at ≤ leadAt ≤ at + lookback (граница включена). */
export function touchInWindow(
  touch: Pick<Touch, 'at'>,
  leadAt: Date,
  lookbackDays = ATTRIBUTION_LOOKBACK_DAYS,
): boolean {
  return (
    touch.at.getTime() <= leadAt.getTime() &&
    leadAt.getTime() <= addKyivCalendarDays(touch.at, lookbackDays).getTime()
  );
}

/** Последний непрямой контакт в окне; при равном времени — первый в списке. */
export function lastNonDirect(
  touches: readonly Touch[],
  leadAt: Date,
  lookbackDays = ATTRIBUTION_LOOKBACK_DAYS,
): Touch | 'unknown' {
  let best: Touch | null = null;
  for (const t of touches) {
    if (t.channelGroup === 'direct_unknown') continue;
    if (!touchInWindow(t, leadAt, lookbackDays)) continue;
    if (!best || t.at.getTime() > best.at.getTime()) best = t;
  }
  return best ?? 'unknown';
}

/** Первый известный (непрямой) контакт в том же окне — отдельный блок. */
export function firstKnown(
  touches: readonly Touch[],
  leadAt: Date,
  lookbackDays = ATTRIBUTION_LOOKBACK_DAYS,
): Touch | 'unknown' {
  let best: Touch | null = null;
  for (const t of touches) {
    if (t.channelGroup === 'direct_unknown') continue;
    if (!touchInWindow(t, leadAt, lookbackDays)) continue;
    if (!best || t.at.getTime() < best.at.getTime()) best = t;
  }
  return best ?? 'unknown';
}

const SEARCH_HOSTS = [
  'google.',
  'bing.com',
  'duckduckgo.com',
  'yahoo.',
  'ecosia.org',
  'startpage.com',
  'search.brave.com',
  'yandex.',
  'ukr.net',
  'meta.ua',
];
const SOCIAL_HOSTS = [
  'facebook.com',
  'fb.com',
  'instagram.com',
  't.me',
  'telegram.org',
  'linkedin.com',
  'lnkd.in',
  'x.com',
  'twitter.com',
  't.co',
  'reddit.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'threads.net',
  'medium.com',
  'dou.ua',
];
const ORGANIC_MEDIUMS = ['organic', 'seo', 'search'];
const SOCIAL_MEDIUMS = [
  'social',
  'community',
  'social-network',
  'social_media',
  'sm',
  'forum',
  'telegram',
  'post',
];
const DIRECT_MEDIUMS = ['none', '(none)', 'direct'];

function hostMatches(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) =>
    p.endsWith('.')
      ? host.startsWith(p) || host.includes(`.${p}`)
      : host === p || host.endsWith(`.${p}`),
  );
}

function normHost(h: string | null): string | null {
  if (!h) return null;
  const v = h
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return v || null;
}

/**
 * Группа канала касания: реестр размещений → `utm_medium` → хост
 * перехода → «прямой/неизвестно». Переход со своего хоста — внутренний,
 * то есть прямой.
 */
export function classifyChannel(i: {
  placementId: string | null;
  utmMedium: string | null;
  referrerHost: string | null;
  ownHosts: readonly string[];
}): ChannelGroup {
  if (i.placementId) return 'paid_placement';
  const medium = i.utmMedium?.trim().toLowerCase() || null;
  if (medium && !DIRECT_MEDIUMS.includes(medium)) {
    if (ORGANIC_MEDIUMS.includes(medium)) return 'organic_search';
    if (SOCIAL_MEDIUMS.includes(medium)) return 'unpaid_social_community';
    // Метка «платного» вида без размещения в реестре — не paid_placement.
    return 'other_referral';
  }
  const ref = normHost(i.referrerHost);
  const own = i.ownHosts.map(normHost).filter((h): h is string => !!h);
  if (!ref || own.includes(ref)) return 'direct_unknown';
  if (hostMatches(ref, SEARCH_HOSTS)) return 'organic_search';
  if (hostMatches(ref, SOCIAL_HOSTS)) return 'unpaid_social_community';
  return 'other_referral';
}

/** `pub_leads.attribution` (§6.5): блок модели для обогащения P-D. */
export interface LeadAttribution {
  model: typeof ATTRIBUTION_MODEL;
  last: {
    group: ChannelGroup;
    source: string | null;
    placementId: string | null;
    at: string;
  } | null;
  first: {
    group: ChannelGroup;
    source: string | null;
    placementId: string | null;
    at: string;
  } | null;
  coverage: 'linked' | 'unknown';
}

export function leadAttribution(
  touches: readonly Touch[],
  leadAt: Date,
): LeadAttribution {
  const view = (t: Touch | 'unknown') =>
    t === 'unknown'
      ? null
      : {
          group: t.channelGroup,
          source: t.source,
          placementId: t.placementId,
          at: t.at.toISOString(),
        };
  const last = lastNonDirect(touches, leadAt);
  return {
    model: ATTRIBUTION_MODEL,
    last: view(last),
    first: view(firstKnown(touches, leadAt)),
    coverage: last === 'unknown' ? 'unknown' : 'linked',
  };
}
