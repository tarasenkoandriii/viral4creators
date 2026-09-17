/**
 * Сводка «моих готовых роликов» — для вкладки «Постпрод» в TMA (этап 88:
 * «добавить вкладку постпрод — на ней список роликов которые возможно
 * переозвучить и весь комплект постпродакшена перенести туда»). Список
 * показывает ВСЕ готовые ролики пользователя (не только пригодные для
 * переозвучки — экспорт/публикация/шаринг применимы к любому), но у
 * каждой строки есть `canRevoice`, чтобы фронтенд показывал кнопку
 * «Переозвучить» только там, где это в принципе возможно.
 *
 * Тот же приём, что у session-summary.ts (админский список сессий):
 * JSON-путь читаем прямо в SELECT, не через Prisma `select` (она не
 * умеет JSON-путь) и не вытягивая всю колонку `data` целиком — на
 * список из многих сессий одного активного пользователя это ощутимо
 * дороже (см. доккомментарий в session-summary.ts и предупреждение в
 * schema.prisma у `data`). В отличие от admin-panel, здесь ровно три
 * условия в WHERE (userId + generationStatus='complete' +
 * deletedAt IS NULL, все — индексные колонки, не JSON-путь) и
 * фиксированная сортировка (самый недавний ролик первым) — отдельная
 * `buildWhere`/выбор колонки сортировки не нужны.
 *
 * `deletedAt IS NULL` (этап 89, найдено доп. аудитом — CRITICAL): без
 * этого условия мягко удалённая Session (см. common/soft-delete.ts)
 * весь грейс-период продолжала всплывать в списке «Постпрод» — ролик,
 * который пользователь только что удалил, оставался виден и открывался
 * заново, хотя `PostprodVideoScreen`'а по прямому GET-у по id уже
 * фильтрует то же поле (`SessionService.getSession`).
 */
import { PrismaService } from '../prisma/prisma.service';

export interface PostprodVideoSummaryRow {
  sessionId: string;
  createdAt: Date;
  lastActivityAt: Date;
  productName: string | null;
  generatedVideoId: string | null;
  downloadUrl: string | null;
  renderedUrl: string | null;
  postStatus: string | null;
  voiceMode: string | null;
  aspectRatio: string | null;
  quality: string | null;
  provider: string | null;
  resolution: string | null;
}

const SELECT_FROM = `
  SELECT s."id" AS "sessionId", s."createdAt", s."lastActivityAt",
         s."data" -> 'productInformation' ->> 'productName' AS "productName",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'generatedVideoId' AS "generatedVideoId",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'downloadUrl' AS "downloadUrl",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'renderedUrl' AS "renderedUrl",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'postStatus' AS "postStatus",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'voiceMode' AS "voiceMode",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'aspectRatio' AS "aspectRatio",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'quality' AS "quality",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'provider' AS "provider",
         COALESCE(s."data" -> 'generatedVideo', s."liveData" -> 'generatedVideo') ->> 'resolution' AS "resolution"
  FROM "sessions" s
  WHERE s."userId" = $1 AND s."generationStatus" = 'complete'
    AND s."deletedAt" IS NULL
`;

/** `skip`/`take` — уже нормализованные (см. controller: page/pageSize
 * зажаты в разумные границы раньше, чем дошли досюда). */
export async function selectPostprodVideoSummaries(
  prisma: PrismaService,
  userId: string,
  skip: number,
  take: number,
): Promise<PostprodVideoSummaryRow[]> {
  // Тай-брейкер по id — тот же приём, что в session-summary.ts: без него
  // строки с одинаковым createdAt на границе страницы могут поменять
  // порядок между запросами.
  const sql = `${SELECT_FROM} ORDER BY s."createdAt" DESC, s."id" DESC LIMIT $2 OFFSET $3`;
  return prisma.$queryRawUnsafe<PostprodVideoSummaryRow[]>(
    sql,
    userId,
    take,
    skip,
  );
}

export async function countPostprodVideoSummaries(
  prisma: PrismaService,
  userId: string,
): Promise<number> {
  const sql = `SELECT COUNT(*)::bigint AS "count" FROM "sessions" s WHERE s."userId" = $1 AND s."generationStatus" = 'complete' AND s."deletedAt" IS NULL`;
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(sql, userId);
  return Number(rows[0]?.count ?? 0);
}
