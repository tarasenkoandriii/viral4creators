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
import { SOFT_DELETE_GRACE_MS, SoftDeletePurgeResult } from './soft-delete';

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
/** Экспорт — только для теста круговорота полей (session.service.spec.ts). */
export const DATA_KEYS = [
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
 * Ключи, которые живут в отдельной колонке `liveData` (этап 122, В-4.2
 * третьего аудита).
 *
 * Набор — не «что помельче», а «что пишется чаще всего И весит мало»:
 * `generatedVideo` (статус рендера и постобработки) двигается на каждом
 * шаге ролика, `relevance` — небольшой отчёт, переписываемый по кнопке.
 *
 * `videoAudit` в набор НЕ входит, хотя аудит его и назвал: его
 * `history` не ограничена и хранит по два полных текста промпта на
 * замечание — несколько килобайт у сессии, которую проверяли трижды.
 * В горячей колонке он съел бы ровно ту экономию, ради которой колонка
 * заводится: каждая запись статуса переписывала бы и его.
 *
 * `workLocks` тоже остаётся в `data` и в этом этапе не трогается:
 * замок обязан иметь ОДИН источник истины в каждый момент, а во время
 * выкатки (миграции применяются на сборке, старый код ещё обслуживает
 * запросы) две колонки означали бы два независимых замка — то есть
 * двойной платный вызов, ровно та гонка, которую замок и закрывает.
 *
 * Снаружи разницы нет: `toSession` сливает обе колонки в одну `Session`.
 */
export const LIVE_KEYS = ['generatedVideo', 'relevance'] as const;

const LIVE_KEY_SET: ReadonlySet<string> = new Set(LIVE_KEYS);

/** Ключ пишется в `liveData`, а не в `data`. */
export function isLiveKey(key: string): boolean {
  return LIVE_KEY_SET.has(key);
}

/**
 * Обе колонки сессии как один объект (этап 122).
 *
 * Снаружи сессия одна: разделение на `data` и `liveData` — про то, что
 * дешевле писать, а не про то, что откуда читать. Каждый, кто берёт
 * строку `sessions` напрямую (админка, повтор рендера оператором,
 * список прогонов товара), обязан звать это, иначе `generatedVideo`
 * просто исчезнет с его экрана — молча, потому что `undefined` в этих
 * местах выглядит как «ролика ещё нет».
 */
export function sessionData(row: {
  data: unknown;
  liveData: unknown;
}): Record<string, unknown> {
  return {
    // Порядок именно такой: `data` СИЛЬНЕЕ. Пока в ней лежит старая
    // копия горячего ключа (сессия, пережившая выкатку и ещё не
    // переписанная новым кодом), она же и есть последнее значение —
    // писал его старый код, который про `liveData` ничего не знал.
    // При первой записи `updateSession` убирает копию из `data`, и с
    // этого момента источник один — `liveData`.
    ...((row.liveData as Record<string, unknown> | null) ?? {}),
    ...((row.data as Record<string, unknown> | null) ?? {}),
  };
}

/**
 * Разложить правку сессии по двум колонкам (чистая часть, этап 122).
 *
 * Отдельной функцией — потому что ошибиться здесь можно молча: ключ,
 * попавший не в ту колонку, будет прочитан (обе сливаются при чтении),
 * но потеряет смысл разделения, а ключ, попавший в ОБЕ, однажды
 * разойдётся сам с собой.
 */
export function splitSessionPatch(
  updates: Record<string, unknown>,
  keys: readonly string[] = DATA_KEYS,
): { data: Record<string, unknown>; live: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  const live: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in updates)) continue;
    // `undefined` означает «стереть» и пишется как `null`: иначе
    // `JSON.stringify` выбросил бы ключ и стирание не состоялось.
    const value = updates[key] ?? null;
    if (isLiveKey(key)) live[key] = value;
    else data[key] = value;
  }
  return { data, live };
}

/**
 * Работы, которые занимаются замком на время платного вызова (этап 47).
 * Список закрытый: имя попадает в путь `jsonb_set`, и произвольной
 * строке там делать нечего.
 */
export const WORK_KINDS = [
  // ИИ-скетч (doc/AI-SKETCH-SPEC.md §6.4): генерация картинки для слота
  // сессии — платный вызов, двойное нажатие оплачивать дважды незачем.
  'sketch',
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
  // Продолжение цепочки Scene Extension (М-2.2/М-1.3 седьмого аудита):
  // переход к следующему сегменту запускается из ОПРОСА статуса
  // (`getVideoStatus`/`pollGrokStatus`) после того, как опрос увидел
  // готовый сегмент, — то есть из хот-пути, который опрашивают две
  // вкладки, таймер админки и крон экспорта одновременно. Между «увидел
  // done» и записью `continued` — скачивание, заливка и платный старт
  // следующего сегмента; без замка каждый конкурентный опрос стартовал
  // бы свой сегмент (двойная оплата), а последняя запись затирала бы
  // `veoOperationName`/`grokRequestId` первого — оплаченный рендер
  // осиротел бы. Тот же класс, что 'avatar-subtitle-burn'.
  'chain-continue',
  // Аудит ролика и проверка звука (М-2.5 седьмого аудита — рецидив
  // Е-3.1 на соседнем сервисе): платный Gemini-вызов, затем запись
  // всей истории целиком; двойной клик = две оплаты и потерянная
  // запись. Два вида — у них разные поля (`videoAudit`/`soundCheck`),
  // друг друга блокировать незачем.
  'audit',
  'sound-check',
  // Переозвучка готового ролика без перегенерации (доп. запрос владельца
  // продукта, этап 87, `PostProductionService.reVoice`) — свой замок,
  // отдельный от 'export': оба пишут в общее поле `generatedVideo`
  // целиком, но `claimPostProduction` для повтора не годится (она
  // разрешает захват РОВНО один раз — только при пустом `postStatus`,
  // см. её доккомментарий), а делить замок с 'export' значило бы, что
  // экспорт форматов блокирует переозвучку и наоборот без всякой связи
  // между ними по смыслу.
  'revoice',
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
   *
   * `deletedAt: null` (этап 89) — мягко удалённая сессия (пользователь
   * нажал «удалить» в «Постпроде» или её удалил оператор в админке) читается
   * как «не найдено» весь грейс-период до `purgeSoftDeletedSessions()`,
   * тем же приёмом, что `ProjectService.findOwnProject`/`findOwnItem`.
   * `findFirst`, не `findUnique`: второе поле в `where` рядом с `id`.
   */
  async getSession(sessionId: string): Promise<Session | undefined> {
    const row = await this.prisma.session.findFirst({
      where: { id: sessionId, deletedAt: null },
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
    // Этап 122 (В-4.2): правка раскладывается по двум колонкам —
    // горячие мелкие ключи в `liveData`, всё остальное в `data`.
    const patch = splitSessionPatch(updates as Record<string, unknown>);
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
    const coldJson = JSON.stringify(patch.data);
    const liveJson = JSON.stringify(patch.live);
    // Список горячих ключей уезжает в запрос параметром, а не склейкой
    // строк: он закрытый, но параметр дешевле правила «не забудь
    // экранировать», которое однажды забудут.
    const liveKeysArray = [...LIVE_KEYS];

    // `CASE WHEN (колонка || правка) = колонка` — не микрооптимизация, а
    // единственный способ НЕ переписывать восьмикилобайтную `data` там,
    // где менять в ней нечего (этап 122). Postgres в этой ветке
    // подставляет исходный датум колонки, то есть указатель на уже
    // лежащий в TOAST объект: новой копии и новой записи в WAL не
    // возникает. Замерено на PG 16, 1000 записей подряд: правка без
    // изменений по-старому — 9,3 МБ WAL, так — 0,13 МБ.
    //
    // Пустая правка (`{}` — вызовы, меняющие только `status`) попадает
    // в ту же ветку по построению: слияние с пустым объектом равно
    // исходному значению. Отдельного условия для неё не нужно.
    const rows = await this.prisma.$queryRaw<
      Array<SessionRow & { previousStatus: string }>
    >`
      WITH old AS (SELECT status FROM sessions WHERE id = ${sessionId}),
           p AS (
             SELECT ${coldJson}::jsonb AS cold,
                    ${liveJson}::jsonb AS live,
                    ${liveKeysArray}::text[] AS hot
           )
      UPDATE "sessions"
      SET "data" = CASE
            -- Сессия, пережившая выкатку со старой раскладкой: копию
            -- горячего ключа убираем ровно один раз, при первой же
            -- записи. Дальше ветка никогда не выполняется.
            WHEN "data" ?| p.hot THEN ("data" - p.hot) || p.cold
            WHEN ("data" || p.cold) = "data" THEN "data"
            ELSE "data" || p.cold
          END,
          "liveData" = CASE
            -- Старая копия, если она есть, СИЛЬНЕЕ: её писал старый код,
            -- который про вторую колонку не знал, значит она и есть
            -- последнее значение. Сначала подкладываем её, потом правку.
            WHEN "data" ?| p.hot
              THEN "liveData"
                   || (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
                         FROM jsonb_each("data") AS e(k, v)
                        WHERE k = ANY(p.hot))
                   || p.live
            WHEN ("liveData" || p.live) = "liveData" THEN "liveData"
            ELSE "liveData" || p.live
          END,
          -- Статус рендера — из того места, где ролик лежит ПОСЛЕ этой
          -- записи: сначала сама правка, затем старая копия в общей
          -- колонке (она сильнее), затем liveData. Раньше первой
          -- стояла ("data" || правка): в SET это СТАРОЕ значение
          -- колонки, и на первой записи сессии со старой раскладкой
          -- статус брался из уходящей копии, а не из нового ролика.
          -- Ошибиться здесь дороже всего: по этому полю суточная уборка
          -- решает, удалять ли готовый оплаченный ролик.
          "generationStatus" = CASE
            WHEN p.live ? 'generatedVideo'
              THEN p.live -> 'generatedVideo' ->> 'status'
            ELSE COALESCE(
              "data" -> 'generatedVideo' ->> 'status',
              "liveData" -> 'generatedVideo' ->> 'status'
            )
          END,
          "status" = COALESCE(${status}, "sessions"."status"),
          "lastActivityAt" = NOW()
      FROM old, p
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
    //
    // Пишем туда, где `generatedVideo` лежит СЕЙЧАС (этап 122): у
    // сессии, пережившей выкатку и ещё не переписанной, это `data`.
    // Записать «занято» в другую колонку значило бы не занять ничего —
    // а это единственный механизм, который не даёт оплатить
    // постобработку дважды.
    const affected = await this.prisma.$executeRaw`
      UPDATE "sessions"
      SET "data" = CASE
            WHEN "data" ? 'generatedVideo'
              THEN jsonb_set("data", '{generatedVideo,postStatus}', '"pending"'::jsonb, true)
            ELSE "data"
          END,
          "liveData" = CASE
            WHEN "data" ? 'generatedVideo' THEN "liveData"
            ELSE jsonb_set("liveData", '{generatedVideo,postStatus}', '"pending"'::jsonb, true)
          END,
          "lastActivityAt" = NOW()
      WHERE "id" = ${sessionId}
        AND COALESCE("data" -> 'generatedVideo', "liveData" -> 'generatedVideo') IS NOT NULL
        AND COALESCE("data" -> 'generatedVideo', "liveData" -> 'generatedVideo') ->> 'postStatus' IS NULL
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
      WHERE "generationStatus" = 'complete'
        AND COALESCE("data" -> 'generatedVideo', "liveData" -> 'generatedVideo') -> 'exportVariants'
            @> '[{"tier":"B","status":"pending"}]'::jsonb
      ORDER BY "lastActivityAt" ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  }

  /**
   * Одиночные ролики, поданные через Batch API xAI (транспорт Grok =
   * batch, `grok-video-transport.ts`) и ещё не досмотренные — для
   * крон-досмотра `GenerationService.runGrokBatchSyncTick` (М-1.2/М-2.3/
   * М-5.2 седьмого аудита: статус пачки двигал только клиентский опрос,
   * результат у xAI живёт час, а TTL сессии — сутки при дедлайне батча
   * 26 ч). Сужение по индексированной колонке `generationStatus`
   * (тот же приём, что рекомендован для М-5.4), путь JSON — уже по
   * отфильтрованным строкам.
   */
  async findSessionsWithPendingGrokBatch(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "sessions"
      WHERE "generationStatus" = 'processing'
        AND COALESCE("data" -> 'generatedVideo', "liveData" -> 'generatedVideo') ->> 'xaiBatchId' IS NOT NULL
      ORDER BY "lastActivityAt" ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  }

  /**
   * Ролики с готовым Veo-рендером, чья постобработка (обрезка кадра и/или
   * своя озвучка, `PostProductionService`) ещё не завершена — для
   * крон-досмотра `GenerationService.runPostProductionSyncTick`. Тот же
   * класс дефекта, что у яруса B автоэкспорта и Grok-пачек
   * (Е-2.3/М-1.2-5.2): единственный путь, двигавший `postStatus`, —
   * `GET /sessions/:id/video-status`, вызываемый только клиентским
   * поллингом (`useWorkflow.ts`). Закрыл вкладку/свернул приложение до
   * того, как ffmpeg-задача у провайдера завершилась, — `postStatus`
   * остаётся `'pending'` навсегда: даже собственный дедлайн постобработки
   * (`postProductionExpired`) никогда не сработает, потому что его
   * проверяет тот же `poll()`, который без клиента никто не вызывает.
   * Аудит ролика (`VideoAuditService.run`) при этом бессрочно отказывает
   * с «Ролик ещё обрабатывается» — хотя сама внешняя задача давно готова
   * или давно протухла.
   */
  async findSessionsWithPendingPostProduction(
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "sessions"
      WHERE "generationStatus" = 'complete'
        AND COALESCE("data" -> 'generatedVideo', "liveData" -> 'generatedVideo') ->> 'postStatus' = 'pending'
      ORDER BY "lastActivityAt" ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  }

  /**
   * Продлить жизнь сессиям, за которые сейчас идёт внешняя асинхронная
   * работа (пачка xAI до суток): `getSession` — чистое чтение и
   * `lastActivityAt` не сдвигает, поэтому TTL-уборка (24 ч) удаляла
   * такие сессии раньше результата (М-5.2/М-5.3 седьмого аудита).
   * Только колонка, `data` не трогается — гонок с JSON-правками нет.
   */
  async touchSessions(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    await this.prisma.session.updateMany({
      where: { id: { in: sessionIds } },
      data: { lastActivityAt: new Date() },
    });
  }

  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<Session | undefined> {
    return this.updateSession(sessionId, { status });
  }

  /**
   * Софт-delete (этап 89) — заменяет прежний
   * `deleteSessionAndCollectBlobPaths` (этап 88.2, удалял строку и
   * собирал пути файлов синхронно). Оба явных пути удаления сессии —
   * `DELETE /sessions/:id` (пользователь убирает свой ролик из
   * «Постпрода», владение проверяет глобальный `SessionOwnerGuard` до
   * того, как запрос сюда дойдёт) и `AdminPanelService.deleteSession`
   * (оператор в админке) — теперь зовут этот один метод: явный запрос
   * владельца продукта на этапе 89 был «тот же механизм в админке для
   * сессий», а не две параллельные копии одной идеи.
   *
   * Строка помечается `deletedAt` и остаётся в базе весь грейс-период
   * (`SOFT_DELETE_GRACE_MS`, `common/soft-delete.ts`) — `getSession` и
   * админские `listSessions`/`getSession` (`common/session-summary.ts`)
   * читают её как отсутствующую. Физическую уборку строки и файлов в Blob
   * уносит `purgeSoftDeletedSessions()` из крона — тот же приём, что у
   * `ProjectService.deleteProject`/`deleteItem`.
   *
   * `updateMany`, не `update`: не бросает, если строки уже нет или она
   * уже мягко удалена — `count` сам говорит, сработало ли.
   *
   * @returns `deleted=false`, если строки не было или она уже мягко
   * удалена — идемпотентно, вызывающий сам решает, 404 это или тихий успех.
   */
  async softDeleteSession(sessionId: string): Promise<{ deleted: boolean }> {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { deleted: result.count > 0 };
  }

  /**
   * Крон-проход (этап 89): сессии, мягко удалённые больше
   * `SOFT_DELETE_GRACE_MS` назад — та же последовательность «собрать пути
   * → удалить строки», что у `cleanupExpiredSessions()` ниже. Файлы в Blob
   * удаляет вызывающий (`CronJobsService`, у него есть `BlobService`,
   * здесь — нет).
   */
  async purgeSoftDeletedSessions(
    maxSessions = CLEANUP_BATCH,
  ): Promise<SoftDeletePurgeResult> {
    const cutoff = new Date(Date.now() - SOFT_DELETE_GRACE_MS);
    const rows: SessionRow[] = await this.prisma.session.findMany({
      where: { deletedAt: { lt: cutoff } },
      orderBy: { deletedAt: 'asc' },
      take: maxSessions,
    });
    if (rows.length === 0) {
      return { count: 0, blobPathnames: [], hasMore: false };
    }
    const blobPathnames = rows.flatMap((row) =>
      sessionBlobPathnames(this.toSession(row)),
    );
    // Условие по времени повторяется на удалении — та же осторожность,
    // что у `cleanupExpiredSessions`: если строку тронули между выборкой
    // и удалением (маловероятно для уже мягко удалённой, но дёшево
    // перепроверить), лишнего не снесём.
    const result = await this.prisma.session.deleteMany({
      where: {
        id: { in: rows.map((r) => r.id) },
        deletedAt: { lt: cutoff },
      },
    });
    return {
      count: result.count,
      blobPathnames,
      hasMore: rows.length === maxSessions,
    };
  }

  /**
   * Clean up expired sessions (sessions older than TTL)
   * Should be called periodically by a scheduled task
   * @returns Number of sessions cleaned up
   *
   * ## Сессии с готовым роликом не трогаем (этап 88.1)
   *
   * `generationStatus: { not: 'complete' }` в обоих WHERE — до этой правки
   * TTL (по умолчанию 24 ч бездействия, `SESSION_TTL_HOURS`) удалял ЛЮБУЮ
   * сессию, включая уже готовый, оплаченный ролик, если пользователь не
   * открывал её сутки. Ровно тот же класс дефекта, что уже описан на
   * `findSessionsWithPendingTierBExport`/`findSessionsWithPendingPostProduction`
   * (там лечили клиентским поллингом + `touchSessions`, потому что работа
   * ещё шла асинхронно) — но здесь работа уже ЗАВЕРШЕНА, продлевать
   * `lastActivityAt` нечем: `getSession()` (чистое чтение, вкладка
   * «Постпрод») его не двигает. Вкладка «Постпрод» (этап 88) показывает
   * ВСЕ готовые ролики пользователя без ограничения по времени — TTL,
   * бравший верх раньше открытия вкладки, значит ролик физически исчезал
   * из БД и Blob, а `PostprodVideoScreen` показывал «Ролик не найден»
   * (баг, о котором сообщил пользователь после этапа 88). Сессии без
   * готового ролика (черновики, брошенные на середине) по-прежнему
   * подчищаются штатно — прячем от TTL только `generationStatus =
   * 'complete'`. `not: 'complete'` на nullable-колонке включает и `NULL`
   * (черновик без generatedVideo вообще), что и требуется.
   *
   * `deletedAt: null` (этап 89) — мягко удалённая сессия не нуждается в
   * этой уборке: она уже ждёт `purgeSoftDeletedSessions()` (свой,
   * более короткий срок — `SOFT_DELETE_GRACE_MS`), и подхватывать её
   * ещё и здесь незачем.
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
      where: {
        lastActivityAt: { lt: cutoff },
        generationStatus: { not: 'complete' },
        deletedAt: null,
      },
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
    // `generationStatus` повторён по той же причине, что и выше — на
    // случай, если рендер успел завершиться между выборкой и удалением.
    const result = await this.prisma.session.deleteMany({
      where: {
        id: { in: rows.map((r) => r.id) },
        lastActivityAt: { lt: cutoff },
        generationStatus: { not: 'complete' },
        deletedAt: null,
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
    // Две колонки, одна сессия (этап 122): горячие ключи лежат в
    // `liveData`, остальное — в `data`; читателю разница не видна.
    const data = sessionData(row);

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
      // М-2.1/М-5.1 седьмого аудита — третий случай класса Б-2.2 в этом
      // же методе (после `locale`): ключ писался (`DATA_KEYS`), но не
      // читался, поэтому `[previous, ...(session.videoHistory ?? [])]`
      // в generation.service.ts всегда собирал массив из ОДНОГО элемента
      // — история версий молча усекалась при каждом старте, а файлы
      // прошлых попыток выпадали из `sessionBlobPathnames`. Тест
      // `session.service.spec.ts` («каждый DATA_KEYS читается обратно»)
      // закрывает класс целиком.
      videoHistory: (data.videoHistory ?? undefined) as Session['videoHistory'],
      userId: row.userId ?? null,
      projectId: row.projectId ?? null,
      productItemId: row.productItemId ?? null,
    };
  }
}
