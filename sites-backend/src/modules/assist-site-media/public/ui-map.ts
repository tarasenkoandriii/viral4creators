/**
 * Карта интерфейса для посетителя — Э6 (ТЗ помощника §4.9 `highlight`,
 * §4.12 «показать на экране»), с Э-С Ш4 — общая карта (`site_ui_elements`).
 * Под ролью `assist_public`, ровно тот SQL, что сверяет
 * prisma/assist-public-role.spec.ts.
 *
 *  - `pageUiElements` — элементы страницы посетителя: URL — только с хоста
 *    сайта (недоверенные данные, §4.6 п.5), ключ — хост + путь
 *    (site-core/ui-map). Ш4: слитые элементы своего вида вёрстки (снятое на
 *    телефоне компьютеру не предлагается), без устаревших для этого вида;
 *    вид неизвестен — любые, но без устаревших хоть где-то. У страницы ещё
 *    нет слитых элементов (карта до Ш4, крон их достроит) — по-старому из
 *    снимков источников (обучалка первой, затем обход).
 *  - `recordUiMiss` — сигнал «элемент не найден» (Ш4: по ЭЛЕМЕНТУ и виду,
 *    с порогом и окном вместо «страница устарела после первого промаха»).
 *    Засчитывается, только если (1) ЭТОМУ посетителю в его диалоге на этом
 *    сайте ассистент выдал подсветку ЭТОГО элемента не раньше
 *    `UI_MAP_STALE.receiptMs` назад НА ЭТОЙ СТРАНИЦЕ — квитанция показа:
 *    сообщение ассистента с действием `highlight`, где `page` — хост и путь
 *    страницы карты (id элемента — хеш селектора, один на всех страницах:
 *    квитанция `/cart` не засчитывает промах на `/checkout`; аудит Ш4);
 *    прямой вызов без своей просьбы ничего не трогает; (2) элемент есть в
 *    карте страницы для вида посетителя;
 *    (3) от этого посетителя и от этого хеша IP по этому элементу и виду
 *    промаха ещё не было (журнал `site_ui_element_misses`, уникальные
 *    ключи; хеш IP — с солью на окно, неделя: assist-widget/vote-ip-hash.ts).
 *    Элемент устаревает для вида, когда промахов в окне
 *    `UI_MAP_STALE.windowMs` набралось `threshold`. Лимиты на посетителя и
 *    IP+сайт — в контроллере.
 *  - `confirmSeenUiElements` — снимок загрузчика (Э6-бис, §5-бис.3 п.2)
 *    нашёл элементы на странице: `lastSeenAt` у УЖЕ известных элементов;
 *    снимок — данные ПОСЕТИТЕЛЯ, поэтому промахи и «устарел» он сам не
 *    снимает (аудит Ш4): у элемента с промахами своего вида — «голос за
 *    найден» с тем же порогом, что промахи (`UI_MAP_STALE.threshold`
 *    разных посетителей и разных IP за окно), и только набравшийся порог
 *    сбрасывает промахи вида. Мгновенный сброс — у источников сервера
 *    (обучалка, QA, ручная разметка — ui-map-store.ts). Снимок не
 *    сохраняется и новых элементов не создаёт. Элемент снимка вне перечня
 *    тегов карты (`div role=button`, тег `other`) узнаётся по ключам, не
 *    зависящим от тега (`data-assist-id`, id, test-id, роль+имя; Р-З9-2).
 *  - `recordUiSeen` — сигнал «найдено» подсветкой загрузчика (Ш4 (4),
 *    Р-З9-3): барьеры промаха (квитанция показа, элемент в карте вида), затем
 *    `lastSeenAt` и голос «найден» снимка — тот же журнал, порог и окно.
 *  - `markUiMapStale` — счётчик Э6 на снимках страницы (справочно; решение
 *    об устаревании — по элементу). Оставлен для совместимости.
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import {
  UI_ELEMENT_ID_RE,
  UI_MAP_LIMITS,
  cleanUiElements,
  cleanUiLabel,
  cleanUiSelector,
  uiMapHost,
  uiMapKey,
  uiMapPageRef,
  type UiElementTag,
  type UiMapElement,
} from '../../site-core/ui-map/ui-map';
import {
  UI_MAP_STALE,
  isStaleFor,
  rowFitsViewport,
  seenSnapshotKeys,
  type UiVisitorViewport,
} from '../../site-core/ui-map/ui-map-model';

type MapDb = Pick<AssistPublicDb, 'siteUiMap' | '$executeRaw' | '$queryRaw'>;

/** Ключ страницы посетителя, если её хост — хост сайта; иначе null. */
export function visitorPageKey(
  pageUrl: string | null | undefined,
  siteHosts: string[],
): { host: string; path: string } | null {
  const key = uiMapKey(pageUrl);
  if (!key) return null;
  const allowed = new Set(siteHosts.map(uiMapHost));
  return allowed.has(key.host) ? key : null;
}

const SOURCE_ORDER: Record<string, number> = { tutorial: 0, crawl: 1 };

interface ElementRow {
  elementId: string;
  elementKey: string;
  selector: string | null;
  tag: string;
  label: string;
  viewport: string;
  sourceRank: number;
  position: number;
  staleDesktopAt: Date | null;
  staleMobileAt: Date | null;
}

export async function pageUiElements(
  db: MapDb,
  siteId: string,
  pageUrl: string | null | undefined,
  siteHosts: string[],
  opts: { viewport?: UiVisitorViewport } = {},
): Promise<UiMapElement[]> {
  const key = visitorPageKey(pageUrl, siteHosts);
  if (!key) return [];
  const rows = await db.$queryRaw<ElementRow[]>(Prisma.sql`
    SELECT "elementId", "elementKey", "selector", "tag", "label", "viewport",
           "sourceRank", "position", "staleDesktopAt", "staleMobileAt"
      FROM "sites"."site_ui_elements"
     WHERE "siteId" = ${siteId} AND "host" = ${key.host} AND "path" = ${key.path}`);
  if (!rows.length) return legacyPageElements(db, siteId, key);
  const v = opts.viewport;
  // Свой вид — раньше общего (`any`) с тем же ключом.
  const ordered = rows
    .filter((r) => rowFitsViewport(r.viewport, v) && !isStaleFor(r, v))
    .sort(
      (a, b) =>
        Number(b.viewport === v) - Number(a.viewport === v) ||
        a.sourceRank - b.sourceRank ||
        a.position - b.position,
    );
  const out: Array<UiMapElement & { rank: number; pos: number }> = [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  for (const r of ordered) {
    // Карту писал наш код, но читаем строго (как Э6).
    const selector = r.selector ? cleanUiSelector(r.selector) : null;
    const label = cleanUiLabel(r.label);
    if (!selector || !label || !UI_ELEMENT_ID_RE.test(r.elementId)) continue;
    if (seenKeys.has(r.elementKey) || seenIds.has(r.elementId)) continue;
    seenKeys.add(r.elementKey);
    seenIds.add(r.elementId);
    out.push({
      id: r.elementId,
      selector,
      tag: r.tag as UiElementTag,
      label,
      rank: r.sourceRank,
      pos: r.position,
    });
  }
  return out
    .sort((a, b) => a.rank - b.rank || a.pos - b.pos)
    .slice(0, UI_MAP_LIMITS.elements)
    .map(({ id, selector, tag, label }) => ({ id, selector, tag, label }));
}

/** Э6: элементы из снимков источников (страница без слитых элементов). */
async function legacyPageElements(
  db: MapDb,
  siteId: string,
  key: { host: string; path: string },
): Promise<UiMapElement[]> {
  const rows = await db.siteUiMap.findMany({
    where: { siteId, host: key.host, path: key.path },
    select: { source: true, elements: true },
  });
  rows.sort(
    (a, b) => (SOURCE_ORDER[a.source] ?? 9) - (SOURCE_ORDER[b.source] ?? 9),
  );
  const out: UiMapElement[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const e of cleanUiElements(r.elements)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

/** Э6: счётчик на снимках страницы, в которых такой элемент ЕСТЬ. */
export async function markUiMapStale(
  db: MapDb,
  p: {
    siteId: string;
    pageUrl: string | null | undefined;
    siteHosts: string[];
    elementId: unknown;
  },
): Promise<boolean> {
  if (typeof p.elementId !== 'string' || !UI_ELEMENT_ID_RE.test(p.elementId))
    return false;
  const key = visitorPageKey(p.pageUrl, p.siteHosts);
  if (!key) return false;
  const n = await db.$executeRaw(Prisma.sql`
    UPDATE "sites"."site_ui_maps"
       SET "staleSignals" = "staleSignals" + 1, "lastStaleAt" = now()
     WHERE "siteId" = ${p.siteId} AND "host" = ${key.host} AND "path" = ${key.path}
       AND "elements" @> ${JSON.stringify([{ id: p.elementId }])}::jsonb`);
  return n > 0;
}

export type UiMissOutcome =
  | 'recorded'
  /** id не той формы, страница не с хоста сайта. */
  | 'invalid'
  /** Посетителю этот элемент в его диалоге не показывали (или давно). */
  | 'no-receipt'
  /** Элемента нет в карте страницы для вида посетителя. */
  | 'unknown-element'
  /** Этот посетитель или этот IP уже сообщали о промахе элемента. */
  | 'duplicate';

const MISS_COLUMNS: Record<
  UiVisitorViewport,
  {
    count: Prisma.Sql;
    since: Prisma.Sql;
    stale: Prisma.Sql;
    seen: Prisma.Sql;
    seenSince: Prisma.Sql;
  }
> = {
  desktop: {
    count: Prisma.raw('"missCountDesktop"'),
    since: Prisma.raw('"missSinceDesktop"'),
    stale: Prisma.raw('"staleDesktopAt"'),
    seen: Prisma.raw('"seenCountDesktop"'),
    seenSince: Prisma.raw('"seenSinceDesktop"'),
  },
  mobile: {
    count: Prisma.raw('"missCountMobile"'),
    since: Prisma.raw('"missSinceMobile"'),
    stale: Prisma.raw('"staleMobileAt"'),
    seen: Prisma.raw('"seenCountMobile"'),
    seenSince: Prisma.raw('"seenSinceMobile"'),
  },
};

/** Голосов «найден» за один снимок — не больше (в журнал идёт строка на элемент). */
const SEEN_VOTES_PER_SNAPSHOT = 20;

export async function recordUiMiss(
  db: MapDb,
  p: {
    accountId: string;
    siteId: string;
    visitorId: string;
    ipHash: string;
    pageUrl: string | null | undefined;
    siteHosts: string[];
    elementId: unknown;
    viewport: UiVisitorViewport;
    now: Date;
  },
): Promise<{ outcome: UiMissOutcome; stale: boolean }> {
  const no = (outcome: UiMissOutcome) => ({ outcome, stale: false });
  if (typeof p.elementId !== 'string' || !UI_ELEMENT_ID_RE.test(p.elementId))
    return no('invalid');
  const key = visitorPageKey(p.pageUrl, p.siteHosts);
  if (!key) return no('invalid');
  if (!(await hasShowReceipt(db, { ...p, elementId: p.elementId, key })))
    return no('no-receipt');
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "sites"."site_ui_elements"
     WHERE "siteId" = ${p.siteId} AND "host" = ${key.host} AND "path" = ${key.path}
       AND "elementId" = ${p.elementId} AND "viewport" IN (${p.viewport}, 'any')
     ORDER BY ("viewport" = ${p.viewport}) DESC
     LIMIT 1`);
  if (!rows.length) return no('unknown-element');
  const rowId = rows[0].id;
  const inserted = await db.$executeRaw(Prisma.sql`
    INSERT INTO "sites"."site_ui_element_misses"
           ("id", "accountId", "siteId", "elementRowId", "viewport", "kind", "ipHash", "visitorId", "createdAt")
    VALUES (${randomUUID()}, ${p.accountId}, ${p.siteId}, ${rowId}, ${p.viewport}, 'miss',
            ${p.ipHash}, ${p.visitorId}, ${p.now}::timestamp(3))
    ON CONFLICT DO NOTHING`);
  if (inserted === 0) return no('duplicate');
  const c = MISS_COLUMNS[p.viewport];
  const windowStart = new Date(p.now.getTime() - UI_MAP_STALE.windowMs);
  const fresh = Prisma.sql`(${c.since} IS NULL OR ${c.since} < ${windowStart}::timestamp(3))`;
  const updated = await db.$queryRaw<Array<{ stale: Date | null }>>(Prisma.sql`
    UPDATE "sites"."site_ui_elements"
       SET ${c.count} = CASE WHEN ${fresh} THEN 1 ELSE ${c.count} + 1 END,
           ${c.since} = CASE WHEN ${fresh} THEN ${p.now}::timestamp(3) ELSE ${c.since} END,
           ${c.stale} = CASE
             WHEN ${c.stale} IS NULL
              AND (CASE WHEN ${fresh} THEN 1 ELSE ${c.count} + 1 END) >= ${UI_MAP_STALE.threshold}
             THEN ${p.now}::timestamp(3) ELSE ${c.stale} END,
           "lastMissAt" = ${p.now}::timestamp(3)
     WHERE "id" = ${rowId}
    RETURNING ${c.stale} AS "stale"`);
  return { outcome: 'recorded', stale: !!updated[0]?.stale };
}

/**
 * Снимок загрузчика (Э6-бис) нашёл элементы: у известных элементов страницы
 * (свой вид и `any`) — `lastSeenAt`; у тех, где у вида есть промахи или
 * «устарел», — голос «найден» (журнал, один на посетителя и на хеш IP за
 * окно) и счётчик голосов вида в окне; набрался порог — промахи, «устарел»
 * и голоса вида сброшены. Элементы снимка — в форме снимка (`{tag,
 * label|name, selector?, assistId?, role?, candidates?}`), узнаются по
 * ключам кандидатов; `div role=button` (тег `other`) — по ключам, не
 * зависящим от тега (Р-З9-2, `seenSnapshotKeys`). Возвращает число
 * узнанных строк.
 */
export async function confirmSeenUiElements(
  db: MapDb,
  p: {
    accountId: string;
    siteId: string;
    visitorId: string;
    /** Хеш IP с солью на окно (assist-widget/vote-ip-hash.ts). */
    ipHash: string;
    pageUrl: string | null | undefined;
    siteHosts: string[];
    viewport: UiVisitorViewport;
    seen: unknown;
    now: Date;
  },
): Promise<number> {
  const key = visitorPageKey(p.pageUrl, p.siteHosts);
  if (!key || !Array.isArray(p.seen)) return 0;
  const items = p.seen.map((x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? {
          ...(x as Record<string, unknown>),
          label:
            (x as Record<string, unknown>).label ??
            (x as Record<string, unknown>).name,
        }
      : x,
  );
  const keys = seenSnapshotKeys(items, 150);
  if (!keys.length) return 0;
  const c = MISS_COLUMNS[p.viewport];
  const rows = await db.$queryRaw<Array<{ id: string; doubt: boolean }>>(
    Prisma.sql`
    UPDATE "sites"."site_ui_elements"
       SET "lastSeenAt" = ${p.now}::timestamp(3)
     WHERE "siteId" = ${p.siteId} AND "host" = ${key.host} AND "path" = ${key.path}
       AND "viewport" IN (${p.viewport}, 'any')
       AND "elementKey" = ANY(${keys}::text[])
    RETURNING "id", (${c.count} > 0 OR ${c.stale} IS NOT NULL) AS "doubt"`,
  );
  for (const r of rows
    .filter((x) => x.doubt)
    .slice(0, SEEN_VOTES_PER_SNAPSHOT)) {
    await seenVote(db, { ...p, rowId: r.id });
  }
  return rows.length;
}

/**
 * Голос «найден» по строке элемента для вида посетителя: один на
 * посетителя и на хеш IP (журнал `kind = seen`, уникальные ключи), счётчик
 * голосов вида в окне; набрался порог (`UI_MAP_STALE.threshold` разных
 * посетителей и IP) — промахи, «устарел» и голоса вида сброшены.
 */
async function seenVote(
  db: MapDb,
  p: {
    accountId: string;
    siteId: string;
    rowId: string;
    visitorId: string;
    ipHash: string;
    viewport: UiVisitorViewport;
    now: Date;
  },
): Promise<'duplicate' | 'voted' | 'reset'> {
  const c = MISS_COLUMNS[p.viewport];
  const inserted = await db.$executeRaw(Prisma.sql`
    INSERT INTO "sites"."site_ui_element_misses"
           ("id", "accountId", "siteId", "elementRowId", "viewport", "kind", "ipHash", "visitorId", "createdAt")
    VALUES (${randomUUID()}, ${p.accountId}, ${p.siteId}, ${p.rowId}, ${p.viewport}, 'seen',
            ${p.ipHash}, ${p.visitorId}, ${p.now}::timestamp(3))
    ON CONFLICT DO NOTHING`);
  if (inserted === 0) return 'duplicate';
  const windowStart = new Date(p.now.getTime() - UI_MAP_STALE.windowMs);
  const fresh = Prisma.sql`(${c.seenSince} IS NULL OR ${c.seenSince} < ${windowStart}::timestamp(3))`;
  const next = Prisma.sql`(CASE WHEN ${fresh} THEN 1 ELSE ${c.seen} + 1 END)`;
  const reached = Prisma.sql`${next} >= ${UI_MAP_STALE.threshold}`;
  const updated = await db.$queryRaw<Array<{ reset: boolean }>>(Prisma.sql`
    UPDATE "sites"."site_ui_elements"
       SET ${c.seen} = CASE WHEN ${reached} THEN 0 ELSE ${next} END,
           ${c.seenSince} = CASE WHEN ${reached} THEN NULL
                                 WHEN ${fresh} THEN ${p.now}::timestamp(3)
                                 ELSE ${c.seenSince} END,
           ${c.count} = CASE WHEN ${reached} THEN 0 ELSE ${c.count} END,
           ${c.since} = CASE WHEN ${reached} THEN NULL ELSE ${c.since} END,
           ${c.stale} = CASE WHEN ${reached} THEN NULL ELSE ${c.stale} END
     WHERE "id" = ${p.rowId}
    RETURNING (${c.seen} = 0 AND ${c.seenSince} IS NULL) AS "reset"`);
  return updated[0]?.reset ? 'reset' : 'voted';
}

export type UiSeenOutcome =
  /** Голос «найден» принят (элемент был под сомнением у вида посетителя). */
  | 'voted'
  /** Голос набрал порог: промахи и «устарел» вида сброшены. */
  | 'reset'
  /** Сомнений у вида не было — только `lastSeenAt`. */
  | 'seen'
  | 'invalid'
  | 'no-receipt'
  | 'unknown-element'
  /** Этот посетитель или этот IP уже голосовали «найден» за элемент. */
  | 'duplicate';

/**
 * Ш4 (4), Р-З9-3: загрузчик НАШЁЛ элемент подсветки (`highlight-result
 * {found: true}` → iframe → `POST /widget/v1/highlight-seen`). Те же
 * барьеры, что у промаха (`recordUiMiss`): квитанция показа ЭТОМУ
 * посетителю ЭТОГО элемента НА ЭТОЙ странице, элемент — в карте страницы
 * для вида посетителя (свой вид раньше `any` — та же строка, что у
 * промаха); дальше — `lastSeenAt` и, если у вида есть промахи или
 * «устарел», голос «найден» с тем же порогом, что у снимка (мгновенного
 * сброса нет: данные посетителя). Лимиты на посетителя и IP+сайт — в
 * контроллере.
 */
export async function recordUiSeen(
  db: MapDb,
  p: {
    accountId: string;
    siteId: string;
    visitorId: string;
    ipHash: string;
    pageUrl: string | null | undefined;
    siteHosts: string[];
    elementId: unknown;
    viewport: UiVisitorViewport;
    now: Date;
  },
  opts: {
    /**
     * Перед голосом (только когда у вида есть сомнение): суточный лимит
     * IP+сайт — бросает RATE_LIMITED. «Видели» без сомнения лимит не тратит.
     */
    beforeVote?: () => Promise<void>;
  } = {},
): Promise<{ outcome: UiSeenOutcome }> {
  if (typeof p.elementId !== 'string' || !UI_ELEMENT_ID_RE.test(p.elementId))
    return { outcome: 'invalid' };
  const key = visitorPageKey(p.pageUrl, p.siteHosts);
  if (!key) return { outcome: 'invalid' };
  if (!(await hasShowReceipt(db, { ...p, elementId: p.elementId, key })))
    return { outcome: 'no-receipt' };
  const c = MISS_COLUMNS[p.viewport];
  const rows = await db.$queryRaw<Array<{ id: string; doubt: boolean }>>(
    Prisma.sql`
    UPDATE "sites"."site_ui_elements"
       SET "lastSeenAt" = ${p.now}::timestamp(3)
     WHERE "id" = (
       SELECT "id" FROM "sites"."site_ui_elements"
        WHERE "siteId" = ${p.siteId} AND "host" = ${key.host} AND "path" = ${key.path}
          AND "elementId" = ${p.elementId} AND "viewport" IN (${p.viewport}, 'any')
        ORDER BY ("viewport" = ${p.viewport}) DESC
        LIMIT 1)
    RETURNING "id", (${c.count} > 0 OR ${c.stale} IS NOT NULL) AS "doubt"`,
  );
  if (!rows.length) return { outcome: 'unknown-element' };
  if (!rows[0].doubt) return { outcome: 'seen' };
  await opts.beforeVote?.();
  return { outcome: await seenVote(db, { ...p, rowId: rows[0].id }) };
}

/** Квитанция показа: ассистент выдал посетителю подсветку элемента на странице. */
async function hasShowReceipt(
  db: MapDb,
  p: {
    siteId: string;
    visitorId: string;
    elementId: string;
    key: { host: string; path: string };
    now: Date;
  },
): Promise<boolean> {
  const since = new Date(p.now.getTime() - UI_MAP_STALE.receiptMs);
  const receipt = await db.$queryRaw<Array<{ ok: number }>>(Prisma.sql`
    SELECT 1 AS "ok"
      FROM "sites"."assist_site_messages" m
      JOIN "sites"."assist_site_conversations" c ON c."id" = m."conversationId"
     WHERE m."siteId" = ${p.siteId} AND c."siteId" = ${p.siteId}
       AND c."visitorId" = ${p.visitorId} AND m."role" = 'assistant'
       AND m."createdAt" >= ${since}::timestamp(3)
       AND m."actions" @> ${JSON.stringify([{ kind: 'highlight', elementId: p.elementId, page: uiMapPageRef(p.key) }])}::jsonb
     LIMIT 1`);
  return receipt.length > 0;
}
