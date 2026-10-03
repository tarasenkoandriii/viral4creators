/**
 * Хранилище общей карты интерфейса — Э-С Ш4 (основная роль, тенант
 * кабинета). Одна дверь записи для ВСЕХ источников: обход (`site-crawl`),
 * раунды обучалки и Flow-QA (внутренний API `internal-sites`), позже —
 * ручная разметка редактора Э6-тер. Чтение посетителя — отдельно, под
 * `assist_public` (assist-site-media/public/ui-map.ts).
 *
 * Модель (миграция `20261005170000_site_ui_maps_shared`):
 *  - `site_ui_maps` — ТЕКУЩИЙ снимок источника по (сайт, хост, путь,
 *    источник, вид); новый набор — `version + 1` и строка истории
 *    `site_ui_map_versions` (история, а не перезапись);
 *  - `site_ui_elements` — элементы страницы и вида, СЛИТЫЕ из снимков всех
 *    источников по стабильному ключу (ui-map-model.ts): кандидаты, подпись,
 *    устойчивость, уверенность, источники, `lastSeenAt`, промахи по виду;
 *  - подтверждение элемента браузерным источником (обучалка, QA, загрузчик,
 *    ручная разметка) снимает промахи и «устарел» своего вида; обход
 *    только отмечает `lastSeenAt` (разметка ≠ видимость).
 *
 * Запросы — через клиент тенанта (`SitesDb.forAccount`) или системный
 * (крон) — параметром: файл не создаёт клиентов сам.
 */
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { SitesDb } from '../../../prisma/sites-db.service';
import { uiMapHost } from './ui-map';
import {
  UI_BROWSER_SOURCES,
  UI_MAP_SHARED,
  UI_MAP_STALE,
  candidateKeys,
  cleanUiSnapshot,
  mergeUiSnapshots,
  parseUiSource,
  uiSnapshotHash,
  viewportsConfirmedBy,
  type MergedUiElement,
  type UiMapViewport,
  type UiSelectorCandidate,
  type UiStability,
} from './ui-map-model';
import type { UiElementTag, UiMapSource } from './ui-map';

export type UiMapDb = ReturnType<SitesDb['forAccount']>;

/** Новая страница сверх потолка карты сайта (UI_MAP_SHARED.pagesPerSite). */
export class UiMapLimitError extends Error {
  readonly code = 'UI_MAP_PAGES_LIMIT';
  constructor() {
    super(
      `В карте сайта уже ${UI_MAP_SHARED.pagesPerSite} страниц — новые не принимаются`,
    );
  }
}

export interface UiSnapshotInput {
  accountId: string;
  siteId: string;
  hostId: string;
  /** Ключ страницы — `uiMapKey()` (хост без www, путь без query). */
  host: string;
  path: string;
  source: UiMapSource;
  viewport: UiMapViewport;
  elements: unknown;
  now?: Date;
}

export interface UiSnapshotResult {
  path: string;
  source: UiMapSource;
  viewport: UiMapViewport;
  /** Принятых элементов снимка (после чистки). */
  elements: number;
  /** Версия текущего снимка источника (0 — снимок снят пустым набором). */
  version: number;
  /** Набор новый (версия выросла / снимок удалён). */
  changed: boolean;
}

/**
 * Принять снимок источника для страницы и вида: чистка, версия и история,
 * слияние в элементы. Пустой набор — снимок источника снимается (элементы,
 * которые держались только на нём, уходят).
 */
export async function ingestUiSnapshot(
  db: UiMapDb,
  input: UiSnapshotInput,
): Promise<UiSnapshotResult> {
  const now = input.now ?? new Date();
  const elements = cleanUiSnapshot(input.elements);
  const where = {
    siteId: input.siteId,
    host: input.host,
    path: input.path,
    source: input.source,
    viewport: input.viewport,
  };
  const base = {
    path: input.path,
    source: input.source,
    viewport: input.viewport,
  };
  const existing = await db.siteUiMap.findFirst({
    where,
    select: { id: true, elementsHash: true, version: true },
  });
  if (!elements.length) {
    if (existing) await db.siteUiMap.deleteMany({ where: { id: existing.id } });
    if (existing) await syncMergedElements(db, input, now, null);
    return { ...base, elements: 0, version: 0, changed: !!existing };
  }
  if (!existing) await assertPageLimit(db, input);
  const elementsHash = uiSnapshotHash(elements);
  const changed = existing?.elementsHash !== elementsHash;
  // Снимок сняли пустым набором, а история осталась (аудит Ш4): номер — после
  // последнего в истории, иначе строка истории новой версии молча
  // пропускалась бы (skipDuplicates), а крон берёг бы чужую «текущую».
  const prev =
    existing?.version ??
    (
      await db.siteUiMapVersion.findFirst({
        where,
        orderBy: { version: 'desc' },
        select: { version: true },
      })
    )?.version ??
    0;
  const version = changed ? prev + 1 : existing!.version;
  const stored = elements as unknown as Prisma.InputJsonValue;
  if (existing) {
    await db.siteUiMap.update({
      where: { id: existing.id },
      data: {
        hostId: input.hostId,
        capturedAt: now,
        ...(changed
          ? {
              elements: stored,
              elementsHash,
              version,
              // Э6: сигнал относился к прежнему набору.
              staleSignals: 0,
              lastStaleAt: null,
            }
          : {}),
      },
    });
  } else {
    await db.siteUiMap.create({
      data: {
        ...where,
        accountId: input.accountId,
        hostId: input.hostId,
        elements: stored,
        elementsHash,
        version,
        capturedAt: now,
      },
    });
  }
  if (changed) {
    await db.siteUiMapVersion.createMany({
      data: [
        {
          ...where,
          accountId: input.accountId,
          hostId: input.hostId,
          version,
          elements: stored,
          elementsHash,
          elementCount: elements.length,
          capturedAt: now,
        },
      ],
      skipDuplicates: true,
    });
  }
  const seenKeys = new Set(
    elements.flatMap((e) => [e.key, ...candidateKeys(e.candidates, e.tag)]),
  );
  const confirms = UI_BROWSER_SOURCES.has(input.source);
  if (!changed && !confirms) {
    // Обход прошёл ту же вёрстку: только «видели» — без пересборки.
    await db.siteUiElement.updateMany({
      where: {
        siteId: input.siteId,
        host: input.host,
        path: input.path,
        viewport: input.viewport,
        elementKey: { in: [...seenKeys] },
      },
      data: { lastSeenAt: now },
    });
  } else {
    await syncMergedElements(db, input, now, { keys: seenKeys, confirms });
  }
  if (confirms && input.viewport !== 'any') {
    await confirmAnyRows(db, input, input.viewport, seenKeys, now);
  }
  return { ...base, elements: elements.length, version, changed };
}

/**
 * Браузер вида V увидел элемент — и общая (`any`) строка того же элемента
 * (из обхода) для вида V подтверждена: её промахи и «устарел» вида V
 * снимаются. Другой вид не трогается.
 */
async function confirmAnyRows(
  db: UiMapDb,
  page: { siteId: string; host: string; path: string },
  viewport: 'desktop' | 'mobile',
  keys: Set<string>,
  now: Date,
): Promise<void> {
  const rows = await db.siteUiElement.findMany({
    where: {
      siteId: page.siteId,
      host: page.host,
      path: page.path,
      viewport: 'any',
      elementKey: { in: [...keys] },
    },
    select: { id: true },
  });
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  await db.siteUiElement.updateMany({
    where: { id: { in: ids } },
    data: { lastSeenAt: now, ...resetFor([viewport]) },
  });
  await db.siteUiElementMiss.deleteMany({
    where: { elementRowId: { in: ids }, viewport },
  });
}

async function assertPageLimit(db: UiMapDb, input: UiSnapshotInput) {
  const same = await db.siteUiMap.findFirst({
    where: { siteId: input.siteId, host: input.host, path: input.path },
    select: { id: true },
  });
  if (same) return;
  const pages = await db.siteUiMap.findMany({
    where: { siteId: input.siteId },
    distinct: ['host', 'path'],
    select: { id: true },
    take: UI_MAP_SHARED.pagesPerSite,
  });
  if (pages.length >= UI_MAP_SHARED.pagesPerSite) throw new UiMapLimitError();
}

type ElementRow = Awaited<
  ReturnType<UiMapDb['siteUiElement']['findMany']>
>[number];

/** Сброс промахов вида (новое подтверждение браузерным источником). */
function resetFor(viewports: Array<'desktop' | 'mobile'>) {
  const out: Record<string, number | null> = {};
  for (const v of viewports) {
    const s = v === 'desktop' ? 'Desktop' : 'Mobile';
    out[`missCount${s}`] = 0;
    out[`missSince${s}`] = null;
    out[`stale${s}At`] = null;
    out[`seenCount${s}`] = 0;
    out[`seenSince${s}`] = null;
  }
  return out;
}

function mergedData(m: MergedUiElement, hostId: string) {
  return {
    hostId,
    elementKey: m.key,
    elementId: m.elementId,
    tag: m.tag,
    label: m.label,
    role: m.role,
    selector: m.selector,
    candidates: m.candidates as unknown as Prisma.InputJsonValue,
    stability: m.stability,
    confidence: m.confidence,
    sources: m.sources,
    sourceRank: m.sourceRank,
    position: m.position,
  };
}

function sameData(r: ElementRow, d: ReturnType<typeof mergedData>): boolean {
  return (
    r.hostId === d.hostId &&
    r.elementKey === d.elementKey &&
    r.elementId === d.elementId &&
    r.tag === d.tag &&
    r.label === d.label &&
    r.role === d.role &&
    r.selector === d.selector &&
    JSON.stringify(r.candidates) === JSON.stringify(d.candidates) &&
    r.stability === d.stability &&
    r.confidence === d.confidence &&
    r.sources.join(',') === d.sources.join(',') &&
    r.sourceRank === d.sourceRank &&
    r.position === d.position
  );
}

/**
 * Пересборка слитых элементов страницы и вида из ТЕКУЩИХ снимков всех
 * источников. Строка элемента узнаётся по ключу, а если ключ сменился
 * (пришёл более надёжный кандидат) — по любому общему ключу кандидата:
 * промахи и `firstSeenAt` не теряются. `seen` — элементы снимка, который
 * сейчас принят (их `lastSeenAt` = сейчас; браузерный источник ещё и
 * снимает промахи своего вида).
 */
export async function syncMergedElements(
  db: UiMapDb,
  page: {
    accountId: string;
    siteId: string;
    hostId: string;
    host: string;
    path: string;
    viewport: UiMapViewport;
  },
  now: Date,
  seen: { keys: Set<string>; confirms: boolean } | null,
): Promise<number> {
  const scope = {
    siteId: page.siteId,
    host: page.host,
    path: page.path,
    viewport: page.viewport,
  };
  const maps = await db.siteUiMap.findMany({
    where: scope,
    select: { source: true, elements: true },
  });
  const merged = mergeUiSnapshots(
    maps.flatMap((m) => {
      const source = parseUiSource(m.source);
      return source ? [{ source, elements: cleanUiSnapshot(m.elements) }] : [];
    }),
  );
  const rows = await db.siteUiElement.findMany({ where: scope });
  const byKey = new Map<string, ElementRow>();
  const byCandidate = new Map<string, ElementRow[]>();
  for (const r of rows) {
    byKey.set(r.elementKey, r);
    const cs = Array.isArray(r.candidates)
      ? (r.candidates as unknown as UiSelectorCandidate[])
      : [];
    for (const k of new Set(candidateKeys(cs, r.tag as UiElementTag))) {
      byCandidate.set(k, [...(byCandidate.get(k) ?? []), r]);
    }
  }
  const used = new Set<string>();
  const resetViewports = viewportsConfirmedBy(page.viewport);
  const resetIds: string[] = [];
  for (const m of merged) {
    let row = byKey.get(m.key);
    if (row && used.has(row.id)) row = undefined;
    if (!row) {
      const hits = new Set<ElementRow>();
      for (const k of candidateKeys(m.candidates, m.tag)) {
        for (const r of byCandidate.get(k) ?? []) {
          if (!used.has(r.id)) hits.add(r);
        }
      }
      if (hits.size === 1) row = [...hits][0];
    }
    const data = mergedData(m, page.hostId);
    const isSeen =
      !!seen &&
      candidateKeys(m.candidates, m.tag).some((k) => seen.keys.has(k));
    if (row) {
      used.add(row.id);
      const confirm = isSeen && seen!.confirms;
      if (sameData(row, data) && !isSeen) continue;
      await db.siteUiElement.update({
        where: { id: row.id },
        data: {
          ...data,
          ...(isSeen ? { lastSeenAt: now } : {}),
          ...(confirm ? resetFor(resetViewports) : {}),
        },
      });
      if (confirm) resetIds.push(row.id);
    } else {
      try {
        await db.siteUiElement.create({
          data: {
            ...data,
            ...scope,
            accountId: page.accountId,
            firstSeenAt: now,
            lastSeenAt: now,
          },
        });
      } catch (e) {
        // Параллельная пересборка той же страницы уже создала строку —
        // следующая пересборка сведёт поля.
        if (
          !(e instanceof Prisma.PrismaClientKnownRequestError) ||
          e.code !== 'P2002'
        )
          throw e;
      }
    }
  }
  const gone = rows.filter((r) => !used.has(r.id)).map((r) => r.id);
  if (gone.length) {
    await db.siteUiElement.deleteMany({ where: { id: { in: gone } } });
  }
  if (resetIds.length) {
    // Подтверждено браузером — прежние промахи этого вида больше не
    // считаются; те же посетители смогут сообщить о промахе снова.
    await db.siteUiElementMiss.deleteMany({
      where: {
        elementRowId: { in: resetIds },
        viewport: { in: resetViewports },
      },
    });
  }
  return merged.length;
}

// ── Сводка (кабинет, TMA) и чтение для QA ───────────────────────────────

export interface UiMapStaleElementView {
  label: string;
  tag: string;
  /** Вид, для которого элемент устарел: desktop | mobile | both. */
  viewport: 'desktop' | 'mobile' | 'both';
  staleAt: string;
}

export interface UiMapPageView {
  host: string;
  path: string;
  viewports: UiMapViewport[];
  sources: UiMapSource[];
  elements: number;
  staleElements: number;
  stale: UiMapStaleElementView[];
  lastCapturedAt: string | null;
}

export interface UiMapSummaryView {
  siteId: string;
  pages: number;
  elements: number;
  staleElements: number;
  stalePages: number;
  /** Страниц по источникам (страница с двумя источниками — в обоих). */
  bySource: Partial<Record<UiMapSource, number>>;
  /** Устойчивость слитых элементов: доля надёжных — «разметьте data-assist-id». */
  byStability: Record<UiStability, number>;
  lastCapturedAt: string | null;
  /** Страницы: сначала с устаревшими элементами, затем свежие (≤ 50). */
  items: UiMapPageView[];
  /** Страниц больше, чем в `items`. */
  truncated: boolean;
}

const PAGE_ITEMS = 50;
const STALE_PER_PAGE = 5;
/** Устаревших строк в сводку (на страницу — счёт по ним). */
const STALE_ROWS_MAX = 2000;

export async function uiMapSummary(
  db: UiMapDb,
  siteId: string,
): Promise<UiMapSummaryView> {
  const staleWhere = {
    siteId,
    OR: [{ staleDesktopAt: { not: null } }, { staleMobileAt: { not: null } }],
  };
  // Агрегаты в базе: на сайте до 1000 страниц × 120 элементов — строки
  // целиком в сводку не тянем; устаревшие — списком (их мало), с потолком.
  const [maps, perPage, perStability, staleTotal, stale] = await Promise.all([
    db.siteUiMap.findMany({
      where: { siteId },
      select: {
        host: true,
        path: true,
        source: true,
        viewport: true,
        capturedAt: true,
      },
    }),
    db.siteUiElement.groupBy({
      by: ['host', 'path'],
      where: { siteId },
      _count: { _all: true },
    }),
    db.siteUiElement.groupBy({
      by: ['stability'],
      where: { siteId },
      _count: { _all: true },
    }),
    db.siteUiElement.count({ where: staleWhere }),
    db.siteUiElement.findMany({
      where: staleWhere,
      select: {
        host: true,
        path: true,
        label: true,
        tag: true,
        staleDesktopAt: true,
        staleMobileAt: true,
      },
      orderBy: [{ sourceRank: 'asc' }, { position: 'asc' }],
      take: STALE_ROWS_MAX,
    }),
  ]);
  const pages = new Map<string, UiMapPageView & { last: Date | null }>();
  const page = (host: string, path: string) => {
    const k = `${host}\n${path}`;
    let p = pages.get(k);
    if (!p) {
      p = {
        host,
        path,
        viewports: [],
        sources: [],
        elements: 0,
        staleElements: 0,
        stale: [],
        lastCapturedAt: null,
        last: null,
      };
      pages.set(k, p);
    }
    return p;
  };
  const bySource: Partial<Record<UiMapSource, number>> = {};
  let last: Date | null = null;
  for (const m of maps) {
    const p = page(m.host, m.path);
    const v = m.viewport as UiMapViewport;
    const s = parseUiSource(m.source);
    if (!p.viewports.includes(v)) p.viewports.push(v);
    if (s && !p.sources.includes(s)) {
      p.sources.push(s);
      bySource[s] = (bySource[s] ?? 0) + 1;
    }
    if (!p.last || m.capturedAt > p.last) p.last = m.capturedAt;
    if (!last || m.capturedAt > last) last = m.capturedAt;
  }
  let elements = 0;
  for (const g of perPage) {
    page(g.host, g.path).elements = g._count._all;
    elements += g._count._all;
  }
  const byStability: Record<UiStability, number> = {
    strong: 0,
    medium: 0,
    fragile: 0,
  };
  for (const g of perStability) {
    if (g.stability in byStability)
      byStability[g.stability as UiStability] = g._count._all;
  }
  for (const e of stale) {
    const p = page(e.host, e.path);
    p.staleElements++;
    const d = e.staleDesktopAt;
    const mo = e.staleMobileAt;
    if (p.stale.length < STALE_PER_PAGE && (d || mo)) {
      const at = d && mo ? (d > mo ? d : mo) : (d ?? mo)!;
      p.stale.push({
        label: e.label,
        tag: e.tag,
        viewport: d && mo ? 'both' : d ? 'desktop' : 'mobile',
        staleAt: at.toISOString(),
      });
    }
  }
  const staleElements = staleTotal;
  const all = [...pages.values()].sort(
    (a, b) =>
      b.staleElements - a.staleElements ||
      (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0) ||
      a.host.localeCompare(b.host) ||
      a.path.localeCompare(b.path),
  );
  return {
    siteId,
    pages: all.length,
    elements,
    staleElements,
    stalePages: all.filter((p) => p.staleElements > 0).length,
    bySource,
    byStability,
    lastCapturedAt: last ? last.toISOString() : null,
    items: all.slice(0, PAGE_ITEMS).map(({ last: l, ...p }) => ({
      ...p,
      viewports: [...p.viewports].sort(),
      sources: [...p.sources].sort(),
      lastCapturedAt: l ? l.toISOString() : null,
    })),
    truncated: all.length > PAGE_ITEMS,
  };
}

export interface UiMapQaElement {
  elementId: string;
  key: string;
  viewport: UiMapViewport;
  tag: string;
  label: string;
  role: string | null;
  selector: string | null;
  candidates: UiSelectorCandidate[];
  stability: string;
  confidence: number;
  sources: string[];
  lastSeenAt: string;
  missCountDesktop: number;
  missCountMobile: number;
  staleDesktopAt: string | null;
  staleMobileAt: string | null;
}

/**
 * Страница карты для Flow-QA: слитые элементы (все виды или один) с
 * кандидатами и признаками устаревания, и текущие снимки источников
 * (версия, вид, когда сняты). «Селектор изменился» — находка QA, а не
 * молчаливое само-лечение (QA-ТЗ §3.5): поэтому QA видит и промахи.
 */
export async function uiMapPageForQa(
  db: UiMapDb,
  siteId: string,
  host: string,
  path: string,
  viewport: UiMapViewport | null,
) {
  const where = {
    siteId,
    host: uiMapHost(host),
    path,
    ...(viewport ? { viewport } : {}),
  };
  const [maps, rows] = await Promise.all([
    db.siteUiMap.findMany({
      where,
      select: {
        source: true,
        viewport: true,
        version: true,
        capturedAt: true,
        elementsHash: true,
      },
      orderBy: [{ viewport: 'asc' }, { source: 'asc' }],
    }),
    db.siteUiElement.findMany({
      where,
      orderBy: [
        { viewport: 'asc' },
        { sourceRank: 'asc' },
        { position: 'asc' },
      ],
    }),
  ]);
  return {
    host: where.host,
    path,
    snapshots: maps.map((m) => ({
      source: m.source,
      viewport: m.viewport,
      version: m.version,
      capturedAt: m.capturedAt.toISOString(),
      hash: m.elementsHash,
    })),
    elements: rows.map((r): UiMapQaElement => ({
      elementId: r.elementId,
      key: r.elementKey,
      viewport: r.viewport as UiMapViewport,
      tag: r.tag,
      label: r.label,
      role: r.role,
      selector: r.selector,
      candidates: Array.isArray(r.candidates)
        ? (r.candidates as unknown as UiSelectorCandidate[])
        : [],
      stability: r.stability,
      confidence: r.confidence,
      sources: r.sources,
      lastSeenAt: r.lastSeenAt.toISOString(),
      missCountDesktop: r.missCountDesktop,
      missCountMobile: r.missCountMobile,
      staleDesktopAt: r.staleDesktopAt?.toISOString() ?? null,
      staleMobileAt: r.staleMobileAt?.toISOString() ?? null,
    })),
  };
}

/** Страницы карты сайта для QA (без элементов), ≤ 1000. */
export async function uiMapPagesForQa(db: UiMapDb, siteId: string) {
  const s = await uiMapSummary(db, siteId);
  return {
    siteId,
    pages: s.pages,
    staleElements: s.staleElements,
    items: s.items.map((p) => ({
      host: p.host,
      path: p.path,
      viewports: p.viewports,
      sources: p.sources,
      elements: p.elements,
      staleElements: p.staleElements,
      lastCapturedAt: p.lastCapturedAt,
    })),
    truncated: s.truncated,
  };
}

// ── Обслуживание (крон) ──────────────────────────────────────────────────

export interface UiMapMaintenanceResult {
  /** Строк истории удалено (сверх числа и по сроку). */
  versionsDeleted: number;
  missesDeleted: number;
  staleExpired: number;
  pagesRebuilt: number;
}

/**
 * Ретенция истории и журнала промахов, срок отметки «устарел», достройка
 * слитых элементов для снимков без них (карты, принятые до Ш4). Системный
 * клиент — по всем кабинетам; достройка — клиентом тенанта строки.
 */
export async function runUiMapMaintenance(
  system: PrismaService,
  forAccount: (accountId: string) => UiMapDb,
  now: Date,
): Promise<UiMapMaintenanceResult> {
  const historyCut = new Date(
    now.getTime() - UI_MAP_SHARED.historyDays * 86_400_000,
  );
  const missCut = new Date(now.getTime() - UI_MAP_STALE.windowMs);
  const staleCut = new Date(now.getTime() - UI_MAP_STALE.staleTtlMs);
  // Текущую версию снимка не удаляем никогда; старше срока или сверх N — да.
  const byAge = await system.$executeRaw`
    DELETE FROM "sites"."site_ui_map_versions" v
     WHERE v."createdAt" < ${historyCut}::timestamp(3)
       AND NOT EXISTS (
         SELECT 1 FROM "sites"."site_ui_maps" m
          WHERE m."siteId" = v."siteId" AND m."host" = v."host" AND m."path" = v."path"
            AND m."source" = v."source" AND m."viewport" = v."viewport"
            AND m."version" = v."version")`;
  const byCount = await system.$executeRaw`
    DELETE FROM "sites"."site_ui_map_versions" v
     USING (
       SELECT "id", row_number() OVER (
                PARTITION BY "siteId", "host", "path", "source", "viewport"
                ORDER BY "version" DESC) AS rn
         FROM "sites"."site_ui_map_versions") x
     WHERE v."id" = x."id" AND x.rn > ${UI_MAP_SHARED.versionsPerMap}`;
  const misses = await system.$executeRaw`
    DELETE FROM "sites"."site_ui_element_misses"
     WHERE "createdAt" < ${missCut}::timestamp(3)`;
  const staleD = await system.$executeRaw`
    UPDATE "sites"."site_ui_elements"
       SET "staleDesktopAt" = NULL, "missCountDesktop" = 0, "missSinceDesktop" = NULL
     WHERE "staleDesktopAt" < ${staleCut}::timestamp(3)`;
  const staleM = await system.$executeRaw`
    UPDATE "sites"."site_ui_elements"
       SET "staleMobileAt" = NULL, "missCountMobile" = 0, "missSinceMobile" = NULL
     WHERE "staleMobileAt" < ${staleCut}::timestamp(3)`;
  const pending = await system.$queryRaw<
    Array<{
      accountId: string;
      siteId: string;
      hostId: string;
      host: string;
      path: string;
      viewport: string;
    }>
  >`
    SELECT p."accountId", p."siteId", p."hostId", p."host", p."path", p."viewport"
      FROM (
        SELECT DISTINCT ON (m."siteId", m."host", m."path", m."viewport")
               m."accountId", m."siteId", m."hostId", m."host", m."path",
               m."viewport", m."capturedAt"
          FROM "sites"."site_ui_maps" m
         WHERE NOT EXISTS (
           SELECT 1 FROM "sites"."site_ui_elements" e
            WHERE e."siteId" = m."siteId" AND e."host" = m."host"
              AND e."path" = m."path" AND e."viewport" = m."viewport")
         ORDER BY m."siteId", m."host", m."path", m."viewport", m."capturedAt" DESC
      ) p
     ORDER BY p."capturedAt" DESC
     LIMIT ${UI_MAP_SHARED.backfillPerRun}`;
  let rebuilt = 0;
  for (const p of pending) {
    const viewport = p.viewport as UiMapViewport;
    const db = forAccount(p.accountId);
    const scope = {
      siteId: p.siteId,
      host: p.host,
      path: p.path,
      viewport,
    };
    // Снимок, в котором после чистки нет ни одного элемента, бесполезен и
    // подсветке (старое чтение дало бы то же «ничего»): снимаем его, как
    // приём пустого набора, — иначе страница вечно стояла бы в очереди.
    const maps = await db.siteUiMap.findMany({
      where: scope,
      select: { id: true, elements: true },
    });
    const empty = maps
      .filter((m) => cleanUiSnapshot(m.elements).length === 0)
      .map((m) => m.id);
    if (empty.length) {
      await db.siteUiMap.deleteMany({ where: { id: { in: empty } } });
    }
    if ((await syncMergedElements(db, { ...p, viewport }, now, null)) > 0)
      rebuilt++;
  }
  return {
    versionsDeleted: byAge + byCount,
    missesDeleted: misses,
    staleExpired: staleD + staleM,
    pagesRebuilt: rebuilt,
  };
}
