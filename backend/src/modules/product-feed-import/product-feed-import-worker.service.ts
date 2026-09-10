/**
 * ProductFeedImportWorkerService — крон-воркер импорта товарного фида
 * (TODO §Уровень 2 п.8, этап 68, §47). Вызывается
 * `GET /api/cron/feed-import-run` каждые 1-2 минуты
 * (`backend/vercel.json`), тот же ритм, что у `catalog-batch-run`/
 * `ab-test-run`.
 *
 * Один прогон (`runTick`) — ДВЕ независимые фазы одного и того же тика:
 *
 *   1. `runFetchPhase` — по одному разу на запуск: скачивает ссылку
 *      продавца, разбирает YML/CSV, заводит по одной строке
 *      `ProductFeedImportItem` (status PENDING) на каждый элемент фида,
 *      переводит запуск в IMPORTING. Сетевой сбой — бэкофф
 *      `2^attempts` минут (та же формула, что у CatalogBatchItem);
 *      SSRF-отказ/битый формат/пустой фид — сразу FAILED, ретраить
 *      нечего.
 *   2. `runImportPhase` — по пакету строк за тик, для запусков уже в
 *      IMPORTING: валидирует и заводит позицию через
 *      `ProjectService.addItem` (переиспользуем существующую проверку
 *      лимита — ретайп её здесь смысла не имеет), точечно дописывает
 *      категорию/фото напрямую в БД (в обход DTO — тот же приём, что у
 *      `ProductAnalogService.persist`), помечает строку IMPORTED/
 *      SKIPPED/FAILED.
 *
 * Обе фазы используют один и тот же claim-приём (`updateMany` на
 * `lockedUntil` перед любым внешним вызовом) — см. `CatalogBatchWorkerService`
 * (этап 65), откуда он взят почти дословно.
 *
 * ## Джоб-уровневый замок (пятый аудит, Д-3.3)
 *
 * Аудит перечисляет этот воркер в одном ряду с `CatalogBatchWorkerService`/
 * `AbTestWorkerService` (см. доккомментарий первого — там разбор
 * денежной гонки, актуальной именно для них): построчный claim не мешает
 * двум параллельным `runTick()` обработать разные строки одновременно.
 * Здесь фаза 2 сама по себе не тратит платный AI-вызов
 * (`ProjectService.addItem` — обычная запись в БД), но джоб-уровневый
 * замок добавлен для всех трёх воркеров симметрично — тот же класс
 * структурной гигиены (одна активная попытка джоба за раз), а не только
 * там, где уже доказан денежный риск. `runTick()` целиком оборачивается
 * джоб-уровневым замком (`common/cron-job-lock.ts`).
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';
import { ProjectService } from '../project/project.service';
import { BlobService } from '../storage/blob.service';
import {
  photoPathname,
  hashPhoto,
} from '../product-analog/product-analog.service';
import { MAX_PHOTO_BYTES } from '../../common/photo-limits';
import {
  fetchPubliclyRoutable,
  readBodyWithLimit,
  BodyTooLargeError,
} from '../../common/external-url-guard';
import { parseFeed } from '../../common/product-feed';
import { tryAcquireJobLock, releaseJobLock } from '../../common/cron-job-lock';

/** Та же тройка форматов, что и у остальных загрузок фото в проекте
 * (product-analog.service.ts) — своя копия, а не импорт: список там
 * приватный, и дублирование трёх строк дешевле искусственного экспорта
 * ради одного второго потребителя. */
const ALLOWED_PHOTO_MIME = ['image/png', 'image/jpeg', 'image/webp'];

const FETCH_TIMEOUT_MS = 20_000;
/** Claim держим с запасом на скачивание+разбор фида (фаза 1) — заметно
 * дольше, чем для одной строки (фаза 2), где самое долгое — одно
 * скачивание фото. */
const RUN_LOCK_MS = 5 * 60 * 1000;
const ITEM_LOCK_MS = 2 * 60 * 1000;

/** Ключ джоба для джоб-уровневого замка (Д-3.3) — совпадает с
 * `jobKey`, под которым этот джоб пишется в `CronRunLog`. */
const JOB_KEY = 'feed-import-run';

/** Прочитанное как есть (без сгенерированного Prisma-клиента) число в
 * колонке DECIMAL приходит структурным объектом с `toString()`, не
 * обязательно `number` — тот же приём, что в project.service.ts. */
type DecimalLike = { toString(): string } | number | string;
function decimalToNumber(value: DecimalLike | null): number | null {
  return value === null || value === undefined
    ? null
    : Number(value.toString());
}

interface ClaimableRun {
  id: string;
  sourceUrl: string;
  attempts: number;
}

interface RunContext {
  id: string;
  projectId: string;
  userId: string;
  currency: string;
}

interface ClaimableItem {
  id: string;
  runId: string;
  rowIndex: number;
  title: string | null;
  price: DecimalLike | null;
  currency: string | null;
  description: string | null;
  photoUrl: string | null;
  categoryText: string | null;
  attempts: number;
  /** Уже созданный товар с прошлой (частично провалившейся) попытки —
   * см. Д-2.1 у `processItem`. */
  productItemId: string | null;
}

export interface FeedImportTickResult {
  fetchedRuns: number;
  importedItems: number;
  skippedItems: number;
  failedItems: number;
}

/** Отказы, для которых повторная попытка ничего не изменит — то же
 * деление, что у CatalogBatchWorkerService. */
const NON_RETRYABLE_NAMES = new Set([
  'BadRequestException',
  'NotFoundException',
  'UnsafeExternalUrlError',
]);

@Injectable()
export class ProductFeedImportWorkerService {
  private readonly logger = new Logger(ProductFeedImportWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectService: ProjectService,
    private readonly blob: BlobService,
  ) {}

  private cfg() {
    return loadConfiguration().productFeedImport;
  }

  async runTick(): Promise<FeedImportTickResult> {
    // Джоб-уровневый замок (Д-3.3) — ДО обеих фаз. Если другой прогон
    // этого же джоба уже идёт, тихо пропускаем тик целиком (обе фазы).
    const acquired = await tryAcquireJobLock(this.prisma, JOB_KEY);
    if (!acquired) {
      this.logger.warn(
        `Крон импорта фида: пропуск тика — другой прогон этого же джоба ещё выполняется`,
      );
      return {
        fetchedRuns: 0,
        importedItems: 0,
        skippedItems: 0,
        failedItems: 0,
      };
    }
    try {
      return await this.runTickLocked();
    } finally {
      await releaseJobLock(this.prisma, JOB_KEY);
    }
  }

  private async runTickLocked(): Promise<FeedImportTickResult> {
    const fetchedRuns = await this.runFetchPhase();
    const itemResult = await this.runImportPhase();
    const result: FeedImportTickResult = { fetchedRuns, ...itemResult };
    if (
      fetchedRuns > 0 ||
      itemResult.importedItems +
        itemResult.skippedItems +
        itemResult.failedItems >
        0
    ) {
      this.logger.log(
        `Крон импорта фида: забрано запусков ${fetchedRuns}, заведено ${itemResult.importedItems}, ` +
          `пропущено ${itemResult.skippedItems}, провалено ${itemResult.failedItems}`,
      );
    }
    return result;
  }

  // ── Фаза 1: забрать фид ──────────────────────────────────────────────

  private async runFetchPhase(): Promise<number> {
    const runs: ClaimableRun[] =
      await this.prisma.productFeedImportRun.findMany({
        where: {
          OR: [
            { status: 'PENDING' },
            { status: 'FAILED', nextAttemptAt: { lte: new Date() } },
          ],
        },
        select: { id: true, sourceUrl: true, attempts: true },
        orderBy: { createdAt: 'asc' },
        take: this.cfg().cronBatch,
      });

    let processed = 0;
    for (const run of runs) {
      const claim = await this.prisma.productFeedImportRun.updateMany({
        where: {
          id: run.id,
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
        },
        data: { lockedUntil: new Date(Date.now() + RUN_LOCK_MS) },
      });
      if (claim.count === 0) continue;
      processed += 1;
      try {
        await this.fetchAndParse(run);
      } catch (error) {
        await this.recordRunFailure(run, error);
      }
    }
    return processed;
  }

  private async fetchAndParse(run: ClaimableRun): Promise<void> {
    // Повторная проверка перед самим скачиванием (первая — при создании
    // запуска, см. product-feed-import.service.ts) — DNS мог измениться
    // между ними; см. обоснование в external-url-guard.ts. Обычный
    // `fetch` здесь обходился бы редиректом на служебный адрес (пятый
    // аудит, Д-3.1) — `fetchPubliclyRoutable` перепроверяет КАЖДЫЙ хоп.
    const res = await fetchPubliclyRoutable(run.sourceUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Не удалось скачать фид (HTTP ${res.status})`);
    }

    const maxBytes = this.cfg().maxFeedBytes;
    // Дешёвый быстрый отказ, когда источник честно объявил размер — не
    // открываем тело вовсе. НЕ единственная защита (Д-3.2, пятый аудит):
    // источник без Content-Length (chunked) или с заниженным значением
    // прошёл бы эту проверку — реальная гарантия ниже, в
    // readBodyWithLimit, которая считает байты по мере поступления и
    // обрывает поток, а не то, что сервер СКАЗАЛ про размер.
    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new BadRequestException(
        `Фид превышает предел ${Math.floor(maxBytes / (1024 * 1024))} МБ`,
      );
    }
    let bodyBuffer: Buffer;
    try {
      bodyBuffer = await readBodyWithLimit(res, maxBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        throw new BadRequestException(
          `Фид превышает предел ${Math.floor(maxBytes / (1024 * 1024))} МБ`,
        );
      }
      throw error;
    }
    const body = bodyBuffer.toString('utf8');

    const { rows } = parseFeed(res.headers.get('content-type'), body);
    if (rows.length === 0) {
      throw new BadRequestException(
        'Фид не содержит ни одной позиции — проверьте ссылку и формат',
      );
    }

    // Лимит товаров проекта проверяется не здесь, а по ходу заведения
    // каждой строки (фаза 2, через ProjectService.addItem) — так лимит
    // учитывает и то, что могло появиться в проекте руками между этим
    // тиком и предыдущим.
    await this.prisma.$transaction(async (tx) => {
      await tx.productFeedImportItem.createMany({
        data: rows.map((row, index) => ({
          runId: run.id,
          rowIndex: index,
          title: row.title || null,
          price: row.price,
          currency: row.currency,
          description: row.description ?? null,
          photoUrl: row.photoUrl ?? null,
          categoryText: row.categoryText ?? null,
        })),
      });
      await tx.productFeedImportRun.update({
        where: { id: run.id },
        data: {
          status: 'IMPORTING',
          totalRows: rows.length,
          lockedUntil: null,
          error: null,
        },
      });
    });
  }

  private async recordRunFailure(
    run: ClaimableRun,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const errorName =
      error instanceof Error ? error.constructor.name : undefined;
    const attempts = run.attempts + 1;
    const maxAttempts = this.cfg().maxAttempts;
    const nonRetryable = errorName ? NON_RETRYABLE_NAMES.has(errorName) : false;
    const exhausted = nonRetryable || attempts >= maxAttempts;
    await this.prisma.productFeedImportRun.update({
      where: { id: run.id },
      data: {
        attempts,
        error: message.slice(0, 2000),
        status: 'FAILED',
        nextAttemptAt: exhausted
          ? null
          : new Date(Date.now() + 2 ** attempts * 60_000),
        lockedUntil: null,
        completedAt: exhausted ? new Date() : null,
      },
    });
    this.logger.warn(
      `Импорт фида ${run.id}: попытка ${attempts}/${maxAttempts} не удалась — ${message}` +
        (exhausted ? ', дальше не повторяем → FAILED' : ''),
    );
  }

  // ── Фаза 2: завести позиции ──────────────────────────────────────────

  private async runImportPhase(): Promise<{
    importedItems: number;
    skippedItems: number;
    failedItems: number;
  }> {
    const items: ClaimableItem[] =
      await this.prisma.productFeedImportItem.findMany({
        where: {
          run: { status: 'IMPORTING' },
          OR: [
            { status: 'PENDING' },
            { status: 'FAILED', nextAttemptAt: { lte: new Date() } },
          ],
        },
        select: {
          id: true,
          runId: true,
          rowIndex: true,
          title: true,
          price: true,
          currency: true,
          description: true,
          photoUrl: true,
          categoryText: true,
          attempts: true,
          productItemId: true,
        },
        orderBy: [{ runId: 'asc' }, { rowIndex: 'asc' }],
        take: this.cfg().cronBatch,
      });

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const runCache = new Map<string, RunContext>();
    const touchedRuns = new Set<string>();

    for (const item of items) {
      const claim = await this.prisma.productFeedImportItem.updateMany({
        where: {
          id: item.id,
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
        },
        data: { lockedUntil: new Date(Date.now() + ITEM_LOCK_MS) },
      });
      if (claim.count === 0) continue;
      touchedRuns.add(item.runId);

      try {
        const run = await this.getRunContextCached(item.runId, runCache);
        const outcome = await this.processItem(item, run);
        if (outcome === 'imported') imported += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        await this.recordItemFailure(item, error);
      }
    }

    for (const runId of touchedRuns) {
      await this.finalizeRunIfDone(runId);
    }

    return {
      importedItems: imported,
      skippedItems: skipped,
      failedItems: failed,
    };
  }

  /** Запуск завершён, когда у него не осталось ни PENDING, ни ждущего
   * повтора FAILED строк — переводим в DONE. `updateMany` с условием
   * `status: 'IMPORTING'` в `where`, а не `update`, — на случай если
   * запуск каким-то образом уже перешёл в другое состояние между
   * подсчётом и записью (гонка тиков), тот же защитный приём, что и
   * claim выше. */
  private async finalizeRunIfDone(runId: string): Promise<void> {
    const remaining = await this.prisma.productFeedImportItem.count({
      where: {
        runId,
        OR: [
          { status: 'PENDING' },
          { status: 'FAILED', nextAttemptAt: { not: null } },
        ],
      },
    });
    if (remaining === 0) {
      await this.prisma.productFeedImportRun.updateMany({
        where: { id: runId, status: 'IMPORTING' },
        data: { status: 'DONE', completedAt: new Date() },
      });
    }
  }

  private async getRunContextCached(
    runId: string,
    cache: Map<string, RunContext>,
  ): Promise<RunContext> {
    const cached = cache.get(runId);
    if (cached) return cached;
    const run = await this.prisma.productFeedImportRun.findUnique({
      where: { id: runId },
      select: { id: true, projectId: true, userId: true },
    });
    if (!run) {
      throw Object.assign(new Error(`Запуск ${runId} не найден`), {
        name: 'NotFoundException',
      });
    }
    const project = await this.prisma.project.findUnique({
      where: { id: run.projectId },
      select: { currency: true },
    });
    const context: RunContext = {
      id: run.id,
      projectId: run.projectId,
      userId: run.userId,
      currency: project?.currency ?? '',
    };
    cache.set(runId, context);
    return context;
  }

  /** Одна строка фида → одна позиция товара (или обоснованный пропуск).
   * Непредвиденная ошибка (не `BadRequestException` от `addItem`)
   * выбрасывается наружу — её ловит `runImportPhase` и уводит в бэкофф
   * через `recordItemFailure`, тот же приём, что у
   * `CatalogBatchWorkerService`. */
  private async processItem(
    item: ClaimableItem,
    run: RunContext,
  ): Promise<'imported' | 'skipped'> {
    const title = (item.title ?? '').trim();
    const price = decimalToNumber(item.price);
    if (!title || price === null || !Number.isFinite(price)) {
      await this.resolveItem(
        item,
        'SKIPPED',
        'Нет обязательных полей (название и/или цена)',
      );
      return 'skipped';
    }
    if (
      item.currency &&
      item.currency.toUpperCase() !== run.currency.toUpperCase()
    ) {
      await this.resolveItem(
        item,
        'SKIPPED',
        `Валюта строки фида (${item.currency}) не совпадает с валютой проекта (${run.currency})`,
      );
      return 'skipped';
    }

    let created: { id: string };
    // Пятый аудит, Д-2.1: строка уже заводила товар в прошлой попытке —
    // транзиентный сбой мог случиться ПОСЛЕ того, как addItem() реально
    // создал товар, но ДО того, как строка фида успела это отразить
    // (см. запись productItemId сразу после addItem() ниже — раньше
    // такой промежуточной фиксации не было вовсе, только финальный
    // `resolveItem` в самом конце метода). Слепой повтор addItem() на
    // следующем тике создавал бы вторую позицию на ту же строку фида.
    // Резюмируем с уже созданным товаром вместо этого.
    if (item.productItemId) {
      created = { id: item.productItemId };
    } else {
      try {
        created = await this.projectService.addItem(run.userId, run.projectId, {
          title,
          price,
          description: item.description ?? undefined,
          priceSource: 'MANUAL',
        });
      } catch (e) {
        if (e instanceof BadRequestException) {
          const message = e.message;
          await this.resolveItem(item, 'SKIPPED', message);
          // «Line limit reached» — лимит товаров проекта уже достигнут;
          // повторять тот же вызов на каждой следующей строке этого
          // запуска бессмысленно — все они провалятся с тем же текстом.
          if (message.includes('Line limit reached')) {
            await this.skipRemainderOfRun(
              item.runId,
              item.id,
              'Достигнут лимит товаров проекта',
            );
          }
          return 'skipped';
        }
        throw e;
      }
      // Фиксируем товар на строке фида СРАЗУ — отдельно от финального
      // resolveItem() ниже. Это и есть промежуточная точка сохранения,
      // которая делает повтор резюмируемым (см. комментарий выше):
      // если что-то упадёт дальше (attachCategoryAndPhoto или сам
      // resolveItem), следующий тик увидит productItemId уже
      // проставленным и не станет заводить товар повторно. Не гасим
      // ошибку здесь — если ИМЕННО эта запись не удалась, метод должен
      // упасть как обычно и уйти в штатный бэкофф/ретрай.
      await this.prisma.productFeedImportItem.update({
        where: { id: item.id },
        data: { productItemId: created.id },
      });
    }

    await this.attachCategoryAndPhoto(created.id, run.projectId, item);
    await this.resolveItem(item, 'IMPORTED', null, created.id);
    return 'imported';
  }

  private async resolveItem(
    item: ClaimableItem,
    status: 'IMPORTED' | 'SKIPPED',
    reason: string | null,
    productItemId?: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.productFeedImportItem.update({
        where: { id: item.id },
        data: {
          status,
          reason,
          productItemId: productItemId ?? null,
          lockedUntil: null,
        },
      }),
      this.prisma.productFeedImportRun.update({
        where: { id: item.runId },
        data:
          status === 'IMPORTED'
            ? { importedCount: { increment: 1 } }
            : { skippedCount: { increment: 1 } },
      }),
    ]);
  }

  /** Достигнут лимит товаров — дальше все оставшиеся строки этого
   * запуска пропускаем одним запросом, не повторяя один и тот же
   * провальный `addItem()` по одной строке за тик. */
  private async skipRemainderOfRun(
    runId: string,
    excludeItemId: string,
    reason: string,
  ): Promise<void> {
    const result = await this.prisma.productFeedImportItem.updateMany({
      where: {
        runId,
        id: { not: excludeItemId },
        OR: [
          { status: 'PENDING' },
          { status: 'FAILED', nextAttemptAt: { not: null } },
        ],
      },
      data: {
        status: 'SKIPPED',
        reason,
        lockedUntil: null,
        nextAttemptAt: null,
      },
    });
    if (result.count > 0) {
      await this.prisma.productFeedImportRun.update({
        where: { id: runId },
        data: { skippedCount: { increment: result.count } },
      });
    }
  }

  private async recordItemFailure(
    item: ClaimableItem,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = item.attempts + 1;
    const maxAttempts = this.cfg().maxAttempts;
    const exhausted = attempts >= maxAttempts;
    await this.prisma.productFeedImportItem.update({
      where: { id: item.id },
      data: {
        attempts,
        reason: message.slice(0, 2000),
        status: 'FAILED',
        nextAttemptAt: exhausted
          ? null
          : new Date(Date.now() + 2 ** attempts * 60_000),
        lockedUntil: null,
      },
    });
    if (exhausted) {
      await this.prisma.productFeedImportRun.update({
        where: { id: item.runId },
        data: { failedCount: { increment: 1 } },
      });
    }
    this.logger.warn(
      `Импорт фида, строка ${item.rowIndex} (запуск ${item.runId}): попытка ${attempts}/${maxAttempts} не удалась — ${message}` +
        (exhausted ? ', дальше не повторяем → FAILED' : ''),
    );
  }

  /** Категория/фото — вторым шагом напрямую в БД, в обход DTO (тот же
   * приём, что у ProductAnalogService.persist): ProductItemRequestDto
   * их не содержит вовсе (см. §47 «Что уже есть»). Сбой этого шага не
   * отменяет уже созданную позицию — мягкая деградация. */
  private async attachCategoryAndPhoto(
    itemId: string,
    projectId: string,
    row: ClaimableItem,
  ): Promise<void> {
    const data: Record<string, unknown> = {};
    if (row.categoryText) data.category = row.categoryText;
    if (row.photoUrl) {
      const photo = await this.downloadFeedPhoto(
        row.photoUrl,
        projectId,
        itemId,
      );
      if (photo) {
        data.photoUrl = photo.url;
        data.photoHash = photo.hash;
      }
    }
    if (Object.keys(data).length === 0) return;
    try {
      await this.prisma.productItem.update({ where: { id: itemId }, data });
    } catch (error) {
      // Пятый аудит, Д-2.4: раньше сбой этого шага пропадал полностью —
      // товар уже IMPORTED (терминальный статус строки фида), воркер
      // больше никогда не выбирает эту строку заново, так что «попробуем
      // на следующем опросе» тут неприменимо — в отличие от PENDING-строк
      // в других местах этого файла, где такой же приём безопасен именно
      // потому, что тик к ним вернётся. Не молчим: логируем и оставляем
      // причину на самой строке фида — сбой хотя бы виден оператору (лог
      // крона / история импорта в БД), а не растворяется бесследно.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Фид: не удалось прикрепить категорию/фото к товару ${itemId} (строка ${row.id}) — ${message}`,
      );
      await this.prisma.productFeedImportItem
        .update({
          where: { id: row.id },
          data: {
            reason: `Товар импортирован, но категория/фото не применились: ${message.slice(0, 500)}`,
          },
        })
        .catch(() => undefined);
    }
  }

  private async downloadFeedPhoto(
    photoUrl: string,
    projectId: string,
    itemId: string,
  ): Promise<{ url: string; hash: string } | null> {
    try {
      // Тот же редирект-safe fetch, что и у самого фида (Д-3.1) — фото
      // тоже скачивается по адресу, который прислал ПРОДАВЕЦ в фиде.
      const res = await fetchPubliclyRoutable(photoUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const contentType = (res.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim();
      if (!ALLOWED_PHOTO_MIME.includes(contentType)) return null;
      // Д-3.2 (пятый аудит): то же потоковое ограничение, что и у самого
      // фида — BodyTooLargeError ловится общим catch ниже и превращается
      // в «фото не скачано» (мягкая деградация), как и раньше при
      // превышении MAX_PHOTO_BYTES, только без буферизации лишнего.
      const bytes = await readBodyWithLimit(res, MAX_PHOTO_BYTES);
      const pathname = photoPathname(projectId, itemId, contentType);
      const { url } = await this.blob.uploadBuffer(
        pathname,
        bytes,
        contentType,
      );
      return { url, hash: hashPhoto(bytes) };
    } catch (e) {
      // Фото — необязательное украшение импортированной строки, а не
      // условие её успеха (то же «ухудшение, а не поломка», что у
      // остальных необязательных шагов этой фичи); UnsafeExternalUrlError
      // сюда тоже попадает — сбойный/подозрительный адрес картинки просто
      // остаётся без фото, не отменяя позицию.
      void e;
      return null;
    }
  }
}
