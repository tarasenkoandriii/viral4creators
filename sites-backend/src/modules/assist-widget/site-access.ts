/**
 * Чтение сайта, опубликованного вида и хостов под ролью assist_public — W2.
 * Общее для гварда origin, конфига, пинга и HTML iframe. Все запросы — с
 * ЯВНЫМ `select` только разрешённых роли колонок (контракт Э2 §2): лишняя
 * колонка — 42501 от Postgres на весь запрос.
 *
 * Допуск хоста — ТОЛЬКО через evaluateHostAccess ядра (льгота 72 ч —
 * свойство назначения `assist-widget`, её здесь не пересчитываем).
 */
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import type { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { readPublishedConfig } from '../assist-site-chat/published-config';
import { parsePublicKey } from '../assist-site-setup/keys';
import { registrableDomain } from '../site-core/hosts/host-normalize';
import {
  evaluateHostAccess,
  type HostAccessDecision,
} from '../site-core/ownership/host-access';
import { PUBLIC_SITE_HOST } from '../site-core/ownership/host-roles';

export type KeyKind = 'live' | 'test';

/** Колонки assist_sites, нужные виджету (все — в колоночном GRANT роли). */
export const WIDGET_SITE_SELECT = {
  id: true,
  accountId: true,
  siteId: true,
  enabled: true,
  knowledgeVersion: true,
  configVersion: true,
  widgetVersion: true,
  publicKey: true,
  testKey: true,
  chatPaused: true,
  operatorBlockedAt: true,
  allowClientPreview: true,
  ipSalt: true,
  leadsConfig: true,
  suggestedQuestions: true,
  suggestedForVersion: true,
} as const satisfies Prisma.AssistSiteSelect;

export type WidgetSiteRow = Prisma.AssistSiteGetPayload<{
  select: typeof WIDGET_SITE_SELECT;
}>;

/**
 * Тип ключа — разбором W4 (`parsePublicKey`: префикс бренда + base62 из
 * randomBytes). Всё прочее — null: в базу с мусором не ходим.
 */
export function keyKindOf(pk: unknown): KeyKind | null {
  if (typeof pk !== 'string' || pk.length > 80) return null;
  return parsePublicKey(pk)?.kind ?? null;
}

export async function findSiteByKey(
  db: AssistPublicDb,
  pk: string,
): Promise<{ site: WidgetSiteRow; kind: KeyKind } | null> {
  const kind = keyKindOf(pk);
  if (!kind) return null;
  const site = await db.assistSite.findFirst({
    where: kind === 'live' ? { publicKey: pk } : { testKey: pk },
    select: WIDGET_SITE_SELECT,
  });
  return site ? { site, kind } : null;
}

export function findSiteById(
  db: AssistPublicDb,
  siteId: string,
): Promise<WidgetSiteRow | null> {
  return db.assistSite.findUnique({
    where: { siteId },
    select: WIDGET_SITE_SELECT,
  });
}

/** Опубликованная конфигурация вида (строка версий) или null. */
export async function publishedWidgetConfig(
  db: AssistPublicDb,
  site: Pick<WidgetSiteRow, 'siteId' | 'widgetVersion'>,
): Promise<Record<string, unknown> | null> {
  // Сырой SQL (колоночный GRANT без id) — общий читатель W2/W3.
  return readPublishedConfig(db, site.siteId, 'widget', site.widgetVersion);
}

export interface HostRule {
  hostId: string;
  enabled: boolean;
  pathMasks: string[];
  hideOn: string[];
}

function strings(v: unknown, max: number): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string').slice(0, max)
    : [];
}

/**
 * `hosts[]` опубликованной конфигурации. Её уже проверил W4 при
 * публикации, но читаем оборонительно: битый элемент — пропуск, а не 500.
 */
export function hostRulesOf(
  config: Record<string, unknown> | null,
): HostRule[] {
  const raw = config?.hosts;
  if (!Array.isArray(raw)) return [];
  const out: HostRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.hostId !== 'string' || !o.hostId) continue;
    out.push({
      hostId: o.hostId,
      enabled: o.enabled === true,
      pathMasks: strings(o.pathMasks, 20),
      hideOn: strings(o.hideOn, 20),
    });
  }
  return out;
}

export interface SiteHostAccess {
  hostId: string;
  origin: string;
  host: string;
  decision: HostAccessDecision;
}

/** Origin хоста: порт по умолчанию схемы не пишется (как hostOrigin ядра). */
export function originOfHost(h: {
  scheme: string;
  host: string;
  port: number;
}): string {
  const dflt = h.scheme === 'https' ? 443 : h.scheme === 'http' ? 80 : -1;
  return h.port === dflt
    ? `${h.scheme}://${h.host}`
    : `${h.scheme}://${h.host}:${h.port}`;
}

/**
 * Все хосты «Сайта» с решением ядра для `assist-widget` на момент `now`.
 *
 * Хосты «Админки» (`assistRole = 'admin'`, аудит Э6-бис (б) (8), ТЗ §10)
 * сюда НЕ попадают вовсе: для гварда, конфига, frame-ancestors, предпросмотра
 * и страницы (`event`/`goal`/`pv`) такой хост — «не хост этого сайта», отказ
 * тот же, что у чужого origin (ничего не говорит о том, что это админка),
 * даже если владелец включил его в `hosts[]` вида.
 */
export async function siteHostAccess(
  db: AssistPublicDb,
  siteId: string,
  now: Date,
): Promise<SiteHostAccess[]> {
  const rows = await db.siteHost.findMany({
    where: { siteId, ...PUBLIC_SITE_HOST },
    select: {
      id: true,
      accountId: true,
      scheme: true,
      host: true,
      port: true,
      status: true,
      expiresAt: true,
      revokedAt: true,
      reverifyBlockedAt: true,
    },
  });
  return rows.map((r) => ({
    hostId: r.id,
    origin: originOfHost(r),
    host: r.host,
    decision: evaluateHostAccess(r, 'assist-widget', now),
  }));
}

export interface AllowedOrigin {
  origin: string;
  host: string;
  graceUntil: Date | null;
  pathMasks: string[];
  hideOn: string[];
}

/**
 * Где виджет РАБОТАЕТ сейчас (§4.12, §4.13 п.1б): хост включён в
 * опубликованной конфигурации И ядро пускает его для `assist-widget`
 * (verified или в льготе 72 ч). `onlyEnabled = false` — любой допущенный
 * хост сайта (предпросмотр «посмотреть на сайте» ещё до публикации).
 */
export function allowedOrigins(
  hosts: SiteHostAccess[],
  rules: HostRule[],
  onlyEnabled: boolean,
): AllowedOrigin[] {
  const byId = new Map(rules.map((r) => [r.hostId, r]));
  const out: AllowedOrigin[] = [];
  for (const h of hosts) {
    if (!h.decision.ok) continue;
    const rule = byId.get(h.hostId);
    if (onlyEnabled && !rule?.enabled) continue;
    out.push({
      origin: h.origin,
      host: h.host,
      graceUntil: h.decision.grace ? h.decision.graceUntil : null,
      pathMasks: rule?.pathMasks ?? [],
      hideOn: rule?.hideOn ?? [],
    });
  }
  return out;
}

/**
 * Origin родителя из тела запроса — ТОЧНЫЙ сериализованный origin
 * (`https://shop.ua`, `http://localhost:5173`): путь, query, логин,
 * завершающий слэш или регистр — уже не origin, а значит не совпадение.
 */
export function exactOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) {
    return null;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // Имя хоста — только LDH-метки (IDN уже в punycode): `;`, пробел и прочее,
  // что WHATWG URL пропускает в host, не должно дойти до заголовка CSP.
  if (!/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(u.hostname)) return null;
  return u.origin === raw ? raw : null;
}

/** `pk_test_` допускает только локальную разработку (§4.17). */
export function isLocalOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}

/** eTLD+1 хоста origin (null — нет регистрируемого домена). */
export function siteOfOrigin(origin: string): string | null {
  try {
    return registrableDomain(new URL(origin).hostname);
  } catch {
    return null;
  }
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
