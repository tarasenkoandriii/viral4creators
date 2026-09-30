/**
 * UiSnapshotQueryService — чтение истории снимков крона `ui-snapshot-run`
 * для админки (вкладка «Система → Снимки интерфейса»).
 *
 * Зачем: крон пишет строку `UiSnapshot` на каждый маршрут каждые две
 * минуты, а оператор до сих пор видел только тревогу «изменилось» в
 * служебном канале — без картинки и без того, с чем сравнивали. Понять,
 * какой экран «мигает» (меняется от тика к тику без правок кода), можно
 * было только запросом в базу.
 *
 * ## Картинки
 *
 * Отдельных выдач ссылок не нужно: раннер заливает PNG через
 * `BlobService.uploadBuffer`, а он создаёт блобы с `access: 'public'`,
 * и путь у каждого снимка свой (`qa-snapshots/<маршрут>/<локаль>/<тема>/
 * <Date.now()>.png`) — файл не перезаписывается, и предыдущий снимок
 * всегда лежит по своему адресу (`comparedToUrl` у строки). Поэтому
 * здесь отдаются адреса как есть — тот же приём, что у кадров
 * «Обучалок по сайтам».
 *
 * ## Предыдущий снимок
 *
 * Для `changed`-снимка нужен не только адрес картинки, с которой
 * сравнивали (он есть в `comparedToUrl`), но и её время — иначе
 * оператор не видит, между какими тиками произошла перемена. Ищем его
 * по тому же правилу, по которому его выбрал раннер: последняя строка
 * той же комбинации маршрут+локаль+тема без ошибки, раньше этой.
 * Запрос идёт по индексу `(routeKey, locale, theme, createdAt)` и
 * только для изменившихся снимков страницы — их единицы.
 *
 * ## Срок хранения
 *
 * Суточный `cleanup-sessions` убирает снимки по сроку
 * (`ui-snapshot-retention.ts`): обычные — через 3 дня, «изменилось» —
 * через 30, и вместе с каждым хранимым «изменилось» хранит строку,
 * которую найдёт правило «предыдущего» выше. Поэтому пара «было → стало»
 * здесь не распадается и не подменяется более старой строкой; а вот
 * сводка за 7/30 дней видит обычные снимки и сбои только за последние
 * 3 дня. Меняя правило поиска «предыдущего», меняйте и уборку.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { parseCursorParam, parseIsoParam } from '../cron/cron-history-query';
import { UI_SNAPSHOT_PLAIN_RETENTION_DAYS } from './ui-snapshot-retention';

export const SNAPSHOTS_DEFAULT_LIMIT = 30;
export const SNAPSHOTS_MAX_LIMIT = 100;
/** Сводка без `since` — за последние сутки. */
export const SNAPSHOT_SUMMARY_DEFAULT_SPAN_MS = 24 * 3_600_000;
/** Потолок периода сводки: крон пишет ~720 строк в сутки на маршрут, и
 * сводка за всю историю — лишняя нагрузка без пользы для вопроса
 * «что мигает сейчас». */
export const SNAPSHOT_SUMMARY_MAX_SPAN_DAYS = 30;
/** Допуск к потолку периода: клиент считает `since = сейчас − 30 дней`
 * по СВОИМ часам и до отправки запроса, а сервер сверяет со своим, уже
 * более поздним «сейчас» — без допуска «30 дней» почти всегда давали
 * 400. Пять минут покрывают и задержку запроса, и расхождение часов. */
export const SNAPSHOT_SUMMARY_SPAN_GRACE_MS = 5 * 60_000;
/** Сколько последних времён «изменилось» показывать на маршрут. */
export const SUMMARY_RECENT_CHANGED = 5;
/** Сколько символов отпечатка отдавать: полный составной хэш — это ещё
 * и сетка яркостей на сотни символов, глазу нужен только dHash. */
export const DIFF_HASH_SHORT_LENGTH = 16;

export interface UiSnapshotListQuery {
  routeKey?: string;
  since?: Date;
  limit: number;
  before?: string;
  changedOnly: boolean;
}

export interface UiSnapshotPreviousView {
  id: string;
  createdAt: Date;
  blobUrl: string | null;
}

export interface UiSnapshotView {
  id: string;
  routeKey: string;
  locale: string;
  theme: string;
  createdAt: Date;
  changed: boolean;
  diffScore: number | null;
  blobUrl: string | null;
  comparedToUrl: string | null;
  /** Первые символы dHash; `null`, если отпечатка нет (сбой снимка). */
  diffHash: string | null;
  error: string | null;
  /** Только у `changed`-снимков: с чем сравнивали. `null` — строка
   * предыдущего снимка не нашлась (например, удалена вручную); адрес
   * картинки тогда всё равно есть в `comparedToUrl`. */
  previous: UiSnapshotPreviousView | null;
}

export interface UiSnapshotListResult {
  items: UiSnapshotView[];
  /** Курсор следующей страницы (`before`); `null` — дальше строк нет. */
  nextBefore: string | null;
}

export interface UiSnapshotRouteSummary {
  routeKey: string;
  total: number;
  changed: number;
  errors: number;
  lastAt: Date | null;
  /** Последние времена «изменилось», от новых к старым. */
  recentChangedAt: Date[];
}

export interface UiSnapshotSummary {
  since: Date;
  routes: UiSnapshotRouteSummary[];
  /** Сколько дней хранятся обычные (не «изменилось») снимки
   * (`ui-snapshot-retention.ts`): за период длиннее этого `total` и
   * `errors` считают только последние дни, а `changed` — весь период.
   * Отдаётся, чтобы подпись на странице не держала своё число. */
  plainRetentionDays: number;
}

interface SnapshotRow {
  id: string;
  routeKey: string;
  locale: string;
  theme: string;
  createdAt: Date;
  changed: boolean;
  diffScore: number | null;
  blobUrl: string | null;
  comparedToUrl: string | null;
  diffHash: string | null;
  error: string | null;
}

/** Имя маршрута — `route.name` из `frontend/src/lib/router.ts`:
 * латиница, цифры, дефис. Шире не пускаем: это уходит в `where`. */
const ROUTE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function shortDiffHash(hash: string | null): string | null {
  if (!hash) return null;
  return hash.split(':')[0].slice(0, DIFF_HASH_SHORT_LENGTH);
}

export function parseSnapshotListQuery(raw: {
  route?: string;
  since?: string;
  limit?: string;
  before?: string;
  changed?: string;
}): UiSnapshotListQuery {
  let routeKey: string | undefined;
  if (raw.route !== undefined && raw.route !== '') {
    if (!ROUTE_KEY_RE.test(raw.route)) {
      throw new BadRequestException(
        'route: имя маршрута — латиница, цифры и дефис',
      );
    }
    routeKey = raw.route;
  }
  let limit = SNAPSHOTS_DEFAULT_LIMIT;
  if (raw.limit !== undefined && raw.limit !== '') {
    if (!/^\d+$/.test(raw.limit) || Number(raw.limit) < 1) {
      throw new BadRequestException('limit: ожидается целое число ≥ 1');
    }
    limit = Math.min(Number(raw.limit), SNAPSHOTS_MAX_LIMIT);
  }
  let changedOnly = false;
  if (raw.changed !== undefined && raw.changed !== '') {
    if (raw.changed !== 'true' && raw.changed !== 'false') {
      throw new BadRequestException('changed: ожидается true или false');
    }
    changedOnly = raw.changed === 'true';
  }
  return {
    routeKey,
    since: parseIsoParam('since', raw.since),
    limit,
    before: parseCursorParam(raw.before),
    changedOnly,
  };
}

export function parseSnapshotSummarySince(
  raw: string | undefined,
  now: Date = new Date(),
): Date {
  const since =
    parseIsoParam('since', raw) ??
    new Date(now.getTime() - SNAPSHOT_SUMMARY_DEFAULT_SPAN_MS);
  if (since.getTime() >= now.getTime()) {
    throw new BadRequestException('since должен быть в прошлом');
  }
  if (
    now.getTime() - since.getTime() >
    SNAPSHOT_SUMMARY_MAX_SPAN_DAYS * 86_400_000 + SNAPSHOT_SUMMARY_SPAN_GRACE_MS
  ) {
    throw new BadRequestException(
      `период сводки не длиннее ${SNAPSHOT_SUMMARY_MAX_SPAN_DAYS} дней`,
    );
  }
  return since;
}

@Injectable()
export class UiSnapshotQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Лента снимков, новые сверху. Порядок `createdAt desc, id desc` и
   * курсор `before` = id последней строки предыдущей страницы — тот же
   * приём, что у истории кронов (`AdminCronService.getHistory`).
   */
  async list(query: UiSnapshotListQuery): Promise<UiSnapshotListResult> {
    const where: Record<string, unknown> = {};
    if (query.routeKey) where.routeKey = query.routeKey;
    if (query.since) where.createdAt = { gte: query.since };
    if (query.changedOnly) where.changed = true;

    const fetched = (await this.prisma.uiSnapshot.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // На одну строку больше страницы: так последняя страница видна
      // без лишнего запроса — `nextBefore` не выдаётся, если дальше
      // строк нет (раньше полная последняя страница давала курсор на
      // пустую следующую).
      take: query.limit + 1,
      ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
    })) as SnapshotRow[];
    const hasMore = fetched.length > query.limit;
    const rows = hasMore ? fetched.slice(0, query.limit) : fetched;

    const previousById = new Map<string, UiSnapshotPreviousView | null>();
    await Promise.all(
      rows
        .filter((r) => r.changed)
        .map(async (r) => {
          const prev = (await this.prisma.uiSnapshot.findFirst({
            where: {
              routeKey: r.routeKey,
              locale: r.locale,
              theme: r.theme,
              error: null,
              createdAt: { lt: r.createdAt },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true, createdAt: true, blobUrl: true },
          })) as UiSnapshotPreviousView | null;
          previousById.set(r.id, prev ?? null);
        }),
    );

    const items: UiSnapshotView[] = rows.map((r) => ({
      id: r.id,
      routeKey: r.routeKey,
      locale: r.locale,
      theme: r.theme,
      createdAt: r.createdAt,
      changed: r.changed,
      diffScore: r.diffScore,
      blobUrl: r.blobUrl,
      comparedToUrl: r.comparedToUrl,
      diffHash: shortDiffHash(r.diffHash),
      error: r.error,
      previous: previousById.get(r.id) ?? null,
    }));

    return {
      items,
      nextBefore: hasMore ? rows[rows.length - 1].id : null,
    };
  }

  /**
   * Сводка по маршрутам за период: сколько снимков, сколько из них
   * «изменилось», сколько не удалось снять, и когда менялось последний
   * раз. Счётчики — на стороне БД (`groupBy`): за сутки это ~720 строк
   * на маршрут, тащить их в процесс ради чисел незачем.
   */
  async summary(since: Date): Promise<UiSnapshotSummary> {
    const range = { gte: since };
    const [all, changed, errors] = await Promise.all([
      this.prisma.uiSnapshot.groupBy({
        by: ['routeKey'],
        where: { createdAt: range },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.prisma.uiSnapshot.groupBy({
        by: ['routeKey'],
        where: { createdAt: range, changed: true },
        _count: { _all: true },
      }),
      this.prisma.uiSnapshot.groupBy({
        by: ['routeKey'],
        where: { createdAt: range, error: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const countOf = (
      groups: Array<{ routeKey: string; _count: { _all: number } }>,
      routeKey: string,
    ) => groups.find((g) => g.routeKey === routeKey)?._count._all ?? 0;

    const changedGroups = changed as Array<{
      routeKey: string;
      _count: { _all: number };
    }>;
    const errorGroups = errors as Array<{
      routeKey: string;
      _count: { _all: number };
    }>;

    const routes = await Promise.all(
      (
        all as Array<{
          routeKey: string;
          _count: { _all: number };
          _max: { createdAt: Date | null };
        }>
      ).map(async (g) => {
        const changedCount = countOf(changedGroups, g.routeKey);
        const recent =
          changedCount > 0
            ? ((await this.prisma.uiSnapshot.findMany({
                where: {
                  routeKey: g.routeKey,
                  changed: true,
                  createdAt: range,
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: SUMMARY_RECENT_CHANGED,
                select: { createdAt: true },
              })) as Array<{ createdAt: Date }>)
            : [];
        return {
          routeKey: g.routeKey,
          total: g._count._all,
          changed: changedCount,
          errors: countOf(errorGroups, g.routeKey),
          lastAt: g._max.createdAt ?? null,
          recentChangedAt: recent.map((r) => r.createdAt),
        };
      }),
    );

    // «Мигающие» — наверх: оператор открывает вкладку ради них.
    routes.sort(
      (a, b) => b.changed - a.changed || a.routeKey.localeCompare(b.routeKey),
    );
    return {
      since,
      routes,
      plainRetentionDays: UI_SNAPSHOT_PLAIN_RETENTION_DAYS,
    };
  }
}
