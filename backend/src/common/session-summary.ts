/**
 * Сводка сессии для списков админки — без колонки `data` (этап 51, В-4.4).
 *
 * `toSummary` читает из JSON два поля — название товара и ссылку на
 * ролик, — а `findMany` без `select` тянул `data` целиком: 231 КБ на
 * страницу в 20 строк, 118 КБ на карточку пользователя. В базе разницы
 * почти нет (Postgres детоастит и так), вся цена — сеть через пулер и
 * `JSON.parse` в функции. Prisma не умеет выбирать JSON-путь в `select`,
 * поэтому запрос сырой.
 *
 * Тот же дефект уже чинили на этапе 44 для библиотеки (Б-1.8); здесь он
 * остался в двух местах — списке сессий и карточке пользователя.
 */
import { PrismaService } from '../prisma/prisma.service';

export interface SessionSummaryRow {
  id: string;
  status: string;
  createdAt: Date;
  lastActivityAt: Date;
  userId: string | null;
  productName: string | null;
  downloadUrl: string | null;
}

export interface SummaryQuery {
  status?: string;
  userId?: string;
  orderBy: 'createdAt' | 'lastActivityAt';
  skip?: number;
  take: number;
}

export async function selectSessionSummaries(
  prisma: PrismaService,
  q: SummaryQuery,
): Promise<SessionSummaryRow[]> {
  // Необязательные фильтры — nullable-параметры, а не склейка строк:
  // `$n IS NULL OR col = $n` планировщик сворачивает при известном
  // значении. Сортировка — две ветки одного запроса: имя колонки в SQL
  // не может быть параметром, а произвольной строке там делать нечего.
  const status = q.status ?? null;
  const userId = q.userId ?? null;
  const skip = q.skip ?? 0;
  if (q.orderBy === 'createdAt') {
    return prisma.$queryRaw<SessionSummaryRow[]>`
      SELECT "id", "status", "createdAt", "lastActivityAt", "userId",
             "data" -> 'productInformation' ->> 'productName' AS "productName",
             "data" -> 'generatedVideo' ->> 'downloadUrl' AS "downloadUrl"
      FROM "sessions"
      WHERE (${status}::text IS NULL OR "status" = ${status})
        AND (${userId}::text IS NULL OR "userId" = ${userId})
      ORDER BY "createdAt" DESC
      LIMIT ${q.take} OFFSET ${skip}
    `;
  }
  return prisma.$queryRaw<SessionSummaryRow[]>`
    SELECT "id", "status", "createdAt", "lastActivityAt", "userId",
           "data" -> 'productInformation' ->> 'productName' AS "productName",
           "data" -> 'generatedVideo' ->> 'downloadUrl' AS "downloadUrl"
    FROM "sessions"
    WHERE (${status}::text IS NULL OR "status" = ${status})
      AND (${userId}::text IS NULL OR "userId" = ${userId})
    ORDER BY "lastActivityAt" DESC
    LIMIT ${q.take} OFFSET ${skip}
  `;
}
