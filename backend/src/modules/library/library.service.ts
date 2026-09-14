/**
 * LibraryService — the shared library of Gemini analyses (spec §21,
 * Stage 24).
 *
 * Every completed analysis is stored once per SOURCE (`yt:<id>` /
 * `sha256:<hex>`), which buys two things at once: the same reference is
 * never sent to Gemini twice (cache), and the stored analyses become the
 * third way to pick a scenario — recommendations ranked against the
 * product's audience and category, next to YouTube search and a file
 * upload.
 *
 * Ownership: the analyses are the service's intellectual property (offer
 * §5, terms of use §4) — that is what makes one shared library legitimate
 * across users. `userId`/`sessionId` on a row record where it came from,
 * not who owns it.
 *
 * Visibility (Stage 25, §21.1/§21.3) draws the line between SHARING and
 * CACHING, and they are deliberately different:
 *  - discovery (recommendations) shows PUBLIC entries to everyone and a
 *    PRIVATE one only back to its author. An analysis of somebody's
 *    uploaded file has no public source and an unknown-to-us frame in its
 *    preview, so it is created PRIVATE;
 *  - the cache stays keyed by the source itself. If another user uploads a
 *    byte-identical file, they are looking at the very same video, so
 *    serving them the stored analysis reveals nothing they do not already
 *    have — and saves the expensive call.
 * HIDDEN is the operator's verdict: neither recommended nor served from
 * cache, so the next analysis of that source is made afresh.
 *
 * Durability (Stage 26): preview frames are captured into the SESSION's
 * blob prefix, and sessions are deleted by TTL together with their files
 * (doc/STORAGE-AUDIT.md). A library entry outlives its session, so on save
 * every preview is copied into `library/<sourceKey>/…` and the stored
 * analysis points at those copies — otherwise recommendations would slowly
 * fill with dead thumbnails.
 *
 * Structural row types, like every service here (doc/TELEGRAM-ADMIN.md §5).
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { libraryEntryPathnames } from '../../common/blob-paths';
import { SessionService } from '../../common/session.service';
import { referenceResetPatch } from '../../common/session-reset';
import { PlanService } from '../plan/plan.service';
import { VideoAnalysis } from '../../common/types/analysis.types';
import { SessionStatus } from '../../common/types/session.types';
import { VideoSourceType } from '../../common/types/video.types';
import { libraryFacets, RankableEntry, scoreEntry } from '../../common/library';
import {
  AdminLibraryEntryView,
  AdminLibraryPage,
  LibraryEntryView,
  LibraryRecommendation,
  LibraryVisibility,
} from './library.types';

/** How many rows the ranking looks at before sorting — cheap, table is small. */
const CANDIDATE_LIMIT = 200;

/**
 * Чистка невостребованных разборов (этап 51, В-4.6).
 *
 * Библиотека растёт быстрее всего после журнала расходов (1 667 байт на
 * строку, ~0,9 ГБ в год при 1 500 источниках в сутки) и не чистилась
 * ничем, кроме ручного удаления оператором. У неё, в отличие от
 * `ai_usage`, есть естественное правило: запись с `usageCount = 0`
 * старше полугода — разбор, которым не воспользовались ни разу; сессия,
 * породившая его, давно истекла (TTL сутки), и предъявить его некому.
 * Скрытые оператором записи не трогаем — это след нарушения (В-2.14).
 */
const LIBRARY_UNUSED_DEFAULT_DAYS = 180;
const LIBRARY_PRUNE_BATCH = 200;

/** Сколько дней невостребованная запись живёт; 0 — чистка выключена. */
export function libraryUnusedTtlDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.LIBRARY_UNUSED_TTL_DAYS;
  if (raw === undefined || raw === '') return LIBRARY_UNUSED_DEFAULT_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : LIBRARY_UNUSED_DEFAULT_DAYS;
}

export interface LibraryRow {
  id: string;
  sourceKey: string;
  sourceType: string;
  sourceUrl: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  analysis: unknown;
  category: string | null;
  audienceGender: string | null;
  audienceAgeRange: string | null;
  audienceInterests: string[];
  aspectRatio: string | null;
  sceneCount: number;
  characterCount: number;
  usageCount: number;
  visibility: LibraryVisibility;
  hiddenReason?: string | null;
  moderatedAt?: Date | null;
  userId?: string | null;
  sessionId?: string | null;
  updatedAt?: Date;
  createdAt: Date;
}

/** Кто может видеть запись — spec §21.1/§21.3. Exported for tests. */
export function canView(
  row: Pick<LibraryRow, 'visibility' | 'userId'>,
  viewerId: string | null,
): boolean {
  if (row.visibility === 'HIDDEN') return false;
  if (row.visibility === 'PUBLIC') return true;
  return !!viewerId && row.userId === viewerId;
}

@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly blob: BlobService,
    private readonly plans: PlanService,
  ) {}

  /** Cache lookup — returns the stored analysis, or null. HIDDEN never hits. */
  async findAnalysis(sourceKey: string): Promise<VideoAnalysis | null> {
    const row: LibraryRow | null =
      await this.prisma.analysisLibraryEntry.findUnique({
        where: { sourceKey },
      });
    if (!row || row.visibility === 'HIDDEN') return null;
    return reviveAnalysis(row.analysis);
  }

  /** Bump the "taken from the library" counter — best-effort, never throws. */
  async markUsed(sourceKey: string): Promise<void> {
    try {
      await this.prisma.analysisLibraryEntry.update({
        where: { sourceKey },
        data: { usageCount: { increment: 1 } },
      });
    } catch (e) {
      this.logger.warn(
        `usageCount bump failed for ${sourceKey}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * Store (or refresh) one analysis. Best-effort by design: a library
   * failure must never break the user's generation flow.
   */
  async save(input: {
    sourceKey: string;
    sourceType: 'youtube' | 'upload';
    sourceUrl: string | null;
    aspectRatio: string | null;
    analysis: VideoAnalysis;
    sessionId: string | null;
    userId: string | null;
  }): Promise<void> {
    // Копии кадров под собственным префиксом библиотеки (Stage 26).
    const analysis = await this.copyPreviews(input.sourceKey, input.analysis);
    const facets = libraryFacets(analysis);
    const data = {
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      title: facets.title,
      thumbnailUrl: facets.thumbnailUrl,
      // `Record<string, unknown>` doesn't satisfy Prisma's real generated
      // Json input type (`InputJsonValue` requires JSON-safe values, not
      // arbitrary `unknown`) — invisible in the sandbox (stub client types
      // this as `any`), a real `tsc` on Vercel rejects it. `Prisma.
      // InputJsonValue` is the type Prisma itself expects here (same
      // pattern as `session.service.ts`'s `seeded as Prisma.InputJsonValue`).
      analysis: analysis as unknown as Prisma.InputJsonValue,
      category: facets.category,
      audienceGender: facets.audienceGender,
      audienceAgeRange: facets.audienceAgeRange,
      audienceInterests: facets.audienceInterests,
      aspectRatio: input.aspectRatio,
      sceneCount: facets.sceneCount,
      characterCount: facets.characterCount,
      sessionId: input.sessionId,
      userId: input.userId,
    };
    try {
      await this.prisma.analysisLibraryEntry.upsert({
        where: { sourceKey: input.sourceKey },
        // §21.3: an upload has no public source — it starts private.
        create: {
          sourceKey: input.sourceKey,
          ...data,
          visibility: input.sourceType === 'upload' ? 'PRIVATE' : 'PUBLIC',
        },
        // §21.1: re-analysing the same source refreshes the CONTENT only —
        // the operator's verdict and the private flag survive it. Автор и
        // сессия первого разбора тоже (этап 54, В-2.14): скрытую запись
        // `findAnalysis` не отдаёт, разбор идёт заново и доходит сюда — и
        // автором становился тот, кто разобрал следующим, а след, по
        // которому оператор шёл к нарушителю, терялся.
        update: { ...data, sessionId: undefined, userId: undefined },
      });
    } catch (e) {
      this.logger.warn(
        `library save failed for ${input.sourceKey}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * Досохранить кадры-превью в уже существующую запись (этап 39, А-2.10).
   *
   * `save()` вызывается внутри разбора — то есть ДО того, как браузер
   * снимет кадры и подтвердит их: снять кадр можно только из плеера, а
   * плеер к моменту разбора ещё не показывал ролик. Повторного
   * сохранения не было, поэтому у записей библиотеки обложка была
   * `null` ВСЕГДА, а весь префикс `library/…` из §22 не использовался
   * ничем.
   *
   * Обновляются только кадры и обложка. Вердикт оператора, приватность,
   * счётчик использований и всё остальное не трогаются: подтверждение
   * кадров — не повод пересматривать решение о записи.
   *
   * Best-effort, как и `save`: сбой библиотеки не должен ломать сценарий
   * пользователя, который в этот момент просто листает разбор.
   */
  async refreshPreviews(
    sourceKey: string,
    analysis: VideoAnalysis,
  ): Promise<void> {
    try {
      const withCopies = await this.copyPreviews(sourceKey, analysis);
      const facets = libraryFacets(withCopies);
      await this.prisma.analysisLibraryEntry.update({
        where: { sourceKey },
        data: {
          analysis: withCopies as unknown as Prisma.InputJsonValue,
          thumbnailUrl: facets.thumbnailUrl,
        },
      });
    } catch (e) {
      this.logger.warn(
        `library preview refresh failed for ${sourceKey}: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }

  /**
   * Session previews live under `sessions/<id>/previews/…` and die with the
   * session; the library needs its own copies. Best-effort per frame: a
   * failed copy just leaves that preview out (the card falls back to an
   * icon), never breaks the save.
   */
  private async copyPreviews(
    sourceKey: string,
    analysis: VideoAnalysis,
  ): Promise<VideoAnalysis> {
    const prefix = `library/${sourceKey.replace(':', '-')}/`;
    const copyOne = async (
      url: string | null | undefined,
      key: string,
    ): Promise<string | null> => {
      if (!url) return null;
      // Уже наша копия (повторное сохранение того же источника) — не трогаем.
      if (url.includes(prefix)) return url;
      const from = sessionPreviewPathname(url);
      if (!from) return null;
      return this.blob.copyBlob(from, `${prefix}${key}.jpg`);
    };

    const [characters, scenes, extras] = await Promise.all([
      Promise.all(
        (analysis.characters ?? []).map(async (c) => ({
          ...c,
          previewUrl: await copyOne(c.previewUrl, `character-${c.id}`),
        })),
      ),
      Promise.all(
        (analysis.scenes ?? []).map(async (sc) => ({
          ...sc,
          previewUrl: await copyOne(sc.previewUrl, `scene-${sc.id}`),
        })),
      ),
      Promise.all(
        (analysis.extras ?? []).map(async (e) => ({
          ...e,
          previewUrl: await copyOne(e.previewUrl, `extra-${e.id}`),
        })),
      ),
    ]);

    return {
      ...analysis,
      ...(analysis.characters ? { characters } : {}),
      ...(analysis.scenes ? { scenes } : {}),
      ...(analysis.extras ? { extras } : {}),
    };
  }

  /**
   * Ranked shortlist for this session's product. Excludes the reference
   * the session already uses; entries without any facet in common still
   * show up at the bottom when there are few rows (a library that cannot
   * recommend anything is worse than a rough guess), but only after the
   * scored ones.
   */
  async recommend(
    sessionId: string,
    limit = 12,
  ): Promise<LibraryRecommendation[]> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    // §23: библиотека — возможность Premium (кеш при этом работает для
    // всех: он экономит вызов, а не даёт пользователю новую функцию).
    await this.plans.assertUser(session.userId ?? null, 'library');
    const product = session.productInformation;
    const viewerId = session.userId ?? null;
    const rows = await this.candidates(viewerId);
    const currentKey =
      session.originalVideo?.sourceType === VideoSourceType.YOUTUBE
        ? session.originalVideo.youtubeUrl
        : null;
    const input = {
      category: product?.category ?? null,
      audience: product?.audience ?? null,
    };
    return rows
      .filter((r) => !currentKey || r.sourceUrl !== currentKey)
      .map((r) => {
        const { score, reasons } = scoreEntry(toRankable(r), input);
        return { ...toView(r, viewerId), score, reasons };
      })
      .sort((a, b) => b.score - a.score || b.usageCount - a.usageCount)
      .slice(0, limit);
  }

  /**
   * Кандидаты для рекомендаций: всё публичное плюс свои приватные записи
   * (§21.3). Два запроса вместо одного `OR` — и это не стилистика (Б-1.3).
   *
   * Составной индекс `(visibility, usageCount DESC, createdAt DESC)`,
   * заведённый на этапе 40, обслуживает только запрос по ОДНОЙ
   * видимости. С `OR` планировщик его не берёт вовсе и идёт полным
   * сканом с сортировкой: измерено на 60 тыс. записей —
   * **30,6 мс против 0,49 мс** двумя запросами (62×), и время росло бы
   * линейно, потому что таблица не чистится никогда. Дополнительный
   * индекс под `OR` не помогает — проверено, план не меняется: мешает
   * форма условия, а не отсутствие индекса.
   *
   * Каждая половина берёт свои `CANDIDATE_LIMIT` строк по своему
   * порядку, дальше они сливаются и подрезаются — ровно тот же набор,
   * что вернул бы один запрос: строка не может быть одновременно
   * публичной и приватной, так что пересечения нет.
   *
   * Анонимная сессия видит только публичное — своих записей у неё быть
   * не может.
   */
  private async candidates(
    viewerId: string | null,
  ): Promise<Omit<LibraryRow, 'analysis'>[]> {
    const order = [
      { usageCount: 'desc' as const },
      { createdAt: 'desc' as const },
    ];
    // Без `select` Prisma тянет и колонку `analysis` — полный разбор,
    // в среднем 13 КБ JSON на запись (Б-1.8). При 200 кандидатах это
    // 2,7 МБ, которые едут по сети и парсятся в Node, чтобы не быть
    // прочитанными ни разу: ни `toRankable`, ни `toView` к разбору не
    // обращаются.
    const select = {
      id: true,
      sourceKey: true,
      sourceType: true,
      sourceUrl: true,
      title: true,
      thumbnailUrl: true,
      category: true,
      audienceGender: true,
      audienceAgeRange: true,
      audienceInterests: true,
      aspectRatio: true,
      sceneCount: true,
      characterCount: true,
      usageCount: true,
      visibility: true,
      userId: true,
      createdAt: true,
    } as const;
    const publicRows: Omit<LibraryRow, 'analysis'>[] =
      await this.prisma.analysisLibraryEntry.findMany({
        where: { visibility: 'PUBLIC' },
        orderBy: order,
        take: CANDIDATE_LIMIT,
        select,
      });
    if (!viewerId) return publicRows;

    const ownRows: Omit<LibraryRow, 'analysis'>[] =
      await this.prisma.analysisLibraryEntry.findMany({
        where: { visibility: 'PRIVATE', userId: viewerId },
        orderBy: order,
        take: CANDIDATE_LIMIT,
        select,
      });
    // Тот же порядок, что был у общего запроса: сортировка ниже всё
    // равно перетасует по совпадению с товаром, но «популярнее и новее»
    // остаётся правилом отбора кандидатов.
    return [...publicRows, ...ownRows]
      .sort(
        (a, b) =>
          b.usageCount - a.usageCount ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      )
      .slice(0, CANDIDATE_LIMIT);
  }

  /** One entry. A private one is only visible to its author; hidden — to nobody. */
  async get(
    id: string,
    viewerId: string | null = null,
  ): Promise<LibraryEntryView> {
    const row: LibraryRow | null =
      await this.prisma.analysisLibraryEntry.findUnique({ where: { id } });
    if (!row || !canView(row, viewerId)) {
      throw new NotFoundException(`Library entry ${id} not found`);
    }
    return toView(row, viewerId);
  }

  /**
   * Third path to a scenario: take a stored analysis as this session's
   * reference. No Gemini call at all — the analysis is copied in and the
   * session jumps straight to "analysis complete". The original video is
   * recorded as the YouTube link when there is one; for an entry that came
   * from someone's upload there is no shareable source, so the session
   * keeps the analysis without a playable original (previews still show —
   * they live in the analysis).
   */
  async applyToSession(
    sessionId: string,
    entryId: string,
  ): Promise<VideoAnalysis> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    // §23: библиотека готовых разборов — от Premium (эта проверка НЕ
    // применяется к applyToSessionFree ниже — той пользуется публичная
    // страница ролика, этап 60, и платить за неё некому).
    await this.plans.assertUser(session.userId ?? null, 'library');
    return this.applyEntryToSession(sessionId, session.userId ?? null, entryId);
  }

  /**
   * То же самое, но БЕЗ проверки тарифа (этап 60, ТЗ §40) — вызывается
   * публичной кнопкой «Сделать такой же» на странице шеринга
   * (`SharedVideoService.fork`). Пропуск гейта — сознательное решение:
   * применение уже готового разбора не делает ни одного платного
   * вызова, а весь смысл публичной страницы — бесплатно привести нового
   * пользователя, а не потребовать от него сначала завести тариф.
   * `canView` (§21.3) при этом действует как обычно — приватный разбор
   * чужому не отдаётся, откуда бы кнопка ни звала.
   */
  async applyEntryToSessionFree(
    sessionId: string,
    entryId: string,
  ): Promise<VideoAnalysis> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return this.applyEntryToSession(sessionId, session.userId ?? null, entryId);
  }

  private async applyEntryToSession(
    sessionId: string,
    viewerId: string | null,
    entryId: string,
  ): Promise<VideoAnalysis> {
    const row: LibraryRow | null =
      await this.prisma.analysisLibraryEntry.findUnique({
        where: { id: entryId },
      });
    // Same rule as viewing: you cannot take what you cannot see (§21.3).
    if (!row || !canView(row, viewerId)) {
      throw new NotFoundException(`Library entry ${entryId} not found`);
    }
    const analysis = reviveAnalysis(row.analysis);
    if (!analysis) {
      throw new NotFoundException(`Library entry ${entryId} has no analysis`);
    }
    await this.sessions.updateSession(sessionId, {
      ...(row.sourceType === 'youtube' && row.sourceUrl
        ? {
            originalVideo: {
              sourceType: VideoSourceType.YOUTUBE,
              youtubeUrl: row.sourceUrl,
              registeredAt: new Date(),
              ...(row.aspectRatio
                ? {
                    frame: {
                      width: null,
                      height: null,
                      aspectRatio: row.aspectRatio,
                      source: 'gemini' as const,
                    },
                  }
                : {}),
            },
          }
        : {}),
      videoAnalysis: analysis,
      status: SessionStatus.ANALYSIS_COMPLETE,
      // A different reference invalidates the choices made for the old one
      // — the same rule the upload and YouTube paths apply (Stage 28).
      ...referenceResetPatch(),
    });
    await this.markUsed(row.sourceKey);
    return analysis;
  }

  // ── Модерация (§21.1) — только для операторов админки ────────────────

  /** Список для админки: фильтры по видимости, типу источника и поиску. */
  async adminList(params: {
    visibility?: string;
    sourceType?: string;
    q?: string;
    page: number;
    pageSize: number;
  }): Promise<AdminLibraryPage> {
    const where: Record<string, unknown> = {};
    if (
      params.visibility === 'PUBLIC' ||
      params.visibility === 'PRIVATE' ||
      params.visibility === 'HIDDEN'
    ) {
      where.visibility = params.visibility;
    }
    if (params.sourceType === 'youtube' || params.sourceType === 'upload') {
      where.sourceType = params.sourceType;
    }
    const q = params.q?.trim();
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
        { sourceKey: { contains: q } },
      ];
    }
    const [rows, total]: [LibraryRow[], number] = await Promise.all([
      this.prisma.analysisLibraryEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.analysisLibraryEntry.count({ where }),
    ]);
    return {
      items: rows.map(toAdminView),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  /** Одна запись целиком, включая сам разбор — оператор должен видеть, что скрывает. */
  async adminGet(
    id: string,
  ): Promise<AdminLibraryEntryView & { analysis: VideoAnalysis | null }> {
    const row = await this.requireRow(id);
    return { ...toAdminView(row), analysis: reviveAnalysis(row.analysis) };
  }

  /**
   * Решение оператора: сменить видимость и/или поправить категорию
   * (категория — то, по чему записи подбираются, и Gemini иногда пишет её
   * слишком узко). Причина обязательна при скрытии — иначе через месяц
   * никто не вспомнит, почему запись убрана.
   */
  async adminUpdate(
    id: string,
    operatorId: string,
    dto: {
      visibility?: LibraryVisibility;
      hiddenReason?: string | null;
      category?: string | null;
    },
  ): Promise<AdminLibraryEntryView> {
    const row = await this.requireRow(id);
    if (
      dto.visibility === 'HIDDEN' &&
      !dto.hiddenReason?.trim() &&
      !row.hiddenReason
    ) {
      throw new BadRequestException(
        'hiddenReason is required when hiding a library entry',
      );
    }
    const data: Record<string, unknown> = {};
    if (dto.visibility !== undefined) data.visibility = dto.visibility;
    if (dto.hiddenReason !== undefined) {
      data.hiddenReason = dto.hiddenReason?.trim() || null;
    }
    if (dto.category !== undefined) {
      data.category = dto.category?.trim() || null;
    }
    if (Object.keys(data).length === 0) return toAdminView(row);
    data.moderatedAt = new Date();
    data.moderatedById = operatorId;
    const updated: LibraryRow = await this.prisma.analysisLibraryEntry.update({
      where: { id },
      data,
    });
    this.logger.log(
      `library entry ${id} moderated by ${operatorId}: ${JSON.stringify(data)}`,
    );
    return toAdminView(updated);
  }

  /**
   * Полное удаление. Отличается от HIDDEN тем, что источник снова станет
   * анализироваться и попадёт в библиотеку заново — поэтому по умолчанию
   * оператору стоит скрывать, а удалять только мусор (битый разбор).
   */
  async adminDelete(id: string): Promise<void> {
    const row = await this.requireRow(id);
    await this.prisma.analysisLibraryEntry.delete({ where: { id } });
    // Копии кадров под library/… принадлежали именно этой записи —
    // без неё их некому предъявить (doc/STORAGE-AUDIT.md, этап 27).
    const paths = libraryEntryPathnames(
      row.sourceKey,
      reviveAnalysis(row.analysis),
    );
    if (paths.length > 0) await this.blob.deleteMany(paths);
  }

  /**
   * Удалить партию невостребованных записей вместе с их кадрами.
   * Вызывается суточной уборкой (cron); партия ограничена — файлы удаляются
   * по сети, а крон живёт 300 секунд.
   */
  async pruneUnused(
    now: Date = new Date(),
  ): Promise<{ count: number; hasMore: boolean; disabled: boolean }> {
    const days = libraryUnusedTtlDays();
    if (days === 0) return { count: 0, hasMore: false, disabled: true };
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    // М-3.13 седьмого аудита: `usageCount` растёт только при первом
    // `applyToSession`, а партия по каталогу / A/B-запуск ссылаются на
    // запись по `libraryEntryId` без FK и могут ждать своего тика дольше
    // TTL (Е-1.2: «повтор завтра»). Такие записи не трогаем.
    const referenced = await Promise.all([
      this.prisma.catalogBatchRun.findMany({
        where: {
          items: {
            some: {
              status: {
                in: ['PENDING', 'FAILED', 'BATCH_QUEUED', 'GENERATING'],
              },
            },
          },
        },
        select: { libraryEntryId: true },
      }),
      this.prisma.abTestRun.findMany({
        where: {
          variants: { some: { status: { in: ['PENDING', 'GENERATING'] } } },
        },
        select: { libraryEntryId: true },
      }),
    ]);
    const referencedIds = referenced
      .flat()
      .map((r) => (r as { libraryEntryId: string | null }).libraryEntryId)
      .filter((id): id is string => !!id);
    const rows: Array<Pick<LibraryRow, 'id' | 'sourceKey' | 'analysis'>> =
      await this.prisma.analysisLibraryEntry.findMany({
        where: {
          usageCount: 0,
          createdAt: { lt: cutoff },
          visibility: { not: 'HIDDEN' },
          ...(referencedIds.length ? { id: { notIn: referencedIds } } : {}),
        },
        select: { id: true, sourceKey: true, analysis: true },
        orderBy: { createdAt: 'asc' },
        take: LIBRARY_PRUNE_BATCH,
      });
    if (rows.length === 0) return { count: 0, hasMore: false, disabled: false };
    // Строки — сначала, файлы — потом: упав между ними, оставим мусор в
    // хранилище, а не запись без кадров (тот же порядок, что у сессий).
    const result = await this.prisma.analysisLibraryEntry.deleteMany({
      where: { id: { in: rows.map((r) => r.id) }, usageCount: 0 },
    });
    const paths = rows.flatMap((r) =>
      libraryEntryPathnames(r.sourceKey, reviveAnalysis(r.analysis)),
    );
    if (paths.length > 0) {
      try {
        await this.blob.deleteMany(paths);
      } catch (e) {
        this.logger.warn(
          `невостребованные разборы удалены (${result.count}), кадры убрать не удалось: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return {
      count: result.count,
      hasMore: rows.length === LIBRARY_PRUNE_BATCH,
      disabled: false,
    };
  }

  private async requireRow(id: string): Promise<LibraryRow> {
    const row: LibraryRow | null =
      await this.prisma.analysisLibraryEntry.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Library entry ${id} not found`);
    return row;
  }
}

function toRankable(row: Omit<LibraryRow, 'analysis'>): RankableEntry {
  return {
    category: row.category,
    audienceGender: row.audienceGender,
    audienceAgeRange: row.audienceAgeRange,
    audienceInterests: row.audienceInterests ?? [],
    usageCount: row.usageCount,
  };
}

export function toView(
  row: Omit<LibraryRow, 'analysis'>,
  viewerId: string | null = null,
): LibraryEntryView {
  return {
    id: row.id,
    sourceType: row.sourceType === 'upload' ? 'upload' : 'youtube',
    sourceUrl: row.sourceUrl,
    title: row.title,
    thumbnailUrl: row.thumbnailUrl,
    category: row.category,
    audienceGender: row.audienceGender,
    audienceAgeRange: row.audienceAgeRange,
    audienceInterests: row.audienceInterests ?? [],
    aspectRatio: row.aspectRatio,
    sceneCount: row.sceneCount,
    characterCount: row.characterCount,
    usageCount: row.usageCount,
    visibility: row.visibility,
    own: !!viewerId && row.userId === viewerId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Json column → VideoAnalysis; `analyzedAt` comes back as a string. */
export function reviveAnalysis(raw: unknown): VideoAnalysis | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.sceneBreakdown !== 'string') return null;
  return {
    ...(o as unknown as VideoAnalysis),
    analyzedAt: new Date(
      typeof o.analyzedAt === 'string' ? o.analyzedAt : Date.now(),
    ),
  };
}

/** Админская проекция: те же поля + модерационные. */
export function toAdminView(row: LibraryRow): AdminLibraryEntryView {
  return {
    ...toView(row),
    sourceKey: row.sourceKey,
    hiddenReason: row.hiddenReason ?? null,
    moderatedAt: row.moderatedAt?.toISOString() ?? null,
    ownerId: row.userId ?? null,
    sessionId: row.sessionId ?? null,
    updatedAt: (row.updatedAt ?? row.createdAt).toISOString(),
  };
}

/**
 * Публичный URL кадра-превью → путь в Blob, но только если это кадр
 * СЕССИИ. Всё остальное (уже скопированное в library/, чужой домен,
 * мусор) возвращает null — копировать нечего.
 */
export function sessionPreviewPathname(url: string): string | null {
  try {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
    return /^sessions\/[^/]+\/previews\/[^/]+\.jpg$/.test(path) ? path : null;
  } catch {
    return null;
  }
}
