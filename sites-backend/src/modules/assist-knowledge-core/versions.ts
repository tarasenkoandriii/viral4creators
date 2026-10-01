/**
 * Версии базы знаний режима (§4-тер.2) — K2. Работает по таблицам из
 * KnowledgeTables (имена передаёт модуль режима), только сырым SQL с
 * обязательными "siteId" и "accountId".
 *
 * Версия — членство: у фрагмента `versions int[]`. Здесь — жизненный
 * цикл записи версии и её членства:
 *  - `acquire` — номер новой версии и «замок сборки»: строка настроек
 *    режима берётся FOR UPDATE, и пока у сайта есть свежая версия в
 *    building/checking, вторая сборка не начинается (две сборки от одного
 *    родителя потеряли бы изменения друг друга при публикации);
 *  - `publish` — одной транзакцией статус версии + settings.knowledgeVersion
 *    (поиск видит старую базу или новую целиком, не смесь); более старые
 *    удержанные версии при этом устаревают (discarded);
 *  - `removeNumbers`/`prune` — окно отката (7 дней / 5 публикаций):
 *    номера вне окна убираются из `versions`, фрагменты без версий
 *    удаляются физически.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { KNOWLEDGE_DEFAULTS } from '../../config/assist-defaults';
import type { PrismaService } from '../../prisma/prisma.service';
import { qualified, type KnowledgeTables } from './tables';
import type {
  GateReport,
  KnowledgeCtx,
  VersionStatus,
  VersionTrigger,
} from './types';

/** Минимум сырого клиента: и PrismaService, и клиент транзакции. */
export type RawDb = Pick<
  PrismaService,
  '$queryRawUnsafe' | '$executeRawUnsafe'
>;

/** Сборка, не завершившаяся за это время, считается упавшей. */
export const BUILD_LEASE_MINUTES = 10;

/** id строк, которые пишем сырым SQL (у Prisma cuid — на стороне клиента). */
export function newRowId(): string {
  return `k${Date.now().toString(36)}${randomBytes(9).toString('hex')}`;
}

/** Ошибка режима знаний с машинным кодом (конверт фильтра: error → code). */
export function knowledgeError(
  code: string,
  message: string,
  status: number = HttpStatus.CONFLICT,
): HttpException {
  return new HttpException({ message, error: code, code }, status);
}

export interface VersionRow {
  number: number;
  status: VersionStatus;
  trigger: VersionTrigger;
  parentNumber: number | null;
  stats: Record<string, unknown>;
  gateReport: GateReport | null;
  heldReason: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface SettingsRow {
  knowledgeVersion: number;
  configVersion: number;
  versionSeq: number;
}

export class VersionRepo {
  private readonly S: string;
  private readonly V: string;
  private readonly C: string;
  private readonly D: string;

  constructor(
    readonly tables: KnowledgeTables,
    private readonly db: PrismaService,
  ) {
    this.S = qualified(tables.settings);
    this.V = qualified(tables.versions);
    this.C = qualified(tables.chunks);
    this.D = qualified(tables.documents);
  }

  async settings(ctx: KnowledgeCtx): Promise<SettingsRow | null> {
    const rows = await this.db.$queryRawUnsafe<SettingsRow[]>(
      `SELECT "knowledgeVersion", "configVersion", "versionSeq" FROM ${this.S}
        WHERE "siteId" = $1 AND "accountId" = $2`,
      ctx.siteId,
      ctx.accountId,
    );
    return rows[0] ?? null;
  }

  async get(ctx: KnowledgeCtx, number: number): Promise<VersionRow | null> {
    const rows = await this.db.$queryRawUnsafe<VersionRow[]>(
      `SELECT "number", "status", "trigger", "parentNumber", "stats", "gateReport",
              "heldReason", "createdAt", "publishedAt"
         FROM ${this.V} WHERE "siteId" = $1 AND "accountId" = $2 AND "number" = $3`,
      ctx.siteId,
      ctx.accountId,
      number,
    );
    return rows[0] ?? null;
  }

  /**
   * Новый номер версии от опубликованной. null — у сайта идёт другая сборка
   * (вызывающий решает: ждать, отложить или вернуть «занято»).
   */
  async acquire(
    ctx: KnowledgeCtx,
    p: {
      trigger: VersionTrigger;
      byTelegramId: bigint | null;
      crawlRunId?: string | null;
    },
  ): Promise<{ number: number; parent: number } | null> {
    const stale: number[] = [];
    const res = await this.db.$transaction(async (tx) => {
      const s = await tx.$queryRawUnsafe<{ knowledgeVersion: number }[]>(
        `SELECT "knowledgeVersion" FROM ${this.S}
          WHERE "siteId" = $1 AND "accountId" = $2 FOR UPDATE`,
        ctx.siteId,
        ctx.accountId,
      );
      if (!s[0]) {
        throw new Error(
          `Нет строки настроек режима ${this.tables.mode} для сайта — ensureSettings не вызван`,
        );
      }
      const active = await tx.$queryRawUnsafe<
        { number: number; fresh: boolean }[]
      >(
        `SELECT "number", "createdAt" > now() - make_interval(mins => $3) AS fresh
           FROM ${this.V}
          WHERE "siteId" = $1 AND "accountId" = $2 AND "status" IN ('building', 'checking')`,
        ctx.siteId,
        ctx.accountId,
        BUILD_LEASE_MINUTES,
      );
      if (active.some((a) => a.fresh)) return null;
      for (const a of active) stale.push(a.number);
      if (stale.length) {
        await tx.$executeRawUnsafe(
          `UPDATE ${this.V} SET "status" = 'discarded', "discardedAt" = now(),
                  "heldReason" = 'сборка прервана (истёк срок)'
            WHERE "siteId" = $1 AND "accountId" = $2 AND "number" = ANY($3::int[])`,
          ctx.siteId,
          ctx.accountId,
          stale,
        );
      }
      const seq = await tx.$queryRawUnsafe<{ versionSeq: number }[]>(
        `UPDATE ${this.S} SET "versionSeq" = "versionSeq" + 1, "updatedAt" = now()
          WHERE "siteId" = $1 AND "accountId" = $2 RETURNING "versionSeq"`,
        ctx.siteId,
        ctx.accountId,
      );
      const number = seq[0].versionSeq;
      const parent = s[0].knowledgeVersion;
      await tx.$executeRawUnsafe(
        `INSERT INTO ${this.V} ("id", "accountId", "siteId", "number", "trigger", "status",
                                "parentNumber", "crawlRunId", "createdByTelegramId", "stats")
         VALUES ($1, $2, $3, $4, $5, 'building', $6, $7, $8, '{}'::jsonb)`,
        newRowId(),
        ctx.accountId,
        ctx.siteId,
        number,
        p.trigger,
        parent,
        p.crawlRunId ?? null,
        p.byTelegramId ?? null,
      );
      return { number, parent };
    });
    if (stale.length) await this.removeNumbers(ctx, stale);
    return res;
  }

  /** acquire с ожиданием (действия человека не должны падать из-за крона). */
  async acquireWaiting(
    ctx: KnowledgeCtx,
    p: Parameters<VersionRepo['acquire']>[1],
    waitMs: number,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ): Promise<{ number: number; parent: number } | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      const got = await this.acquire(ctx, p);
      if (got || Date.now() >= until) return got;
      await sleep(250);
    }
  }

  async setStatusChecking(ctx: KnowledgeCtx, number: number): Promise<void> {
    await this.db.$executeRawUnsafe(
      `UPDATE ${this.V} SET "status" = 'checking'
        WHERE "siteId" = $1 AND "accountId" = $2 AND "number" = $3 AND "status" = 'building'`,
      ctx.siteId,
      ctx.accountId,
      number,
    );
  }

  /**
   * Публикация: одной транзакцией статус версии + knowledgeVersion. Более
   * старые удержанные версии — устарели (их изменения соберёт следующий
   * переобход, см. resetChangedDocs). Возвращает номера устаревших.
   */
  async publish(
    ctx: KnowledgeCtx,
    number: number,
    p: {
      byTelegramId: bigint | null;
      stats?: Record<string, unknown>;
      gateReport?: GateReport | null;
      fromStatuses?: VersionStatus[];
    },
  ): Promise<number[]> {
    const from = p.fromStatuses ?? ['building', 'checking'];
    return this.db.$transaction(async (tx) => {
      const s = await tx.$queryRawUnsafe<{ knowledgeVersion: number }[]>(
        `SELECT "knowledgeVersion" FROM ${this.S}
          WHERE "siteId" = $1 AND "accountId" = $2 FOR UPDATE`,
        ctx.siteId,
        ctx.accountId,
      );
      const v = await tx.$queryRawUnsafe<{ parentNumber: number | null }[]>(
        `SELECT "parentNumber" FROM ${this.V}
          WHERE "siteId" = $1 AND "accountId" = $2 AND "number" = $3`,
        ctx.siteId,
        ctx.accountId,
        number,
      );
      // Версия собрана от опубликованной P; если с тех пор опубликовано
      // другое, публикация затёрла бы его изменения (а документы с новым
      // indexedHash следующий обход уже не пересоберёт). Проверка — под
      // тем же FOR UPDATE, что и смена knowledgeVersion.
      if (v[0] && (v[0].parentNumber ?? 0) !== (s[0]?.knowledgeVersion ?? 0)) {
        throw from.includes('held')
          ? knowledgeError(
              'VERSION_NOT_HELD',
              'Версия устарела: после неё база уже обновлялась. Следующий переобход соберёт изменения заново',
            )
          : knowledgeError(
              'KNOWLEDGE_BUSY',
              'База знаний сейчас обновляется — повторите через минуту',
            );
      }
      if (from.includes('held')) {
        // «Опубликовать как есть», пока идёт сборка от той же P: сборка
        // потом опубликовала бы базу без изменений удержанной версии.
        const busy = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${this.V}
            WHERE "siteId" = $1 AND "accountId" = $2 AND "status" IN ('building', 'checking')
              AND "createdAt" > now() - make_interval(mins => $3)`,
          ctx.siteId,
          ctx.accountId,
          BUILD_LEASE_MINUTES,
        );
        if ((busy[0]?.n ?? 0) > 0) {
          throw knowledgeError(
            'KNOWLEDGE_BUSY',
            'База знаний сейчас обновляется — повторите через минуту',
          );
        }
      }
      const n = await tx.$executeRawUnsafe(
        `UPDATE ${this.V}
            SET "status" = 'published', "publishedAt" = now(),
                "checkedAt" = COALESCE("checkedAt", now()),
                "publishedByTelegramId" = $4,
                "stats" = COALESCE($5::jsonb, "stats"),
                "gateReport" = CASE WHEN $6::boolean THEN $7::jsonb ELSE "gateReport" END
          WHERE "siteId" = $1 AND "accountId" = $2 AND "number" = $3
            AND "status" = ANY($8::text[])`,
        ctx.siteId,
        ctx.accountId,
        number,
        p.byTelegramId ?? null,
        p.stats ? JSON.stringify(p.stats) : null,
        p.gateReport !== undefined,
        p.gateReport ? JSON.stringify(p.gateReport) : null,
        from,
      );
      if (n !== 1) {
        throw knowledgeError(
          'VERSION_NOT_HELD',
          'Эту версию нельзя опубликовать: она уже опубликована, отброшена или устарела',
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE ${this.S} SET "knowledgeVersion" = $3, "updatedAt" = now()
          WHERE "siteId" = $1 AND "accountId" = $2`,
        ctx.siteId,
        ctx.accountId,
        number,
      );
      const old = await tx.$queryRawUnsafe<{ number: number }[]>(
        `UPDATE ${this.V}
            SET "status" = 'discarded', "discardedAt" = now(),
                "heldReason" = COALESCE("heldReason" || ' — ', '') || 'устарела: опубликована более новая версия'
          WHERE "siteId" = $1 AND "accountId" = $2 AND "status" = 'held' AND "number" < $3
          RETURNING "number"`,
        ctx.siteId,
        ctx.accountId,
        number,
      );
      return old.map((o) => o.number);
    });
  }

  async hold(
    ctx: KnowledgeCtx,
    number: number,
    p: {
      stats: Record<string, unknown>;
      gateReport: GateReport;
      reason: string;
    },
  ): Promise<void> {
    await this.db.$executeRawUnsafe(
      `UPDATE ${this.V}
          SET "status" = 'held', "checkedAt" = now(), "stats" = $4::jsonb,
              "gateReport" = $5::jsonb, "heldReason" = $6
        WHERE "siteId" = $1 AND "accountId" = $2 AND "number" = $3`,
      ctx.siteId,
      ctx.accountId,
      number,
      JSON.stringify(p.stats),
      JSON.stringify(p.gateReport),
      p.reason,
    );
  }

  /** Отбросить (сборка упала / владелец отбросил / устарела) и убрать членство. */
  async discard(
    ctx: KnowledgeCtx,
    number: number,
    reason: string | null,
    fromStatuses: VersionStatus[] = ['building', 'checking', 'held'],
  ): Promise<boolean> {
    const n = await this.db.$executeRawUnsafe(
      `UPDATE ${this.V}
          SET "status" = 'discarded', "discardedAt" = now(),
              "heldReason" = COALESCE($4, "heldReason")
        WHERE "siteId" = $1 AND "accountId" = $2 AND "number" = $3
          AND "status" = ANY($5::text[])`,
      ctx.siteId,
      ctx.accountId,
      number,
      reason,
      fromStatuses,
    );
    return n === 1;
  }

  async markNotified(ctx: KnowledgeCtx, number: number): Promise<void> {
    await this.db.$executeRawUnsafe(
      `UPDATE ${this.V} SET "notifiedAt" = now()
        WHERE "siteId" = $1 AND "accountId" = $2 AND "number" = $3`,
      ctx.siteId,
      ctx.accountId,
      number,
    );
  }

  /**
   * Документы, чьё членство различается между версиями a и b (что
   * поменялось). Пока обе версии в окне — точный ответ.
   */
  async changedDocs(
    ctx: KnowledgeCtx,
    a: number,
    b: number,
  ): Promise<string[]> {
    const rows = await this.db.$queryRawUnsafe<{ documentId: string }[]>(
      `SELECT DISTINCT "documentId" FROM ${this.C}
        WHERE "siteId" = $1 AND "accountId" = $2
          AND ($3 = ANY("versions")) <> ($4 = ANY("versions"))`,
      ctx.siteId,
      ctx.accountId,
      a,
      b,
    );
    return rows.map((r) => r.documentId);
  }

  /**
   * Документы, чьи изменения выпали из базы (версия отброшена/устарела,
   * откат): `indexedHash = NULL` — следующий переобход пересоберёт их
   * (векторы переиспользуются по contentHash, денег это не стоит).
   */
  async resetDocs(ctx: KnowledgeCtx, documentIds: string[]): Promise<void> {
    if (!documentIds.length) return;
    await this.db.$executeRawUnsafe(
      `UPDATE ${this.D} SET "indexedHash" = NULL, "updatedAt" = now()
        WHERE "siteId" = $1 AND "accountId" = $2 AND "id" = ANY($3::text[])`,
      ctx.siteId,
      ctx.accountId,
      documentIds,
    );
  }

  /** Убрать номера из членства; фрагменты без версий — удалить. */
  async removeNumbers(ctx: KnowledgeCtx, numbers: number[]): Promise<number> {
    if (!numbers.length) return 0;
    await this.db.$executeRawUnsafe(
      `UPDATE ${this.C}
          SET "versions" = ARRAY(SELECT v FROM unnest("versions") v WHERE v <> ALL($3::int[])),
              "updatedAt" = now()
        WHERE "siteId" = $1 AND "accountId" = $2 AND "versions" && $3::int[]`,
      ctx.siteId,
      ctx.accountId,
      numbers,
    );
    return this.db.$executeRawUnsafe(
      `DELETE FROM ${this.C}
        WHERE "siteId" = $1 AND "accountId" = $2 AND cardinality("versions") = 0`,
      ctx.siteId,
      ctx.accountId,
    );
  }

  /**
   * Окно отката: опубликованные за rollbackWindowDays, не больше
   * rollbackMaxPublished последних публикаций (текущая — внутри).
   */
  async rollbackWindow(ctx: KnowledgeCtx): Promise<number[]> {
    const rows = await this.db.$queryRawUnsafe<{ number: number }[]>(
      `SELECT "number" FROM ${this.V}
        WHERE "siteId" = $1 AND "accountId" = $2 AND "status" = 'published'
          AND "publishedAt" > now() - make_interval(days => $3)
        ORDER BY "number" DESC LIMIT $4`,
      ctx.siteId,
      ctx.accountId,
      KNOWLEDGE_DEFAULTS.rollbackWindowDays,
      KNOWLEDGE_DEFAULTS.rollbackMaxPublished,
    );
    return rows.map((r) => r.number);
  }

  /**
   * Чистка окна отката: убираются только ЯВНО ненужные номера
   * (опубликованные вне окна и не текущая, отброшенные) — номер
   * идущей параллельно сборки сюда не попадёт никогда.
   */
  async prune(ctx: KnowledgeCtx): Promise<number> {
    const s = await this.settings(ctx);
    if (!s) return 0;
    const keep = new Set(await this.rollbackWindow(ctx));
    keep.add(s.knowledgeVersion);
    const rows = await this.db.$queryRawUnsafe<{ number: number }[]>(
      `SELECT "number" FROM ${this.V}
        WHERE "siteId" = $1 AND "accountId" = $2 AND "status" IN ('published', 'discarded')`,
      ctx.siteId,
      ctx.accountId,
    );
    const drop = rows.map((r) => r.number).filter((n) => !keep.has(n));
    return this.removeNumbers(ctx, drop);
  }
}
