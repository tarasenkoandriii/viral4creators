/**
 * SessionService
 *
 * Session persistence backed by Supabase Postgres via Prisma — replaces
 * the previous in-memory `Map`. That Map worked locally (one process, one
 * memory space) but couldn't survive a real Vercel deployment: the whole
 * workflow is poll-driven (analysis status, generation status — one
 * request starts something, several later requests check on it), and
 * Vercel gives no guarantee those requests land on the same warm Function
 * instance. A session created by one instance was simply invisible to
 * another. See doc/VERCEL-READINESS-AUDIT.md, finding #2.
 *
 * The public API here is unchanged in shape (create/get/update/delete a
 * Session) so none of the calling modules needed to change their logic —
 * only to `await` calls that are now genuinely asynchronous.
 *
 * Storage shape: `status`, `createdAt`, `lastActivityAt` are real Postgres
 * columns (queryable, used for TTL cleanup); everything else the workflow
 * accumulates (reference video, analysis, product info, prompt, generated
 * video) lives in one JSON column — see prisma/schema.prisma for why.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Session as SessionRow, WorkflowKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Session, SessionStatus } from './types/session.types';
import { sessionBlobPathnames } from './blob-paths';
import { normalizeLocale } from './locale';
import { logWorkflowStage } from './workflow-stage-events';

/**
 * Сколько сессий чистим за один прогон крона. Ограничение осознанное:
 * функция на Vercel живёт 300 секунд, а удаление файлов идёт пачками по
 * сети. Остаток уберёт следующий прогон — `hasMore` про это скажет.
 */
const CLEANUP_BATCH = 500;

/** Что удалила уборка — файлы удаляет вызывающая сторона (StorageModule). */
export interface CleanupResult {
  count: number;
  /** Пути блобов удалённых сессий: их владельца в БД уже нет. */
  blobPathnames: string[];
  /** Истёкших сессий было больше, чем влезло в партию. */
  hasMore: boolean;
}

/**
 * Ключи Session, которые живут в JSON-колонке `data`. По этому списку
 * `updateSession` собирает правку: ключ вне списка в колонку не попадёт.
 */
const DATA_KEYS = [
  'originalVideo',
  'videoAnalysis',
  'productInformation',
  'generationPrompt',
  'generatedVideo',
  'brandManifestSnapshot',
  'characterCasting',
  'videoAudit',
  'scenes',
  'referenceSelection',
  'relevance',
  'analysisSelection',
  // Б-2.2: ключ записи библиотеки, к которой относится этот разбор.
  //
  // Поле объявили на этапе 39 и писали в двух местах `AnalysisService`,
  // а в этот список не добавили — и сборка JSON строго по списку
  // выбрасывала его при КАЖДОЙ записи. Читалось оно поэтому всегда
  // `undefined`, `refreshPreviews` не вызывался никогда, и обложек в
  // библиотеке не бывало вовсе — ровно тот дефект, который этап 39
  // закрывал (А-2.10). С этапа 47 колонка сливается, а не собирается
  // заново, но список по-прежнему решает, что вообще можно писать.
  'librarySourceKey',
  // UI-локаль (этап 59) и id страницы шеринга, с которой создана сессия
  // (этап 60) — оба пишутся один раз при создании (см. `createSession`),
  // но всё равно перечислены здесь для симметрии с остальными ключами
  // `data` и на случай точечной правки через `updateSession` в будущем.
  'locale',
  'sharedFromPageId',
  // Пилот говорящего AI-аватара (doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md,
  // этап 72) — отдельное поле, не трогает 'generatedVideo'.
  'avatarVideo',
  // Звуковой чек-звук (этап 73, common/sound-check.ts) — общая история
  // для Veo- и аватар-пайплайнов, не трогает 'videoAudit'.
  'soundCheck',
  // Доп. запрос владельца продукта: история прошлых попыток генерации
  // (`GeneratedVideo[]`, самая свежая первая) — см. доккомментарий поля
  // в session.types.ts. Пишется НЕ отдельным вызовом, а тем же UPDATE,
  // что перезаписывает 'generatedVideo' новой попыткой
  // (generation.service.ts, startGeneration()).
  'videoHistory',
] as const;

/**
 * Работы, которые занимаются замком на время платного вызова (этап 47).
 * Список закрытый: имя попадает в путь `jsonb_set`, и произвольной
 * строке там делать нечего.
 */
export const WORK_KINDS = [
  'generate',
  'analyze',
  'prompt',
  // A/B-варианты одного ролика (TODO §III.6, этап 66) — отдельный вид
  // работы от 'prompt': сборка вариантов не должна ни блокироваться, ни
  // блокировать обычное редактирование промпта той же сессии.
  'ab-variants',
  // Пилот говорящего AI-аватара (doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md,
  // этап 72) — платный вызов Hedra, тот же приём защиты от двойного
  // запуска, что у 'generate'.
  'avatar-generate',
  // Отправка прожига субтитров аватара (этап 72а) — отдельный от
  // 'avatar-generate' платный вызов (ffmpeg-api), стартующий позже, при
  // опросе статуса, а не при запуске рендера: без своего замка два
  // конкурентных опроса, оба увидевшие пустой `subtitleJobId`, оба
  // отправили бы задачу ffmpeg и оба списали бы расход — тот же класс
  // гонки, что `claimPostProduction` уже закрывает для Veo-пути (этап 37).
  'avatar-subtitle-burn',
  // Автоэкспорт, оба яруса (doc/MULTI-FORMAT-EXPORT-SPEC.md, этап 75;
  // Е-2.1 шестого аудита, этап 76) — race «потерянное обновление» на
  // общем JSON-поле `generatedVideo.exportVariants`: ярус A
  // (`PostProductionService.startExport`/`pollExport`) и ярус B
  // (`ExportService.startRerender`/`syncStatus`) читают ВЕСЬ
  // `generatedVideo` в память и пишут его целиком — без общего замка
  // конкурентные запросы (двойной клик, два таба, повтор после
  // клиентского таймаута) друг друга бесследно затирают. Один вид
  // работы на оба яруса — они делят одно и то же поле.
  'export',
  // Проверка звука пилота аватара (Е-3.1 шестого аудита, этап 77) —
  // `ActorsService.runSoundCheck()` читает сессию, идёт на платный
  // Gemini-вызов (загрузка в Files + generateContent) и только потом
  // пишет `soundCheck` целиком через `updateSession` — без замка два
  // параллельных запроса «Проверить звук» оба платят и один результат
  // молча теряется. Рецидив ровно того класса гонки, который уже закрыт
  // для 'avatar-generate'/'avatar-subtitle-burn'.
  'avatar-sound-check',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/**
 * What a project-bound session starts with (spec §7.8 / §12 snapshots —
 * copies, not references). Built by ProjectSessionService; the anonymous
 * flow passes nothing and gets the same empty session as before.
 */
export interface SessionSeed {
  projectId: string;
  productItemId: string;
  productInformation: Session['productInformation'];
  brandManifestSnapshot?: Session['brandManifestSnapshot'];
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly sessionTtlMs: number;

  constructor(private readonly prisma: PrismaService) {
    const ttlHours = parseInt(process.env.SESSION_TTL_HOURS || '24', 10);
    this.sessionTtlMs = ttlHours * 60 * 60 * 1000;
  }

  /**
   * Create a new session
   * @param userId - Internal User.id to attach, when the request was
   * identified via Telegram (see TelegramIdentityMiddleware). Omitted
   * for the ordinary anonymous browser flow — unchanged from before
   * Telegram login existed.
   * @param locale - UI-локаль фронтенда (этап 59, ТЗ §35.5) — читают
   * `AnalysisService`/`ProductRecognitionService`/`RelevanceService`/
   * `VideoAuditService`, чтобы отвечать пользователю на его языке.
   * Записывается один раз при создании; отсутствие трактуется как
   * `DEFAULT_LOCALE` (`normalizeLocale()`), не как ошибка.
   * @param sharedFromPageId - id страницы шеринга (SharedVideoPage), с
   * которой пришли по кнопке «Сделать такой же» (этап 60, ТЗ §40).
   * Записывается один раз при создании; `GenerationService` читает его
   * при первом завершении рендера, чтобы бампнуть счётчик конверсии
   * страницы-источника. Отсутствует у сессий, начатых обычным путём.
   * @returns Newly created session
   */
  async createSession(
    userId?: string,
    seed?: SessionSeed,
    locale?: string,
    sharedFromPageId?: string,
  ): Promise<Session> {
    const seeded: Record<string, unknown> = {
      ...(seed
        ? {
            productInformation: seed.productInformation ?? null,
            brandManifestSnapshot: seed.brandManifestSnapshot ?? null,
          }
        : {}),
      locale: normalizeLocale(locale),
      ...(sharedFromPageId ? { sharedFromPageId } : {}),
    };
    const row = await this.prisma.session.create({
      data: {
        // Status stays CREATED even with product info pre-filled: status
        // is the workflow's progress marker (video → analysis → product →
        // prompt → video) and spec §7.9 keeps SessionStatus untouched.
        // The product step simply finds its data already there.
        status: SessionStatus.CREATED,
        data: seeded as Prisma.InputJsonValue,
        ...(userId ? { userId } : {}),
        ...(seed
          ? { projectId: seed.projectId, productItemId: seed.productItemId }
          : {}),
      },
    });

    this.logger.log(`Created session ${row.id}`);
    // Этап 78 (doc/WORKFLOW-FUNNEL-SPEC.md §3.2) — самое первое событие
    // сущности, `fromStage: null`, «переход из ниоткуда». Отдельный путь
    // записи от `updateSession` ниже: сессия только что создана через
    // `prisma.session.create()`, не через UPDATE, откуда брать
    // предыдущий статус для сравнения было бы неоткуда и не нужно.
    await logWorkflowStage(
      this.prisma,
      WorkflowKind.SESSION,
      row.id,
      null,
      row.status,
    );
    return this.toSession(row);
  }

  /**
   * Get session by ID
   * @param sessionId - Session UUID
   * @returns Session or undefined if not found
   */
  async getSession(sessionId: string): Promise<Session | undefined> {
    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });
    return row ? this.toSession(row) : undefined;
  }

  /**
   * Update session data
   * @param sessionId - Session UUID
   * @param updates - Partial session updates
   * @returns Updated session or undefined if not found
   */
  async updateSession(
    sessionId: string,
    updates: Partial<Omit<Session, 'sessionId' | 'createdAt'>>,
  ): Promise<Session | undefined> {
    // Этап 47 (Б-1.10, В-2.9): колонка больше не переписывается целиком.
    //
    // Раньше метод читал сессию, сливал её с правкой в памяти и писал
    // `data` заново. Между чтением и записью успевал вклиниться любой
    // другой запрос к той же сессии — и его правка исчезала. На Vercel
    // это не редкость, а норма: опрос статуса и правка промпта приходят
    // в разные экземпляры функции. Хуже потерянной правки было то, что
    // так же стирался захват постобработки (`claimPostProduction`) —
    // единственный механизм, который не даёт оплатить синтез дважды.
    //
    // `"data" || $patch` сливает верхние ключи прямо в Postgres, одним
    // запросом и атомарно: два параллельных вызова с разными ключами
    // оба доходят до строки, а с одинаковым — побеждает последний,
    // ровно как и было бы при последовательной записи. Ключи, которых
    // в правке нет (в том числе служебные замки `workLocks`), строка
    // сохраняет.
    //
    // Семантика прежняя: правка — это верхние ключи целиком; `undefined`
    // в правке означает «стереть» и пишется как `null`, потому что
    // `JSON.stringify` иначе выбросил бы ключ и стирание не состоялось.
    const patch: Record<string, unknown> = {};
    for (const key of DATA_KEYS) {
      if (key in updates) patch[key] = updates[key] ?? null;
    }
    const status = updates.status ?? null;

    // `generationStatus` (этап 51, В-4.1) ведётся тем же UPDATE, что пишет
    // `data`: телеметрии и отчёту нужен статус рендера без распаковки
    // всей колонки, а отдельная запись означала бы место, где они могут
    // разойтись.
    // Этап 78 (doc/WORKFLOW-FUNNEL-SPEC.md §3.2) — CTE `old` читает статус
    // ДО этого UPDATE тем же круговым походом в базу, что и сам запрос
    // (не отдельный SELECT заранее — между ним и UPDATE снова мог бы
    // вклиниться параллельный запрос, тот самый race, ради которого этот
    // метод вообще стал одним атомарным запросом на этапе 47). Событие
    // воронки пишется только при РЕАЛЬНОЙ смене статуса — большинство
    // вызовов `updateSession` статус не трогают вовсе (`status` в правке
    // отсутствует → `COALESCE` оставляет старое значение → `previousStatus
    // === status` → событие не пишется).
    const json = JSON.stringify(patch);
    const rows = await this.prisma.$queryRaw<
      Array<SessionRow & { previousStatus: string }>
    >`
      WITH old AS (SELECT status FROM sessions WHERE id = ${sessionId})
      UPDATE "sessions"
      SET "data" = "data" || ${json}::jsonb,
          "generationStatus" = ("data" || ${json}::jsonb) -> 'generatedVideo' ->> 'status',
          "status" = COALESCE(${status}, "sessions"."status"),
          "lastActivityAt" = NOW()
      FROM old
      WHERE "sessions"."id" = ${sessionId}
      RETURNING "sessions".*, old.status AS "previousStatus"
    `;
    const row = rows[0];
    if (row && status !== null && row.previousStatus !== row.status) {
      await logWorkflowStage(
        this.prisma,
        WorkflowKind.SESSION,
        sessionId,
        row.previousStatus,
        row.status,
      );
    }
    return row ? this.toSession(row) : undefined;
  }

  /**
   * Занять работу над сессией на время платного вызова (этап 47, В-2.2,
   * В-2.3).
   *
   * ## Зачем
   *
   * Проверка «рендер уже идёт» смотрела на `generatedVideo`, а тот
   * записывается только ПОСЛЕ старта Veo — после скачивания фото,
   * референсов и самого вызова к Google, то есть через секунды. Повтор
   * после клиентского таймаута приходит именно в это окно, и замок его
   * пропускал; тридцать одновременных запросов запускали тридцать
   * рендеров. У разбора и промпта замка не было вовсе, и параллельный
   * разбор затирал готовый оплаченный.
   *
   * ## Почему в базе, а не в памяти
   *
   * На Vercel параллельные запросы приходят в разные экземпляры функции;
   * флаг в памяти процесса их не разведёт. Замок — ключ в `data`, и
   * занять его можно только одним условным `UPDATE`: кто получил
   * `affected = 1`, тот и работает.
   *
   * ## Почему с TTL
   *
   * Экземпляр может умереть посреди вызова (потолок функции — 300 с),
   * и снять замок будет некому. Протухший замок считается свободным.
   * TTL задаёт вызывающий — он знает, сколько длится его вызов.
   */
  async claimWork(
    sessionId: string,
    kind: WorkKind,
    ttlMs: number,
  ): Promise<boolean> {
    const now = Date.now();
    const staleBefore = now - ttlMs;
    // Внешний `jsonb_set` создаёт объект `workLocks`, если его ещё нет:
    // `jsonb_set` с путём в два звена НЕ создаёт промежуточный объект и
    // молча возвращает строку без изменений.
    const affected = await this.prisma.$executeRaw`
      UPDATE "sessions"
      SET "data" = jsonb_set(
            jsonb_set("data", '{workLocks}', COALESCE("data" -> 'workLocks', '{}'::jsonb), true),
            ARRAY['workLocks', ${kind}]::text[],
            to_jsonb(${String(now)}::bigint),
            true
          ),
          "lastActivityAt" = NOW()
      WHERE "id" = ${sessionId}
        AND (
          "data" -> 'workLocks' ->> ${kind} IS NULL
          OR ("data" -> 'workLocks' ->> ${kind})::bigint < ${String(staleBefore)}::bigint
        )
    `;
    return affected > 0;
  }

  /** Освободить замок: работа закончена или сорвалась — повтор разрешён. */
  async releaseWork(sessionId: string, kind: WorkKind): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "sessions"
      SET "data" = "data" #- ARRAY['workLocks', ${kind}]::text[]
      WHERE "id" = ${sessionId}
    `;
  }

  /**
   * Update session status
   * @param sessionId - Session UUID
   * @param status - New session status
   * @returns Updated session or undefined if not found
   */
  /**
   * Атомарно занять постобработку ролика (ТЗ §15.4, этап 37).
   *
   * ## Зачем это отдельный запрос, а не поле в `updateSession`
   *
   * Клиент опрашивает статус раз в четыре секунды, а переход
   * «Veo закончил» включает скачивание ролика у Google и заливку в наш
   * Blob — это заведомо дольше четырёх секунд. Пока первый опрос качает,
   * второй и третий читают из базы всё ещё `processing` и делают то же
   * самое. Все три доходят до постобработки с пустым `postStatus`,
   * каждый синтезирует свою дорожку и отправляет свою задачу ffmpeg:
   * одна генерация оплачивается как три.
   *
   * Прочитать-и-записать через `updateSession` тут не работает
   * принципиально: между чтением и записью успевают вклиниться остальные.
   * Нужен ОДИН запрос, который и проверяет, и занимает — и делает это в
   * базе, потому что на Vercel параллельные опросы могут прийти в разные
   * экземпляры функции, и никакой флаг в памяти процесса их не разведёт.
   *
   * Возвращает `true` тому единственному вызову, который занял работу;
   * остальным — `false`, и они просто ничего не делают.
   */
  async claimPostProduction(sessionId: string): Promise<boolean> {
    // `jsonb_set(..., true)` создаёт ключ, если его ещё нет. Условие
    // `IS NULL` ловит и «ключа нет», и «ключ есть со значением null» —
    // оба означают «постобработку никто не брал».
    const affected = await this.prisma.$executeRaw`
      UPDATE "sessions"
      SET "data" = jsonb_set(
            "data",
            '{generatedVideo,postStatus}',
            '"pending"'::jsonb,
            true
          ),
          "lastActivityAt" = NOW()
      WHERE "id" = ${sessionId}
        AND "data" -> 'generatedVideo' IS NOT NULL
        AND "data" -> 'generatedVideo' ->> 'postStatus' IS NULL
    `;
    return affected > 0;
  }

  /**
   * Сессии с хотя бы одним ожидающим вариантом яруса B автоэкспорта — для
   * крон-аналога `advanceGenerating()` (Е-2.3 шестого аудита, этап 76,
   * `ExportService.runSyncTick`). До этой правки статус яруса B двигался
   * ТОЛЬКО клиентским поллингом (`GET /sessions/:id/export/status`
   * ->`ExportService.syncStatus`) — если пользователь закрывал
   * экран/приложение до завершения дочернего рендера, вариант оставался
   * `pending` навсегда, а TTL самой дочерней сессии наступал раньше:
   * `cleanupExpiredSessions()` физически удалял и её, и уже готовый,
   * оплаченный файл ролика.
   *
   * `@>` — оператор JSONB-containment: сессия попадает в выборку, если
   * массив `exportVariants` содержит хотя бы один элемент, частично
   * совпадающий с образцом (`tier`/`status`, остальные поля элемента не
   * участвуют в сравнении) — то есть ровно «есть pending-вариант яруса
   * B». Простая проверка `@>`, а не путь JSONB (`jsonb_path_exists`),
   * которым в проекте больше нигде не пользуются.
   */
  async findSessionsWithPendingTierBExport(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "sessions"
      WHERE "data" -> 'generatedVideo' -> 'exportVariants'
            @> '[{"tier":"B","status":"pending"}]'::jsonb
      ORDER BY "lastActivityAt" ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  }

  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<Session | undefined> {
    return this.updateSession(sessionId, { status });
  }

  /**
   * Delete session
   * @param sessionId - Session UUID
   * @returns True if deleted, false if not found
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      await this.prisma.session.delete({ where: { id: sessionId } });
      return true;
    } catch {
      // Prisma throws (P2025) when the row doesn't exist — same
      // "false if not found" contract the in-memory version had.
      return false;
    }
  }

  /**
   * Clean up expired sessions (sessions older than TTL)
   * Should be called periodically by a scheduled task
   * @returns Number of sessions cleaned up
   */
  async cleanupExpiredSessions(
    maxSessions = CLEANUP_BATCH,
  ): Promise<CleanupResult> {
    const cutoff = new Date(Date.now() - this.sessionTtlMs);
    // Сначала ЧИТАЕМ то, что собираемся удалить: строку удалит Postgres, а
    // файлы в Blob удалять некому — их пути надо забрать до удаления
    // (doc/STORAGE-AUDIT.md, дефект этапа 26). Партия ограничена: крон на
    // Vercel живёт 300 секунд, а накопиться могло много.
    const rows: SessionRow[] = await this.prisma.session.findMany({
      where: { lastActivityAt: { lt: cutoff } },
      orderBy: { lastActivityAt: 'asc' },
      take: maxSessions,
    });
    if (rows.length === 0) {
      return { count: 0, blobPathnames: [], hasMore: false };
    }
    const blobPathnames = rows.flatMap((row) =>
      sessionBlobPathnames(this.toSession(row)),
    );
    // Условие по времени повторяется: сессия, которую тронули между
    // выборкой и удалением, больше не истёкшая — её трогать нельзя.
    const result = await this.prisma.session.deleteMany({
      where: {
        id: { in: rows.map((r) => r.id) },
        lastActivityAt: { lt: cutoff },
      },
    });
    return {
      count: result.count,
      blobPathnames,
      hasMore: rows.length === maxSessions,
    };
  }

  /**
   * Get session count
   * @returns Number of active sessions
   */
  async getSessionCount(): Promise<number> {
    return this.prisma.session.count();
  }

  /** Postgres row -> the Session shape the rest of the app expects. */
  private toSession(row: SessionRow): Session {
    const data = (row.data as Record<string, unknown>) ?? {};

    return {
      sessionId: row.id,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      status: row.status as SessionStatus,
      originalVideo: data.originalVideo as Session['originalVideo'],
      videoAnalysis: data.videoAnalysis as Session['videoAnalysis'],
      productInformation:
        data.productInformation as Session['productInformation'],
      generationPrompt: data.generationPrompt as Session['generationPrompt'],
      generatedVideo: data.generatedVideo as Session['generatedVideo'],
      brandManifestSnapshot: (data.brandManifestSnapshot ??
        undefined) as Session['brandManifestSnapshot'],
      characterCasting: (data.characterCasting ??
        undefined) as Session['characterCasting'],
      videoAudit: (data.videoAudit ?? undefined) as Session['videoAudit'],
      scenes: (data.scenes ?? undefined) as Session['scenes'],
      referenceSelection: (data.referenceSelection ??
        undefined) as Session['referenceSelection'],
      relevance: (data.relevance ?? undefined) as Session['relevance'],
      analysisSelection: (data.analysisSelection ??
        undefined) as Session['analysisSelection'],
      librarySourceKey: (data.librarySourceKey ??
        undefined) as Session['librarySourceKey'],
      // Б-2.2 style gap, найден и исправлен попутно на этапе 60: поле
      // писалось при создании (`seeded.locale`), но нигде не читалось
      // обратно — `session.locale` был всегда `undefined`, и все места,
      // что на него смотрят (`analysis.service.ts`,
      // `relevance.service.ts`), молча откатывались на DEFAULT_LOCALE
      // через `normalizeLocale(undefined)`. Локаль-осведомлённость с
      // этапа 59 тем самым не работала вовсе — теперь колонка `data`
      // читается по-настоящему.
      locale: (data.locale ?? undefined) as Session['locale'],
      sharedFromPageId: (data.sharedFromPageId ??
        undefined) as Session['sharedFromPageId'],
      avatarVideo: (data.avatarVideo ?? undefined) as Session['avatarVideo'],
      soundCheck: (data.soundCheck ?? undefined) as Session['soundCheck'],
      userId: row.userId ?? null,
      projectId: row.projectId ?? null,
      productItemId: row.productItemId ?? null,
    };
  }
}
