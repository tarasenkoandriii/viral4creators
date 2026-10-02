/**
 * Карта интерфейса для подсветки — Э6 (ТЗ помощника §4.9 `highlight`,
 * §4.12 «показать на экране»). Под ролью `assist_public`.
 *
 *  - `pageUiElements` — элементы карты страницы посетителя: URL — только с
 *    хоста сайта (недоверенные данные, §4.6 п.5), ключ — хост + путь
 *    (site-core/ui-map). Источники сливаются: раунды обучалки (видела
 *    страницу в браузере) — первыми, затем обход; дубли по id — вон.
 *  - `markUiMapStale` — сигнал «карта устарела»: загрузчик не нашёл
 *    элемент на странице (вёрстка сменилась). Условный UPDATE: только
 *    карта этого сайта и этой страницы, в которой такой элемент ЕСТЬ —
 *    мусорный id ничего не трогает.
 */
import { Prisma } from '@prisma/client';
import type { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import {
  UI_ELEMENT_ID_RE,
  cleanUiElements,
  uiMapHost,
  uiMapKey,
  type UiMapElement,
} from '../../site-core/ui-map/ui-map';

type MapDb = Pick<AssistPublicDb, 'siteUiMap' | '$executeRaw'>;

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

export async function pageUiElements(
  db: MapDb,
  siteId: string,
  pageUrl: string | null | undefined,
  siteHosts: string[],
): Promise<UiMapElement[]> {
  const key = visitorPageKey(pageUrl, siteHosts);
  if (!key) return [];
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
    // Карту писал наш код, но читаем строго: форма могла уехать (Ш4).
    for (const e of cleanUiElements(r.elements)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

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
