/**
 * Мастер проверки Т-2 под ролью `assist_public` — ровно тот SQL, что
 * сверяет `prisma/assist-public-role.spec.ts` (Э6-бис (г)): обмен
 * одноразовой ссылки на тестовую сессию (один условный UPDATE), чтение
 * своей сессии, сдача отчёта (один условный UPDATE своей непринятой строки),
 * планы этой сессии (табличный SELECT на планы — с (а)). Строку теста
 * создаёт кабинет (основная роль); INSERT роли не нужен.
 *
 * Токены и сессии — только SHA-256 (как предпросмотр, §3-бис.4).
 */
import { createHash } from 'crypto';

const TESTS = '"sites"."assist_site_voice_tests"';
const PLANS = '"sites"."assist_site_ui_plans"';

export interface VoiceTestDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface VoiceTestSessionRow {
  id: string;
  host: string;
  testHost: boolean;
}

/**
 * Обмен ссылки: только тот сайт, тот origin страницы, срок не вышел, ещё не
 * обменян. Любая причина отказа — одинаковое `null` (не оракул токенов).
 */
export async function exchangeTestToken(
  db: VoiceTestDb,
  p: {
    tokenHash: string;
    siteId: string;
    origin: string;
    visitorId: string;
    sessionHash: string;
    sessionExpiresAt: Date;
    now: Date;
  },
): Promise<VoiceTestSessionRow | null> {
  const rows = await db.$queryRawUnsafe<VoiceTestSessionRow[]>(
    `UPDATE ${TESTS}
        SET "usedAt" = $5, "sessionHash" = $6, "sessionExpiresAt" = $7, "visitorId" = $4
      WHERE "tokenHash" = $1 AND "siteId" = $2 AND "origin" = $3
        AND "usedAt" IS NULL AND "tokenExpiresAt" > $5
      RETURNING "id", "host", "testHost"`,
    p.tokenHash,
    p.siteId,
    p.origin,
    p.visitorId,
    p.now,
    p.sessionHash,
    p.sessionExpiresAt,
  );
  return rows[0] ?? null;
}

/** Живая тестовая сессия ЭТОГО посетителя этого сайта (отчёт ещё не сдан). */
export async function readTestSession(
  db: VoiceTestDb,
  p: { sessionHash: string; siteId: string; visitorId: string; now: Date },
): Promise<VoiceTestSessionRow | null> {
  const rows = await db.$queryRawUnsafe<VoiceTestSessionRow[]>(
    `SELECT "id", "host", "testHost" FROM ${TESTS}
      WHERE "sessionHash" = $1 AND "siteId" = $2 AND "visitorId" = $3
        AND "sessionExpiresAt" > $4 AND "reportedAt" IS NULL`,
    p.sessionHash,
    p.siteId,
    p.visitorId,
    p.now,
  );
  return rows[0] ?? null;
}

export interface TestPlanRow {
  id: string;
  status: string;
  steps: unknown;
  dryRun: boolean;
  utteranceMasked: string;
  pageUrl: string;
  lang: string | null;
}

/** Планы тестовой сессии (сухие и с нажатием) — истина для отчёта. */
export async function readTestPlans(
  db: VoiceTestDb,
  p: { testId: string; siteId: string; visitorId: string },
): Promise<TestPlanRow[]> {
  return db.$queryRawUnsafe<TestPlanRow[]>(
    `SELECT "id", "status", "steps", "dryRun", "utteranceMasked", "pageUrl", "lang" FROM ${PLANS}
      WHERE "voiceTestId" = $1 AND "siteId" = $2 AND "visitorId" = $3
      ORDER BY "createdAt" ASC LIMIT 50`,
    p.testId,
    p.siteId,
    p.visitorId,
  );
}

/** Сдать отчёт: один раз, своей сессией, пока сессия жива. */
export async function writeTestReport(
  db: VoiceTestDb,
  p: {
    id: string;
    siteId: string;
    visitorId: string;
    report: unknown;
    result: string;
    validUntil: Date;
    release: string | null;
    pages: unknown;
    now: Date;
  },
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE ${TESTS}
        SET "report" = $4::jsonb, "result" = $5, "validUntil" = $6, "release" = $7, "pages" = $8::jsonb, "reportedAt" = $9
      WHERE "id" = $1 AND "siteId" = $2 AND "visitorId" = $3
        AND "reportedAt" IS NULL AND "sessionExpiresAt" > $9
      RETURNING "id"`,
    p.id,
    p.siteId,
    p.visitorId,
    JSON.stringify(p.report),
    p.result,
    p.validUntil,
    p.release,
    JSON.stringify(p.pages),
    p.now,
  );
  return rows.length > 0;
}

/**
 * Предохранитель (§5-бис.14): нарушение запрета — сайт в `off` сразу.
 * Функция базы умеет только выключить (миграция _assist_voice_control_check).
 */
export async function tripVoiceControl(
  db: VoiceTestDb,
  p: { siteId: string; reason: string },
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT "sites"."assist_vc_trip"($1, $2) AS ok`,
    p.siteId,
    p.reason,
  );
  return rows[0]?.ok === true;
}
