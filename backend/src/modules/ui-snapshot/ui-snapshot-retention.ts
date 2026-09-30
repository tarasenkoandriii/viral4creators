/**
 * Срок хранения снимков крон-обхода интерфейса (`ui-snapshot-run`).
 *
 * ## Зачем
 *
 * Крон снимает пять маршрутов каждые две минуты: строка `UiSnapshot` и
 * публичный PNG под `qa-snapshots/<маршрут>/<локаль>/<тема>/<ts>.png` —
 * около 3600 строк и файлов в сутки. Уборки не было нигде: файлы не
 * принадлежат ни сессии, ни проекту, и метла `sweep-orphans` этот префикс
 * не обходит (её области — владельцы с id в пути, см.
 * `common/orphan-sweep.ts`). Зовётся суточным кроном `cleanup-sessions`
 * под его же замком — тот же приём, что у аудиокеша советника.
 *
 * ## Что хранится
 *
 * 1. Обычный снимок (`changed = false`, в том числе строка сбоя с
 *    `error`) — `UI_SNAPSHOT_PLAIN_RETENTION_DAYS` дней: «ничего не
 *    изменилось» через неделю не нужно никому.
 * 2. Снимок «изменилось» — `UI_SNAPSHOT_CHANGED_RETENTION_DAYS` дней,
 *    И ВМЕСТЕ С НИМ тот снимок, с которым его сравнивали. Страница
 *    админки «Снимки интерфейса» показывает пару «было → стало» и ищет
 *    «было» так же, как его выбрал раннер
 *    (`UiSnapshotQueryService.list`): последняя строка той же
 *    комбинации маршрут+локаль+тема без ошибки, раньше этой. Удалить её
 *    значило бы не просто потерять картинку: запрос страницы молча нашёл
 *    бы строку ЕЩЁ старше и показал бы её как «было» — неверную пару.
 *    Поэтому защищается и эта строка, и строка с адресом из
 *    `comparedToUrl` (в штатном потоке это одна и та же строка).
 * 3. Последний снимок комбинации не удаляется никогда: последняя строка
 *    без ошибки — база следующего сравнения (`findFirst … error: null`
 *    в раннере). Если маршрут падает несколько дней подряд, база старше
 *    трёх дней, и её удаление превратило бы первый удачный снимок после
 *    починки в «первый в истории» — сравнивать не с чем, и настоящая
 *    перемена прошла бы молча. Самая последняя строка вообще (даже со
 *    сбоем) тоже остаётся — по ней видно, что маршрут ещё жив в обходе.
 * 4. Кадры лендинга и обучалки сюда не относятся: немаскированные
 *    прогоны (`greeting-frames`, `tutorial-frames`) строк `UiSnapshot` не
 *    пишут вовсе и кладут файлы под `qa-shots/`. Файл удаляется только
 *    если его путь под `qa-snapshots/` (`pathnameFromBlobUrl`). Строка с
 *    чужим адресом не трогается вовсе — ни строка, ни файл — и идёт в
 *    счётчик `failed`: штатно таких строк нет, и если они появились,
 *    оператор должен это увидеть, а не получить молча удалённые строки
 *    с вечными файлами без носителя адреса (так было бы при
 *    переименовании префикса в раннере — поэтому раннер берёт его
 *    отсюда же, `UI_SNAPSHOT_BLOB_PREFIX`).
 *
 * ## Как
 *
 * Обход идёт по комбинациям по кругу, страницами по
 * `UI_SNAPSHOT_PRUNE_BATCH` в порядке времени, по индексу
 * `(routeKey, locale, theme, createdAt)` — все запросы здесь начинаются
 * с этих трёх полей. Потолок — `UI_SNAPSHOT_PRUNE_MAX_PAGES` страниц и
 * бюджет времени: суточный джоб делит таймаут функции с уборкой сессий.
 * Остаток доберёт следующий прогон (`hasMore`).
 *
 * Файл удаляется ДО строки. Не удалось удалить файл — строка остаётся
 * (и в счётчик `failed`): она единственный носитель адреса, и без неё
 * файл стал бы вечным сиротой, которого не подберёт никто. Завтрашний
 * прогон попробует снова: `del` у Vercel Blob на уже удалённом файле не
 * падает.
 */

import type { PrismaService } from '../../prisma/prisma.service';
import type { BlobService } from '../storage/blob.service';
import { pathnameFromBlobUrl } from '../../common/blob-paths';

export const UI_SNAPSHOT_PLAIN_RETENTION_DAYS = 3;
export const UI_SNAPSHOT_CHANGED_RETENTION_DAYS = 30;
/** Префикс файлов сравниваемого обхода (`UiSnapshotRunnerService`). */
export const UI_SNAPSHOT_BLOB_PREFIX = 'qa-snapshots/';
/** Строк-кандидатов на страницу одной комбинации. */
export const UI_SNAPSHOT_PRUNE_BATCH = 500;
/** Потолок страниц за прогон: 20 × 500 = 10 000 строк при притоке ~3600
 * в сутки — накопленный хвост уходит за несколько ночей. */
export const UI_SNAPSHOT_PRUNE_MAX_PAGES = 20;
/** Бюджет времени уборки снимков внутри суточного джоба. */
export const UI_SNAPSHOT_PRUNE_TIME_BUDGET_MS = 30_000;
/** Файлов в одном запросе удаления: неудача гасит строки только этой
 * пачки, а не всей страницы. */
export const UI_SNAPSHOT_BLOB_CHUNK = 100;

const DAY_MS = 86_400_000;

export interface UiSnapshotPruneResult {
  /** Удалено строк `UiSnapshot`. */
  deleted: number;
  /** Удалено файлов под `qa-snapshots/`. */
  deletedBlobs: number;
  /** Строк оставлено не по сроку: файл удалить не удалось (доберёт
   * следующий прогон) или адрес файла не под `qa-snapshots/`. */
  failed: number;
  /** Упёрлись в потолок страниц или времени — остаток завтра. */
  hasMore: boolean;
  /** Страниц кандидатов просмотрено за прогон (потолок —
   * `UI_SNAPSHOT_PRUNE_MAX_PAGES`): вместе с `ms` и `hasMore` показывает
   * на проде, успевает ли уборка за притоком ~3600 строк в сутки. */
  pages: number;
  /** Сколько миллисекунд шла уборка (бюджет —
   * `UI_SNAPSHOT_PRUNE_TIME_BUDGET_MS`). */
  ms: number;
}

/** Строка-кандидат (порядок `createdAt asc, id asc`). */
export interface PruneCandidate {
  id: string;
  createdAt: Date;
  changed: boolean;
  error: string | null;
  blobUrl: string | null;
}

/** Строка «изменилось», которая хранится (моложе срока changed). */
export interface KeptChangedRow {
  id: string;
  createdAt: Date;
  comparedToUrl: string | null;
}

export interface PrunePageInput {
  /** Кандидаты страницы одной комбинации, по возрастанию времени. */
  candidates: PruneCandidate[];
  /** Хранимые `changed`-строки той же комбинации в интервале времени
   * страницы [первый кандидат; последний кандидат]. */
  keptChanged: KeptChangedRow[];
  /** Первая строка без ошибки ПОЗЖЕ последнего кандидата (любая). */
  nextOk: {
    id: string;
    createdAt: Date;
    changed: boolean;
    comparedToUrl: string | null;
  } | null;
  /** Есть ли вообще строка позже последнего кандидата. */
  hasLaterRow: boolean;
  plainCutoff: Date;
  changedCutoff: Date;
}

function before(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): boolean {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  return d !== 0 ? d < 0 : a.id < b.id;
}

/**
 * Какие кандидаты страницы удалить. Чистая функция — правило хранения
 * видно и проверяемо целиком, без базы.
 *
 * Последовательность строк БЕЗ ОШИБКИ в интервале страницы — это
 * кандидаты без ошибки плюс хранимые `changed`-строки (других строк в
 * интервале нет: страница берёт кандидатов подряд). «Было» для каждой
 * хранимой `changed`-строки — предыдущий элемент этой
 * последовательности; для `nextOk` — последний.
 */
export function planUiSnapshotPrunePage(input: PrunePageInput): {
  remove: PruneCandidate[];
  protectedIds: Set<string>;
} {
  const { candidates, plainCutoff, changedCutoff } = input;
  const protectedIds = new Set<string>();
  if (candidates.length === 0) return { remove: [], protectedIds };

  const candidateIds = new Set(candidates.map((c) => c.id));
  const okSeq: Array<{ id: string; createdAt: Date; keptChanged: boolean }> = [
    ...candidates
      .filter((c) => c.error === null)
      .map((c) => ({ id: c.id, createdAt: c.createdAt, keptChanged: false })),
    ...input.keptChanged.map((k) => ({
      id: k.id,
      createdAt: k.createdAt,
      keptChanged: true,
    })),
  ].sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));

  // (2) «было» у хранимых «изменилось» — по правилу страницы админки.
  for (let i = 1; i < okSeq.length; i++) {
    if (okSeq[i].keptChanged && candidateIds.has(okSeq[i - 1].id)) {
      protectedIds.add(okSeq[i - 1].id);
    }
  }
  const lastOk = okSeq.length > 0 ? okSeq[okSeq.length - 1] : null;
  if (lastOk && candidateIds.has(lastOk.id)) {
    const nextIsKeptChanged =
      input.nextOk !== null &&
      input.nextOk.changed &&
      input.nextOk.createdAt.getTime() >= changedCutoff.getTime();
    // (3) Позже нет ни одной строки без ошибки — это база сравнения.
    if (input.nextOk === null || nextIsKeptChanged) {
      protectedIds.add(lastOk.id);
    }
  }
  // (2) Тот же снимок — по адресу, записанному раннером.
  const referenced = new Set(
    [
      ...input.keptChanged.map((k) => k.comparedToUrl),
      input.nextOk?.changed &&
      input.nextOk.createdAt.getTime() >= changedCutoff.getTime()
        ? input.nextOk.comparedToUrl
        : null,
    ].filter((u): u is string => !!u),
  );
  for (const c of candidates) {
    if (c.blobUrl && referenced.has(c.blobUrl)) protectedIds.add(c.id);
  }
  // (3) Самая последняя строка комбинации — даже со сбоем.
  if (!input.hasLaterRow) {
    protectedIds.add(candidates[candidates.length - 1].id);
  }

  const remove = candidates.filter((c) => {
    if (protectedIds.has(c.id)) return false;
    // Страховка от кривого запроса: срок проверяется и здесь.
    const t = c.createdAt.getTime();
    if (t >= plainCutoff.getTime()) return false;
    if (c.changed && t >= changedCutoff.getTime()) return false;
    return true;
  });
  return { remove, protectedIds };
}

type Combo = { routeKey: string; locale: string; theme: string };
type Cursor = { createdAt: Date; id: string };

/** Строго после курсора в порядке `(createdAt, id)`. Нижняя граница
 * `gte` — отдельно от `OR`: только она попадает в условие индекса
 * (`EXPLAIN` на Postgres 16), без неё поиск «следующей» строки шёл бы
 * по индексу от самой старой строки комбинации. */
function afterCursor(c: Cursor) {
  return {
    createdAt: { gte: c.createdAt },
    OR: [
      { createdAt: { gt: c.createdAt } },
      { createdAt: c.createdAt, id: { gt: c.id } },
    ],
  };
}

export async function pruneUiSnapshots(
  prisma: PrismaService,
  blob: Pick<BlobService, 'deleteMany'>,
  opts: {
    now?: Date;
    deadlineMs?: number;
    clock?: () => number;
    /** Часы для `ms` — монотонные и отдельные от `clock`: `Date.now`
     * суточного джоба подменяют его тесты бюджета, и лишний вызов
     * сдвинул бы их счёт. */
    timer?: () => number;
  } = {},
): Promise<UiSnapshotPruneResult> {
  const timer = opts.timer ?? (() => performance.now());
  const t0 = timer();
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const deadline =
    opts.deadlineMs ?? now.getTime() + UI_SNAPSHOT_PRUNE_TIME_BUDGET_MS;
  const plainCutoff = new Date(
    now.getTime() - UI_SNAPSHOT_PLAIN_RETENTION_DAYS * DAY_MS,
  );
  const changedCutoff = new Date(
    now.getTime() - UI_SNAPSHOT_CHANGED_RETENTION_DAYS * DAY_MS,
  );
  const result: UiSnapshotPruneResult = {
    deleted: 0,
    deletedBlobs: 0,
    failed: 0,
    hasMore: false,
    pages: 0,
    ms: 0,
  };

  // Тип — приведением СПРАВА через `unknown`, как в wizard-telemetry:
  // у `groupBy` перегрузка, которая при ожидаемом типе выбирает не ту
  // сигнатуру (prisma/prisma#17297).
  const combos = (await prisma.uiSnapshot.groupBy({
    by: ['routeKey', 'locale', 'theme'],
    where: { createdAt: { lt: plainCutoff } },
  })) as unknown as Combo[];
  const state = combos.map((c) => ({
    combo: { routeKey: c.routeKey, locale: c.locale, theme: c.theme },
    after: null as Cursor | null,
    done: false,
  }));

  let pages = 0;
  // По кругу, по странице на комбинацию: одна «мигающая» комбинация с
  // длинным хвостом не должна съедать весь потолок каждую ночь.
  outer: while (state.some((s) => !s.done)) {
    for (const s of state) {
      if (s.done) continue;
      if (
        pages >= UI_SNAPSHOT_PRUNE_MAX_PAGES ||
        (pages > 0 && clock() >= deadline)
      ) {
        result.hasMore = true;
        break outer;
      }
      pages += 1;

      const candidates = (await prisma.uiSnapshot.findMany({
        where: {
          ...s.combo,
          AND: [
            { createdAt: { lt: plainCutoff } },
            {
              OR: [{ changed: false }, { createdAt: { lt: changedCutoff } }],
            },
            ...(s.after ? [afterCursor(s.after)] : []),
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: UI_SNAPSHOT_PRUNE_BATCH,
        select: {
          id: true,
          createdAt: true,
          changed: true,
          error: true,
          blobUrl: true,
        },
      })) as PruneCandidate[];
      if (candidates.length === 0) {
        s.done = true;
        continue;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];

      const keptFrom = Math.max(
        changedCutoff.getTime(),
        first.createdAt.getTime(),
      );
      const keptChanged =
        keptFrom <= last.createdAt.getTime()
          ? ((await prisma.uiSnapshot.findMany({
              where: {
                ...s.combo,
                changed: true,
                createdAt: { gte: new Date(keptFrom), lte: last.createdAt },
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true, createdAt: true, comparedToUrl: true },
            })) as KeptChangedRow[])
          : [];
      const nextOk = (await prisma.uiSnapshot.findFirst({
        where: { ...s.combo, error: null, ...afterCursor(last) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          createdAt: true,
          changed: true,
          comparedToUrl: true,
        },
      })) as PrunePageInput['nextOk'];
      const hasLaterRow =
        nextOk !== null ||
        (await prisma.uiSnapshot.findFirst({
          where: { ...s.combo, ...afterCursor(last) },
          select: { id: true },
        })) !== null;

      const { remove } = planUiSnapshotPrunePage({
        candidates,
        keptChanged,
        nextOk,
        hasLaterRow,
        plainCutoff,
        changedCutoff,
      });
      await deleteRowsAndFiles(prisma, blob, remove, result);

      if (candidates.length < UI_SNAPSHOT_PRUNE_BATCH) s.done = true;
      else s.after = { createdAt: last.createdAt, id: last.id };
    }
  }
  result.pages = pages;
  result.ms = Math.round(timer() - t0);
  return result;
}

async function deleteRowsAndFiles(
  prisma: PrismaService,
  blob: Pick<BlobService, 'deleteMany'>,
  rows: PruneCandidate[],
  result: UiSnapshotPruneResult,
): Promise<void> {
  const withFile: Array<{ id: string; pathname: string }> = [];
  const rowOnly: string[] = [];
  for (const r of rows) {
    if (r.blobUrl === null) {
      // Строка сбоя: файла нет.
      rowOnly.push(r.id);
      continue;
    }
    const pathname = pathnameFromBlobUrl(r.blobUrl, UI_SNAPSHOT_BLOB_PREFIX);
    if (pathname) withFile.push({ id: r.id, pathname });
    // Чужой адрес — не наш файл и не наша строка (см. п. 4 вверху).
    else result.failed += 1;
  }
  const removable = [...rowOnly];
  for (let i = 0; i < withFile.length; i += UI_SNAPSHOT_BLOB_CHUNK) {
    const chunk = withFile.slice(i, i + UI_SNAPSHOT_BLOB_CHUNK);
    // Одним запросом на пачку: `deleteMany` глотает ошибку запроса и
    // возвращает, сколько путей ушло, — меньше пачки значит «не ушла».
    const done = await blob
      .deleteMany(
        chunk.map((c) => c.pathname),
        chunk.length,
      )
      .catch(() => 0);
    if (done === chunk.length) {
      result.deletedBlobs += chunk.length;
      removable.push(...chunk.map((c) => c.id));
    } else {
      result.failed += chunk.length;
    }
  }
  if (removable.length === 0) return;
  const { count } = await prisma.uiSnapshot.deleteMany({
    where: { id: { in: removable } },
  });
  result.deleted += count;
}
