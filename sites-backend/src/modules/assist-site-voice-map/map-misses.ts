/**
 * Промахи Т-4 по целям голосовой карты за 7 дней — «Обучение → Голос»
 * в TMA (Э6-тер (12), заход 9; ТЗ §5-кватер.10 «Т-4 мониторинг», §4-тер.5):
 *   GET /assist/sites/:id/voice-map/site/misses
 * По журналу шагов (`assist_site_ui_action_log`, поле `mapKey`) на цель:
 *  - «нажмите сами» — шаг цели закончился `manual`/`failed` (не «нет цели»);
 *  - «цель не найдена» — шаг цели `manual`/`failed` с причиной `no_target`;
 *  - «не туда» — стоп человеком (кнопка, Esc, голос, свой клик) ≤ 5 с после
 *    исполненного шага этой цели (то же окно, что монитор Т-4);
 *  - «выполнено» — для доли.
 *  - «промах карты» — команда назвала цель, а в снимке её не было
 *    (`mapMiss` с ключом названной цели — его пишет план, аудит B);
 * плюс страницы таких промахов (и старых строк без ключа). Кнопка
 * «Открыть в редакторе» в TMA — ссылка редактора с `focus=<ключ>` на
 * странице последнего промаха. Т-3 (находки воркера) — когда будет воркер.
 * Только чтение журнала основной ролью с тенантом; подписей и значений нет.
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import { loadAssistSite } from '../assist-site-setup/widget-settings.service';
import type { AccountMembership } from '../site-core/account/roles';

export const MAP_MISSES_LIMITS = {
  windowMs: 7 * 86_400_000,
  /** «Не туда» — стоп человеком не позже 5 с после шага (монитор Т-4). */
  wrongWindowMs: 5_000,
  rows: 20_000,
  items: 50,
  /** №113 (заход 11): все цели с шагами — для тепловых значков редактора. */
  allItems: 500,
  pages: 20,
} as const;

export interface MapMissRow {
  planId: string;
  action: string;
  result: string;
  reason: string | null;
  mapKey: string | null;
  mapMiss: boolean;
  url: string | null;
  createdAt: Date;
}

export interface MapMissItem {
  key: string;
  /** Путь страницы последнего шага этой цели (для ссылки редактора). */
  page: string | null;
  self: number;
  notFound: number;
  wrong: number;
  /** Команда назвала эту цель карты, а на странице её не нашлось (`mapMiss`). */
  missed: number;
  done: number;
  last: string;
}

export interface MapMissesView {
  days: number;
  items: MapMissItem[];
  /** Команда назвала цель карты, а на странице её не нашлось. */
  pages: Array<{ page: string; misses: number; last: string }>;
}

const SERVICE = new Set([
  'plan',
  'confirm',
  'violation',
  'refused',
  'stop',
  'undo',
]);
const HUMAN_STOP = new Set(['click', 'esc', 'voice', 'button']);

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith('/') ? url.split('?')[0] : null;
  }
}

/**
 * «Не туда» (№113, заход 11 — общий разбор для свёртки и «перепривязать»):
 * на план — стоп человеком и последний исполненный шаг цели карты не
 * раньше чем за 5 с до него. Строки — по времени.
 */
function wrongSteps(sorted: readonly MapMissRow[]): MapMissRow[] {
  const plans = new Map<string, MapMissRow[]>();
  for (const r of sorted) {
    const list = plans.get(r.planId) ?? [];
    list.push(r);
    plans.set(r.planId, list);
  }
  const out: MapMissRow[] = [];
  for (const list of plans.values()) {
    const stop = list.find(
      (r) =>
        r.action === 'stop' && r.reason !== null && HUMAN_STOP.has(r.reason),
    );
    if (!stop) continue;
    const t = stop.createdAt.getTime();
    const prev = list
      .filter(
        (r) =>
          r.mapKey &&
          r.result === 'done' &&
          !SERVICE.has(r.action) &&
          r.createdAt.getTime() <= t &&
          t - r.createdAt.getTime() <= MAP_MISSES_LIMITS.wrongWindowMs,
      )
      .pop();
    if (prev) out.push(prev);
  }
  return out;
}

const byTime = (rows: readonly MapMissRow[]) =>
  [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

/**
 * №113 (заход 11): планы «не туда» по целям — для панели редактора
 * («команда → цель A, человек сразу остановил» → перепривязать фразу).
 * `multi` (аудит P3-9 (г)) — в плане шаги НЕСКОЛЬКИХ целей карты
 * («додай в кошик і перейди до оплати»): фраза команды целиком не про
 * последнюю цель — такие планы в «перепривязать» не идут.
 */
export function mapMissWrongs(
  rows: readonly MapMissRow[],
): Array<{ key: string; planId: string; multi: boolean }> {
  const keys = new Map<string, Set<string>>();
  for (const r of rows)
    if (r.mapKey && !r.mapMiss && !SERVICE.has(r.action)) {
      const k = keys.get(r.planId) ?? new Set<string>();
      k.add(r.mapKey);
      keys.set(r.planId, k);
    }
  return wrongSteps(byTime(rows)).map((r) => ({
    key: r.mapKey as string,
    planId: r.planId,
    multi: (keys.get(r.planId)?.size ?? 0) > 1,
  }));
}

/**
 * Свёртка журнала по целям карты (чистая функция; строки — любого порядка).
 * `all` (№113, заход 11, тепловые значки редактора) — и цели только с
 * «выполнено» (сколько раз цель просили), до 500.
 */
export function mapMissStats(
  rows: readonly MapMissRow[],
  opts: { all?: boolean } = {},
): MapMissesView {
  const byKey = new Map<string, MapMissItem>();
  const pages = new Map<
    string,
    { page: string; misses: number; last: string }
  >();
  const sorted = byTime(rows);
  const item = (r: MapMissRow): MapMissItem => {
    const k = r.mapKey as string;
    let it = byKey.get(k);
    if (!it) {
      it = {
        key: k,
        page: null,
        self: 0,
        notFound: 0,
        wrong: 0,
        missed: 0,
        done: 0,
        last: r.createdAt.toISOString(),
      };
      byKey.set(k, it);
    }
    it.page = pathOf(r.url) ?? it.page;
    it.last = r.createdAt.toISOString();
    return it;
  };
  for (const r of sorted) {
    if (r.mapMiss) {
      const p = pathOf(r.url) ?? '/';
      const pg = pages.get(p) ?? { page: p, misses: 0, last: '' };
      pg.misses++;
      pg.last = r.createdAt.toISOString();
      pages.set(p, pg);
    }
    // Промах карты по ключу — строка плана (служебная), считается отдельно.
    if (r.mapMiss && r.mapKey) item(r).missed++;
    if (!r.mapKey || SERVICE.has(r.action)) continue;
    const it = item(r);
    if (r.result === 'done') it.done++;
    else if (r.result === 'manual' || r.result === 'failed') {
      if (r.reason === 'no_target') it.notFound++;
      else it.self++;
    }
  }
  for (const prev of wrongSteps(sorted)) item(prev).wrong++;
  const bad = (x: MapMissItem) => x.self + x.notFound + x.wrong + x.missed;
  return {
    days: Math.round(MAP_MISSES_LIMITS.windowMs / 86_400_000),
    items: [...byKey.values()]
      .filter((x) => bad(x) > 0 || (opts.all && x.done > 0))
      .sort((a, b) => bad(b) - bad(a) || a.key.localeCompare(b.key))
      .slice(
        0,
        opts.all ? MAP_MISSES_LIMITS.allItems : MAP_MISSES_LIMITS.items,
      ),
    pages: [...pages.values()]
      .sort((a, b) => b.misses - a.misses || a.page.localeCompare(b.page))
      .slice(0, MAP_MISSES_LIMITS.pages),
  };
}

@Injectable()
export class MapMissesService {
  now: () => Date = () => new Date();

  constructor(private readonly sitesDb: SitesDb) {}

  async misses(m: AccountMembership, siteId: string): Promise<MapMissesView> {
    await loadAssistSite(
      this.sitesDb.forAccount(m.accountId),
      m.accountId,
      siteId,
    );
    return this.statsFor(m.accountId, siteId);
  }

  /**
   * Свёртка за 7 дней без проверки права — для вызывающих, кто его уже
   * проверил (сессия редактора `we.`, режим «Промахи», №113, заход 10).
   */
  async statsFor(accountId: string, siteId: string): Promise<MapMissesView> {
    return mapMissStats(await this.rowsFor(accountId, siteId));
  }

  /**
   * №113 (заход 11) — для панели редактора: свёртка по ВСЕМ целям с шагами
   * (тепловые значки: сколько раз просили) и планы «не туда» по целям
   * («перепривязать»). Право проверено вызывающим (сессия редактора).
   */
  async detailFor(
    accountId: string,
    siteId: string,
  ): Promise<{
    view: MapMissesView;
    wrongs: Array<{ key: string; planId: string; multi: boolean }>;
  }> {
    const rows = await this.rowsFor(accountId, siteId);
    return {
      view: mapMissStats(rows, { all: true }),
      wrongs: mapMissWrongs(rows),
    };
  }

  /** Строки журнала за 7 дней: планы с целью карты — целиком (стоп человеком). */
  private async rowsFor(
    accountId: string,
    siteId: string,
  ): Promise<MapMissRow[]> {
    const db = this.sitesDb.forAccount(accountId);
    const since = new Date(this.now().getTime() - MAP_MISSES_LIMITS.windowMs);
    const keyed = await db.assistSiteUiActionLog.findMany({
      where: {
        siteId,
        createdAt: { gte: since },
        OR: [{ mapKey: { not: null } }, { mapMiss: true }],
      },
      select: { planId: true },
      orderBy: { createdAt: 'desc' },
      take: MAP_MISSES_LIMITS.rows,
    });
    const planIds = [...new Set(keyed.map((r) => r.planId))].slice(0, 2000);
    if (!planIds.length) return [];
    // Стоп человеком — строка плана без `mapKey`: берём планы целиком.
    return db.assistSiteUiActionLog.findMany({
      where: { siteId, planId: { in: planIds } },
      select: {
        planId: true,
        action: true,
        result: true,
        reason: true,
        mapKey: true,
        mapMiss: true,
        url: true,
        createdAt: true,
      },
      take: MAP_MISSES_LIMITS.rows,
    });
  }
}
