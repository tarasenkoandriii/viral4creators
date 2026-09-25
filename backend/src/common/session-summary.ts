/**
 * Сводка сессии для списков админки — без колонки `data` целиком (этап
 * 51, В-4.4). См. исходный доккомментарий ниже за тем, почему JSON не
 * тянется целиком; этот файл расширен доп. запросом владельца продукта
 * («ролики и их статусы — с пагинацией, сортировками и фильтрами по
 * колонкам») — добавлены владелец (тариф/логин, JOIN на `users`),
 * качество рендера и режим озвучки (те же JSON-пути, тот же принцип
 * «дешёвый путь дороже колонки целиком, но дешевле, чем читать её»), и
 * управляемая сортировка.
 *
 * Prisma не умеет выбирать JSON-путь в `select`, поэтому запрос сырой
 * (как и был). Колонка сортировки — из фиксированного набора в коде
 * (`SORT_COLUMN` ниже), никогда не строка от клиента: имя колонки в SQL
 * не может быть параметром, поэтому запрос собирается через
 * `$queryRawUnsafe` с ЯВНО параметризованными значениями (`$1, $2, …`)
 * и ЛИТЕРАЛЬНЫМ (не параметризованным) текстом столбца/направления,
 * который приходит только из этой карты — не из HTTP-запроса напрямую
 * (контроллер валидирует значение против того же списка ключей раньше,
 * чем оно попадает сюда).
 */
import { PrismaService } from '../prisma/prisma.service';

export interface SessionSummaryRow {
  id: string;
  status: string;
  generationStatus: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  userId: string | null;
  ownerPlan: string | null;
  ownerUsername: string | null;
  ownerFirstName: string | null;
  productName: string | null;
  downloadUrl: string | null;
  quality: string | null;
  /** `data.generatedVideo.provider` — 'veo' | 'grok' | null (отсутствие
   * значит 'veo', см. doc-комментарий у `quality`/`resolution` ниже). */
  provider: string | null;
  /** `data.generatedVideo.resolution` — своя ось качества у Grok
   * ('480p' | '720p' | '1080p'), не совпадает с `quality` (та только у
   * Veo). Без этого поля колонка «Качество» у Grok-роликов всегда
   * читала пустой `quality` и показывала прочерк — не потому что
   * данных нет, а потому что не тот путь читали (этап 86). */
  resolution: string | null;
  voiceMode: string | null;
  /** Доп. запрос владельца продукта: причина провала рендера — видна
   * прямо в списке, не только при переходе в детали сессии. */
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
}

export const SESSION_SORT_KEYS = [
  'createdAt',
  'lastActivityAt',
  'status',
  'plan',
] as const;
export type SessionSortKey = (typeof SESSION_SORT_KEYS)[number];

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export function isSessionSortKey(v: unknown): v is SessionSortKey {
  return (
    typeof v === 'string' &&
    (SESSION_SORT_KEYS as readonly string[]).includes(v)
  );
}

export function isSortDirection(v: unknown): v is SortDirection {
  return (
    typeof v === 'string' && (SORT_DIRECTIONS as readonly string[]).includes(v)
  );
}

/** Литеральный (не параметризованный) фрагмент — только из этой карты. */
const SORT_COLUMN: Record<SessionSortKey, string> = {
  createdAt: 's."createdAt"',
  lastActivityAt: 's."lastActivityAt"',
  status: 's."status"',
  // `u` — LEFT JOIN, у анонимных сессий NULL; в конец списка, а не
  // вперемешку с настоящими тарифами.
  plan: 'u."plan"',
};

export interface SummaryQuery {
  status?: string;
  userId?: string;
  /** `data.generatedVideo.quality` — 'fast' | 'standard'. */
  quality?: string;
  /** `data.brandManifestSnapshot.voiceMode` — 'veo' | 'voiceover' | 'dub'. */
  voiceMode?: string;
  /** Тариф владельца — 'LITE' | 'STANDARD' | 'PREMIUM'. */
  plan?: string;
  /** Включительно, начало суток UTC. */
  createdFrom?: Date;
  /** Включительно, конец суток UTC. */
  createdTo?: Date;
  /**
   * Подстрока по username/firstName/telegramId владельца, без учёта
   * регистра, ИЛИ точное совпадение по id сессии: из карточки находки
   * (вкладка «Тестирование») сюда приходят именно с id.
   */
  search?: string;
  sortBy: SessionSortKey;
  sortDir: SortDirection;
  skip?: number;
  take: number;
}

/** Общая часть WHERE — одна и та же для выборки и подсчёта. */
function buildWhere(
  q: Omit<SummaryQuery, 'sortBy' | 'sortDir' | 'skip' | 'take'>,
): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  // Мягко удалённая сессия (этап 89, `deletedAt`) — не показываем её
  // оператору так же, как не показываем владельцу (`SessionService.
  // getSession`): в грейс-период до физической уборки
  // (`purgeSoftDeletedSessions`) строка ещё жива в базе, но уже не
  // существует ни для кого, кто её не удалял.
  const conditions: string[] = [`s."deletedAt" IS NULL`];
  if (q.status) conditions.push(`s."status" = ${bind(q.status)}`);
  if (q.userId) conditions.push(`s."userId" = ${bind(q.userId)}`);
  if (q.quality) {
    conditions.push(
      `COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'quality' = ${bind(q.quality)}`,
    );
  }
  if (q.voiceMode) {
    conditions.push(
      `s."data" -> 'brandManifestSnapshot' ->> 'voiceMode' = ${bind(q.voiceMode)}`,
    );
  }
  if (q.plan) conditions.push(`u."plan"::text = ${bind(q.plan)}`);
  if (q.createdFrom) conditions.push(`s."createdAt" >= ${bind(q.createdFrom)}`);
  if (q.createdTo) conditions.push(`s."createdAt" <= ${bind(q.createdTo)}`);
  if (q.search) {
    const pattern = bind(`%${q.search}%`);
    // Точное совпадение по id сессии — рядом с поиском по владельцу
    // (аудит этапа 158). Из карточки находки оператор приходит сюда с
    // конкретным id, и без этого условия поиск по нему возвращал
    // пустоту: он искал только владельцев. Точное, а не подстрокой —
    // это первичный ключ, и `ILIKE '%…%'` по нему означал бы
    // последовательный просмотр таблицы ради того, чего не бывает.
    const exact = bind(q.search);
    conditions.push(
      `(u."username" ILIKE ${pattern} OR u."firstName" ILIKE ${pattern} ` +
        `OR u."telegramId" ILIKE ${pattern} OR s."id" = ${exact})`,
    );
  }
  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

const SELECT_FROM = `
  SELECT s."id", s."status", s."generationStatus", s."createdAt", s."lastActivityAt", s."userId",
         u."plan"::text AS "ownerPlan", u."username" AS "ownerUsername", u."firstName" AS "ownerFirstName",
         s."data" -> 'productInformation' ->> 'productName' AS "productName",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'downloadUrl' AS "downloadUrl",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'quality' AS "quality",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'provider' AS "provider",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'resolution' AS "resolution",
         s."data" -> 'brandManifestSnapshot' ->> 'voiceMode' AS "voiceMode",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') -> 'error' ->> 'code' AS "errorCode",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') -> 'error' ->> 'message' AS "errorMessage",
         (COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') -> 'error' ->> 'retryable')::boolean AS "errorRetryable"
  FROM "sessions" s
  LEFT JOIN "users" u ON u."id" = s."userId"
`;

export async function selectSessionSummaries(
  prisma: PrismaService,
  q: SummaryQuery,
): Promise<SessionSummaryRow[]> {
  const { clause, params } = buildWhere(q);
  const column = SORT_COLUMN[q.sortBy];
  const dir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
  // Тай-брейкер по id: без него строки с одинаковым значением сортировки
  // (тариф, статус) на границе страницы могут менять порядок между
  // запросами — постоянный ключ убирает эту неопределённость.
  const orderBy = `ORDER BY ${column} ${dir} NULLS LAST, s."id" ${dir}`;
  const takeIdx = params.push(q.take);
  const skipIdx = params.push(q.skip ?? 0);
  const sql = `${SELECT_FROM} ${clause} ${orderBy} LIMIT $${takeIdx} OFFSET $${skipIdx}`;
  return prisma.$queryRawUnsafe<SessionSummaryRow[]>(sql, ...params);
}

/** Тот же фильтр, без сортировки/пагинации — для общего числа строк. */
export async function countSessionSummaries(
  prisma: PrismaService,
  q: Omit<SummaryQuery, 'sortBy' | 'sortDir' | 'skip' | 'take'>,
): Promise<number> {
  const { clause, params } = buildWhere(q);
  const sql = `SELECT COUNT(*)::bigint AS "count" FROM "sessions" s LEFT JOIN "users" u ON u."id" = s."userId" ${clause}`;
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    sql,
    ...params,
  );
  return Number(rows[0]?.count ?? 0);
}
