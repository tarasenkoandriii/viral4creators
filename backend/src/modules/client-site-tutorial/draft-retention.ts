/**
 * Сроки хранения данных входа и кадров обучалки по сайту заказчика —
 * Ш0.5/Ш0.6 аудита docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md
 * (риски В-1 и В-2). Зовётся кроном `client-site-retention` раз в сутки.
 *
 * ## Что и когда стирается
 *
 * | Что | Когда |
 * |---|---|
 * | `credentialsEnc` + `cookiesEnc` (Ш2: или запись хранилища sites-backend по `siteTestAccountId`/`userSiteSessionId`) | через `SECRETS_RETENTION_DAYS` после последней записи раундом (`secretsUsedAt`; у строк до Ш0.5 — `updatedAt`) |
 * | то же, «одноразово» (`secretsOneShot`) | после первой успешной сборки ролика (сборщик стирает сразу, здесь — страховка) |
 * | кадры в Blob (весь префикс черновика) | одобрен и ролик собран, или отклонён — через `DECIDED_FRAMES_RETENTION_DAYS` без движения; брошенный в работе или на одобрении (`PENDING_REVIEW`) — через `ABANDONED_FRAMES_RETENTION_DAYS` |
 *
 * Черновик на одобрении (`PENDING_REVIEW`) до аудита кронов 06.10.2026
 * не попадал ни под одно правило: снимки авторизованного кабинета
 * заказчика лежали в публичном Blob бессрочно, пока оператор не решит.
 * Теперь он стирается как брошенный, а за `PENDING_REVIEW_WARN_DAYS` до
 * стирания оператор получает одну тревогу со списком.
 *
 * До Ш0 ни то ни другое не стиралось вовсе: креды и живая сессия
 * заказчика лежали, пока жив черновик, а снимки его авторизованного
 * кабинета — в публичном Blob по подбираемому пути.
 *
 * ## Что остаётся
 *
 * Строка черновика, шаги и предпросмотровые кадры в БД
 * (`roundScreenshots`, не публичны). Черновик после уборки рабочий:
 * `/finish` соберёт ролик из предпросмотра (как для черновиков до
 * варианта А), а переигровка входа честно попросит ввести данные
 * заново — это и есть цена срока хранения.
 *
 * ## Почему класс без Nest DI
 *
 * Ему нужны только Prisma и Blob, которые у `CronJobsService` уже есть.
 * Регистрация провайдера потребовала бы импорта модуля обучалки в
 * модуль кронов ради одного вызова в сутки.
 */

import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { BlobService } from '../storage/blob.service';
import { draftFramePrefix } from './draft-frames';
import type { DraftSecretsRow, DraftSecretsStore } from './draft-secrets-store';

export const SECRETS_RETENTION_DAYS = 30;
export const DECIDED_FRAMES_RETENTION_DAYS = 14;
export const ABANDONED_FRAMES_RETENTION_DAYS = 30;
/** За сколько дней до стирания кадров черновика на одобрении
 *  предупредить оператора. */
export const PENDING_REVIEW_WARN_DAYS = 7;
/** Черновиков за один прогон — потолок времени функции, остаток завтра. */
export const FRAMES_PURGE_BATCH = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClientSiteRetentionResult {
  secretsExpired: number;
  secretsOneShot: number;
  framesPurged: number;
  framesFailed: number;
  /** Черновиков на одобрении, о скором стирании которых предупредили. */
  pendingReviewWarned: number;
  skipped?: boolean;
}

/** Условие «у строки есть хоть один секрет» — общее для двух правил. */
const HAS_SECRETS = {
  OR: [
    { credentialsEnc: { not: null } },
    { cookiesEnc: { not: null } },
    // Э-С Ш2: данные входа в хранилище sites-backend.
    { siteTestAccountId: { not: null } },
    { userSiteSessionId: { not: null } },
  ],
};

const WIPE_SECRETS = {
  credentialsEnc: null,
  cookiesEnc: null,
  siteTestAccountId: null,
  userSiteSessionId: null,
  storeHasCredentials: false,
};

/** Колонки для стирания записи хранилища (Ш2). */
const STORE_SELECT = {
  id: true,
  projectId: true,
  baseUrl: true,
  siteTestAccountId: true,
  userSiteSessionId: true,
} as const;

export class ClientSiteDraftRetention {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly logger: Pick<Logger, 'log' | 'warn'> = new Logger(
      'ClientSiteDraftRetention',
    ),
    /** Э-С Ш2: стирание записей хранилища sites-backend; без него — только колонки (запись истечёт по сроку хранилища). */
    private readonly secrets?: Pick<DraftSecretsStore, 'forget' | 'userOf'>,
    /** Тревога оператору о скором стирании кадров черновика на
     *  одобрении; без неё — только правило. */
    private readonly notify?: {
      alert(fingerprint: string, text: string): Promise<unknown>;
    },
  ) {}

  /**
   * Ш2: у черновиков из `where`, чьи данные входа в хранилище, — стереть
   * там (личную запись B целиком, секреты учётки A). Колонки и ссылки
   * обнуляет вызывающий (`WIPE_SECRETS`).
   */
  private async forgetInStore(where: object): Promise<void> {
    if (!this.secrets) return;
    const rows = (await this.prisma.clientSiteTutorialDraft.findMany({
      where: {
        AND: [
          where,
          {
            OR: [
              { siteTestAccountId: { not: null } },
              { userSiteSessionId: { not: null } },
            ],
          },
        ],
      },
      select: { ...STORE_SELECT, project: { select: { userId: true } } },
      take: 500,
    })) as Array<
      Omit<DraftSecretsRow, 'credentialsEnc' | 'cookiesEnc'> & {
        project?: { userId: string } | null;
      }
    >;
    for (const r of rows) {
      const userId = r.project?.userId;
      if (!userId) continue;
      try {
        await this.secrets.forget(await this.secrets.userOf(userId), {
          ...r,
          credentialsEnc: null,
          cookiesEnc: null,
        });
      } catch (err) {
        this.logger.warn(
          `client-site-retention: данные входа черновика ${r.id} в хранилище не стёрлись (${
            err instanceof Error ? err.name : 'error'
          }) — истекут по сроку хранилища`,
        );
      }
    }
  }

  async run(now: Date = new Date()): Promise<ClientSiteRetentionResult> {
    // Кадры — ПЕРВЫМИ: их правило смотрит на `updatedAt`, а стирание
    // секретов ниже его сдвигает. Обратный порядок откладывал бы уборку
    // кадров брошенного черновика ещё на срок.
    const frames = await this.purgeFrames(now);
    const pendingReviewWarned = await this.warnPendingReview(now);
    const secretsExpired = await this.expireSecrets(now);
    const secretsOneShot = await this.forgetOneShotAfterBuild();
    const result = {
      secretsExpired,
      secretsOneShot,
      framesPurged: frames.purged,
      framesFailed: frames.failed,
      pendingReviewWarned,
    };
    this.logger.log(`client-site-retention: ${JSON.stringify(result)}`);
    return result;
  }

  /** Креды и куки, которыми не пользовались `SECRETS_RETENTION_DAYS`. */
  async expireSecrets(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - SECRETS_RETENTION_DAYS * DAY_MS);
    const stale = {
      OR: [
        { secretsUsedAt: { lt: cutoff } },
        // Строки до Ш0.5: отметки нет, последняя правка — лучшая
        // оценка последнего раунда.
        { secretsUsedAt: null, updatedAt: { lt: cutoff } },
      ],
    };
    await this.forgetInStore(stale);
    const { count } = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: { AND: [HAS_SECRETS, stale] },
      data: WIPE_SECRETS,
    });
    return count;
  }

  /** «Одноразово»: ролик собран — данные входа больше не нужны. */
  async forgetOneShotAfterBuild(): Promise<number> {
    const drafts = (await this.prisma.clientSiteTutorialDraft.findMany({
      where: { secretsOneShot: true, ...HAS_SECRETS },
      select: { id: true },
      take: 500,
    })) as Array<{ id: string }>;
    if (drafts.length === 0) return 0;
    const built = (await this.prisma.tutorialVideoAsset.findMany({
      where: {
        clientSiteDraftId: { in: drafts.map((d) => d.id) },
        assemblyStatus: 'complete',
      },
      select: { clientSiteDraftId: true },
    })) as Array<{ clientSiteDraftId: string | null }>;
    const ids = [
      ...new Set(
        built
          .map((b) => b.clientSiteDraftId)
          .filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) return 0;
    await this.forgetInStore({ id: { in: ids }, secretsOneShot: true });
    const { count } = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: { id: { in: ids }, secretsOneShot: true },
      data: WIPE_SECRETS,
    });
    return count;
  }

  /**
   * Одна тревога оператору о черновиках на одобрении, кадры которых
   * сотрутся через `PENDING_REVIEW_WARN_DAYS`. Окно — одни сутки
   * (крон суточный), так что каждый черновик попадает в тревогу один
   * раз; повтор ручным запуском в те же сутки гасит дедупликация канала.
   */
  async warnPendingReview(now: Date): Promise<number> {
    if (!this.notify) return 0;
    const purgeAt = ABANDONED_FRAMES_RETENTION_DAYS - PENDING_REVIEW_WARN_DAYS;
    const windowEnd = new Date(now.getTime() - purgeAt * DAY_MS);
    const windowStart = new Date(windowEnd.getTime() - DAY_MS);
    const soon = (await this.prisma.clientSiteTutorialDraft.findMany({
      where: {
        status: 'PENDING_REVIEW',
        framesPurgedAt: null,
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
      select: { id: true, title: true, baseUrl: true },
      orderBy: { updatedAt: 'asc' },
      take: FRAMES_PURGE_BATCH,
    })) as Array<{ id: string; title: string | null; baseUrl: string }>;
    if (soon.length === 0) return 0;
    try {
      await this.notify.alert(
        'client-site-retention:pending-review',
        `Обучалка по сайту заказчика: ${soon.length} черновик(ов) ждут одобрения ${purgeAt} дн. — через ${PENDING_REVIEW_WARN_DAYS} дн. их кадры будут стёрты (снимки кабинета заказчика не хранятся бессрочно). Одобрите или отклоните: ${soon
          .map((d) => d.title ?? d.baseUrl)
          .join(', ')}.`,
      );
    } catch (err) {
      this.logger.warn(
        `client-site-retention: тревога о черновиках на одобрении не ушла (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
    return soon.length;
  }

  /** Кадры решённых и брошенных черновиков. */
  async purgeFrames(now: Date): Promise<{ purged: number; failed: number }> {
    const decided = new Date(
      now.getTime() - DECIDED_FRAMES_RETENTION_DAYS * DAY_MS,
    );
    const abandoned = new Date(
      now.getTime() - ABANDONED_FRAMES_RETENTION_DAYS * DAY_MS,
    );
    // Одобренный — только если ролик уже СОБРАН: кадры и есть вход
    // сборки, и до `complete` (в том числе после неудачной попытки,
    // которая вернёт черновик на одобрение) они нужны.
    //
    // Отбор — В ЗАПРОСЕ, а не после него (аудит кронов 06.10.2026):
    // раньше одобренные без сборки попадали в пачку `FRAMES_PURGE_BATCH`
    // и пропускались уже в цикле. Старейшие по `updatedAt`, они
    // занимали голову пачки каждый день — и полсотни таких останавливали
    // уборку всех остальных навсегда.
    const built = (await this.prisma.tutorialVideoAsset.findMany({
      where: {
        clientSiteDraftId: { not: null },
        assemblyStatus: 'complete',
      },
      select: { clientSiteDraftId: true },
      distinct: ['clientSiteDraftId'],
    })) as Array<{ clientSiteDraftId: string | null }>;
    const builtIds = [
      ...new Set(
        built
          .map((b) => b.clientSiteDraftId)
          .filter((id): id is string => !!id),
      ),
    ];
    const candidates = (await this.prisma.clientSiteTutorialDraft.findMany({
      where: {
        framesPurgedAt: null,
        OR: [
          {
            status: 'APPROVED',
            id: { in: builtIds },
            updatedAt: { lt: decided },
          },
          { status: 'REJECTED', updatedAt: { lt: decided } },
          {
            status: { in: ['DRAFTING', 'PENDING_REVIEW'] },
            updatedAt: { lt: abandoned },
          },
        ],
      },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        roundVideoFrames: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: FRAMES_PURGE_BATCH,
    })) as Array<{
      id: string;
      status: string;
      updatedAt: Date;
      roundVideoFrames: unknown;
    }>;
    if (candidates.length === 0) return { purged: 0, failed: 0 };

    let purged = 0;
    let failed = 0;
    for (const draft of candidates) {
      // Захват строки ДО стирания: условие на `updatedAt` гарантирует,
      // что черновик не тронули с момента выборки (человек вернул его в
      // работу и снимает раунды — его кадры не наши).
      const frames = Array.isArray(draft.roundVideoFrames)
        ? draft.roundVideoFrames
        : [];
      const { count } = await this.prisma.clientSiteTutorialDraft.updateMany({
        where: {
          id: draft.id,
          updatedAt: draft.updatedAt,
          framesPurgedAt: null,
        },
        data: {
          framesPurgedAt: now,
          // Ссылки на стёртое — `null`: `/finish` для такого раунда
          // возьмёт кадр предпросмотра, как для черновиков до варианта А.
          roundVideoFrames: frames.map(() => null) as object,
          previewFrameCount: null,
        },
      });
      if (count === 0) continue;

      try {
        await this.wipePrefix(draftFramePrefix(draft.id));
        purged++;
      } catch (err) {
        failed++;
        // Отметку снимаем: иначе неубранные файлы так и остались бы,
        // а строка считалась бы убранной.
        await this.prisma.clientSiteTutorialDraft
          .updateMany({
            where: { id: draft.id },
            data: { framesPurgedAt: null },
          })
          .catch(() => undefined);
        this.logger.warn(
          `client-site-retention: кадры черновика ${draft.id} не стёрлись (${
            err instanceof Error ? err.message : String(err)
          }) — повтор завтра`,
        );
      }
    }
    return { purged, failed };
  }

  private async wipePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.blob.listByPrefix(prefix, { cursor });
      const paths = page.blobs.map((b) => b.pathname);
      if (paths.length > 0) await this.blob.deleteMany(paths);
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }
}
