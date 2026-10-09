/**
 * Заход 11, Р-З11-В3: отчёт недели «Админки» и утренняя сводка — ОДНО
 * сообщение владельцу в день отчёта (закрывает хвост захода 10 «два
 * сообщения владельцам „Админки“»; уточняет Р-З10-37: режимы по-прежнему
 * считаются независимо, общим стал только способ доставки).
 *
 *  - неделя «Админки» готова, а сегодняшняя сводка `assist-digest` ещё не
 *    прошла (замок крона `assist-digest`: последний старт — не сегодня по
 *    UTC, но не старше суток с запасом — сводка жива) → отчёт НЕ шлётся, а
 *    ставится в ожидание: chat id получателей и готовые тексты uk/ru/en —
 *    в строку выводов недели (`digestPending`, `digestTexts`);
 *  - сводка, собирая сообщение получателю с разделом «Админка», забирает
 *    его id из ожидания условным UPDATE (`claim`) и дописывает отчёт недели
 *    разделом на ЕГО языке, с второй кнопкой «Статистика „Админки“»; не
 *    влезло в 4 096 символов — не забирает; не отправилось — возвращает
 *    (`release`);
 *  - остаток (получатель без сводки: отписан, не владелец и не менеджер
 *    «Сайта», у сайта нет опубликованного виджета, сводка упала) досылает
 *    крон «Админки» ОТДЕЛЬНЫМ сообщением, когда сводка, стартовавшая после
 *    постановки, закончилась, или через `ADMIN_DIGEST_WAIT_MS` — страховка;
 *  - сводка уже прошла сегодня или не работает вовсе → отчёт уходит сразу,
 *    как раньше. Каждый id забирается одним UPDATE — дублей нет.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ASSIST_DIGEST_CRON_JOB } from '../../common/cron-job-lock';
import { PrismaService, SITES_DB_SCHEMA } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import type { NotifyLang } from '../assist-knowledge-core/notify';

/** Страховка: ожидание сводки дольше — досылаем отдельно. */
export const ADMIN_DIGEST_WAIT_MS = 8 * 60 * 60_000;
/** Сводка «жива», если стартовала не раньше (сутки + запас). */
export const ADMIN_DIGEST_ALIVE_MS = 36 * 60 * 60_000;

export type AdminWeeklyTexts = Record<
  NotifyLang,
  { text: string; button: string }
>;

/** Состояние замка сводки (`site_cron_locks`, ключ `assist-digest`). */
export interface DigestCronState {
  lastStartedAt: Date | null;
  lockedUntil: Date | null;
}

const DAY_MS = 24 * 60 * 60_000;
const startOfUtcDay = (d: Date) =>
  new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);

/**
 * Ставить ли готовый отчёт в ожидание сводки: сводка жива (стартовала за
 * `ADMIN_DIGEST_ALIVE_MS`) и сегодня (UTC) ещё не стартовала.
 */
export function digestAhead(now: Date, d: DigestCronState | null): boolean {
  const at = d?.lastStartedAt ?? null;
  if (!at) return false;
  if (at.getTime() < now.getTime() - ADMIN_DIGEST_ALIVE_MS) return false;
  return at.getTime() < startOfUtcDay(now).getTime();
}

/**
 * Можно ли досылать остаток ожидания: сводка стартовала ПОСЛЕ постановки и
 * закончилась (замок снят или истёк) — или ждём дольше страховки.
 */
export function digestPassed(
  now: Date,
  pendingAt: Date,
  d: DigestCronState | null,
): boolean {
  if (now.getTime() - pendingAt.getTime() >= ADMIN_DIGEST_WAIT_MS) return true;
  const at = d?.lastStartedAt ?? null;
  if (!at || at.getTime() <= pendingAt.getTime()) return false;
  const lock = d?.lockedUntil ?? null;
  return !lock || lock.getTime() <= now.getTime();
}

const LANGS: readonly NotifyLang[] = ['uk', 'ru', 'en'];

/** Тексты из строки (JSON) — только полные uk/ru/en; иначе null. */
export function parseWeeklyTexts(raw: unknown): AdminWeeklyTexts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out = {} as AdminWeeklyTexts;
  for (const l of LANGS) {
    const v = o[l] as { text?: unknown; button?: unknown } | null | undefined;
    if (
      !v ||
      typeof v !== 'object' ||
      typeof v.text !== 'string' ||
      !v.text ||
      typeof v.button !== 'string'
    ) {
      return null;
    }
    out[l] = { text: v.text, button: v.button };
  }
  return out;
}

export interface AdminWeeklyPending {
  id: string;
  weekStart: string;
  chatIds: string[];
  texts: AdminWeeklyTexts;
}

const T = `"${SITES_DB_SCHEMA}"."assist_admin_insights"`;

/**
 * Доступ сводки к ожидающему отчёту недели. Экспортируется модулем
 * аналитики «Админки» для assist-digest (оркестратор — единственный, кто
 * собирает «Сайт» и «Админку» в одно сообщение, правило `digest-leaf`).
 */
@Injectable()
export class AdminWeeklyDigest {
  /** Ключ замка сводки; подмена — только тестами (своя строка замка). */
  digestJobKey: string = ASSIST_DIGEST_CRON_JOB;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
  ) {}

  /**
   * Часы БАЗЫ (аудит з11 P3-6): `lastStartedAt`/`lockedUntil` замка сводки
   * пишутся по `now()` базы — постановка в ожидание и сравнения идут по
   * тем же часам, а не по часам инстанса. Подмена — только тестами.
   */
  async dbNow(): Promise<Date> {
    const [r] = await this.prisma.$queryRawUnsafe<Array<{ now: Date }>>(
      'SELECT now() AS "now"',
    );
    return r.now;
  }

  /** Состояние замка сводки (нет строки — сводка не запускалась). */
  async digestState(): Promise<DigestCronState | null> {
    const r = await this.prisma.siteCronLock.findUnique({
      where: { jobKey: this.digestJobKey },
      select: { lastStartedAt: true, lockedUntil: true },
    });
    return r ?? null;
  }

  /**
   * Последний отчёт недели сайта, ждущий раздела сводки (отчёт включён в
   * настройках «Админки»; тексты целы). Нет — null.
   */
  async pending(
    accountId: string,
    siteId: string,
  ): Promise<AdminWeeklyPending | null> {
    const db = this.sitesDb.forAccount(accountId);
    const row = await db.assistAdminInsight.findFirst({
      where: {
        siteId,
        digestPendingAt: { not: null },
        NOT: { digestPending: { isEmpty: true } },
      },
      orderBy: { weekStart: 'desc' },
      select: {
        id: true,
        weekStart: true,
        digestPending: true,
        digestTexts: true,
      },
    });
    if (!row) return null;
    const texts = parseWeeklyTexts(row.digestTexts);
    if (!texts) return null;
    const settings = await db.assistAdminSettings.findFirst({
      where: { siteId },
      select: { weeklyReport: true },
    });
    if (!settings?.weeklyReport) return null;
    return {
      id: row.id,
      weekStart: row.weekStart,
      chatIds: row.digestPending,
      texts,
    };
  }

  /** Забрать получателя из ожидания (true — забрал именно этот вызов). */
  async claim(accountId: string, id: string, chatId: bigint): Promise<boolean> {
    const n = await this.prisma.$executeRawUnsafe(
      `UPDATE ${T}
          SET "digestPending" = array_remove("digestPending", $3),
              "updatedAt" = now()
        WHERE "id" = $1 AND "accountId" = $2 AND $3 = ANY("digestPending")`,
      id,
      accountId,
      chatId.toString(),
    );
    return n === 1;
  }

  /** Сводка не ушла — вернуть получателя: досылка отправит отдельно. */
  async release(accountId: string, id: string, chatId: bigint): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE ${T}
          SET "digestPending" = array_append("digestPending", $3),
              "updatedAt" = now()
        WHERE "id" = $1 AND "accountId" = $2
          AND "digestPendingAt" IS NOT NULL
          AND NOT ($3 = ANY("digestPending"))`,
      id,
      accountId,
      chatId.toString(),
    );
  }

  /**
   * Вернуть несколько получателей (досылка упала между забором и отправкой,
   * аудит з11 P3-5) — без повторов.
   */
  async releaseMany(
    accountId: string,
    id: string,
    chatIds: string[],
  ): Promise<void> {
    if (!chatIds.length) return;
    await this.prisma.$executeRawUnsafe(
      `UPDATE ${T}
          SET "digestPending" = ARRAY(
                SELECT DISTINCT x FROM unnest("digestPending" || $3::text[]) AS x
              ),
              "updatedAt" = now()
        WHERE "id" = $1 AND "accountId" = $2 AND "digestPendingAt" IS NOT NULL`,
      id,
      accountId,
      chatIds,
    );
  }

  /**
   * Забрать ВЕСЬ остаток ожидания строки (досылка) — атомарно. НЕ убирать
   * `FOR UPDATE`: без него CTE читает старый массив, не дожидаясь `claim`
   * сводки, и получатель получит отчёт дважды (тест гонки двух соединений —
   * digest-admin-weekly.db.spec.ts).
   */
  async takeRest(accountId: string, id: string): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ taken: string[] | null }>
    >(
      // Строка блокируется FOR UPDATE: параллельный `claim` сводки ждёт и
      // после фиксации не найдёт своего id — каждому одно сообщение.
      `WITH old AS (
         SELECT "id", "digestPending" AS taken FROM ${T}
          WHERE "id" = $1 AND "accountId" = $2
          FOR UPDATE
       )
       UPDATE ${T} AS t
          SET "digestPending" = ARRAY[]::text[], "updatedAt" = now()
         FROM old
        WHERE t."id" = old."id" AND cardinality(old.taken) > 0
        RETURNING old.taken`,
      id,
      accountId,
    );
    return rows[0]?.taken ?? [];
  }

  /** Строки с непустым ожиданием (все сайты или `siteIds` — тесты). */
  async pendingRows(
    siteIds?: string[] | null,
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      accountId: string;
      siteId: string;
      digestPendingAt: Date;
      digestTexts: Prisma.JsonValue;
    }>
  > {
    return this.prisma.$queryRawUnsafe(
      `SELECT "id", "accountId", "siteId", "digestPendingAt", "digestTexts"
         FROM ${T}
        WHERE cardinality("digestPending") > 0
          AND "digestPendingAt" IS NOT NULL
          AND ($1::text[] IS NULL OR "siteId" = ANY($1::text[]))
        ORDER BY "digestPendingAt" LIMIT $2`,
      siteIds ?? null,
      limit,
    );
  }
}
