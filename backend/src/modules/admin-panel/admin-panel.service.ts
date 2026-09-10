/**
 * AdminPanelService
 *
 * MVP-объём админки для viral4creators: список/детали сессий + базовая
 * телеметрия. У продукта нет пользователей/модерации контента (в
 * отличие от проекта, из которого перенесён паттерн Telegram-логина —
 * см. doc/TELEGRAM-ADMIN.md) — единственное, чем управляет админка,
 * уже целиком лежит в существующей модели Session, отдельных таблиц
 * под это заводить не пришлось.
 */

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Session as SessionRow } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SessionSummaryRow,
  selectSessionSummaries,
} from '../../common/session-summary';
import { GenerationStatus } from '../../common/types/generation.types';
import { Session } from '../../common/types/session.types';
import { sessionBlobPathnames } from '../../common/blob-paths';
import { BlobService } from '../storage/blob.service';
import { getEnvSettings, EnvCheckResult } from './env-settings';

/**
 * Строка Postgres → та форма Session, которую понимает
 * `sessionBlobPathnames`: ему нужны только `sessionId` и ключи из JSON.
 */
function sessionFromRow(row: SessionRow): Session {
  const data = (row.data as Record<string, unknown>) ?? {};
  return { sessionId: row.id, ...data } as unknown as Session;
}

/** Сводка из узкой строки (common/session-summary.ts). */
function summaryFromSlim(row: SessionSummaryRow): SessionSummary {
  return {
    sessionId: row.id,
    status: row.status,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    userId: row.userId,
    productName: row.productName ?? null,
    hasGeneratedVideo: Boolean(row.downloadUrl),
    downloadUrl: row.downloadUrl ?? null,
  };
}

export interface SessionSummary {
  sessionId: string;
  status: string;
  createdAt: Date;
  lastActivityAt: Date;
  userId: string | null;
  productName: string | null;
  hasGeneratedVideo: boolean;
  downloadUrl: string | null;
}

export interface SessionListResult {
  items: SessionSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TelemetryResult {
  total: number;
  byStatus: Record<string, number>;
  createdLast24h: number;
  createdLast7d: number;
  failedGenerations: number;
}

export interface EnvSettingsResult {
  checks: EnvCheckResult[];
  /** True if every check passed — lets the UI show one overall verdict, not just per-row. */
  allOk: boolean;
}

@Injectable()
export class AdminPanelService {
  private readonly logger = new Logger(AdminPanelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
  ) {}

  /** Единственный флаг доступа для MVP-админки — НЕ self-service,
   * выставляется вручную в БД (см. doc/TELEGRAM-ADMIN.md). Аутентификация
   * (AdminSessionGuard) сама по себе не требует isOperator — вход и
   * доступ к данным проверяются раздельно, честное 403, а не ошибка
   * входа. */
  async assertOperator(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isOperator: true },
    });
    if (!user?.isOperator) {
      throw new ForbiddenException('Operator access required');
    }
  }

  async listSessions(opts: {
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<SessionListResult> {
    const where = opts.status ? { status: opts.status } : {};
    const [rows, total] = await Promise.all([
      // Этап 51 (В-4.4): без колонки `data` — см. common/session-summary.ts.
      selectSessionSummaries(this.prisma, {
        status: opts.status,
        orderBy: 'createdAt',
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.session.count({ where }),
    ]);

    return {
      items: rows.map((row: SessionSummaryRow) => summaryFromSlim(row)),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  async getSession(id: string): Promise<SessionSummary & { data: unknown }> {
    const row = await this.prisma.session.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    return { ...this.toSummary(row), data: row.data };
  }

  /**
   * Удаление сессии оператором — вместе с её файлами (Б-5.9).
   *
   * Правило §22 одно на весь проект: удаление владельца обязано удалить
   * файл. Этот путь его нарушал — строку сносил, а ролик, референс и
   * кадры оставлял в хранилище. Их подобрала бы метла через сутки, но
   * только потому, что она есть, а не потому, что здесь так задумано.
   *
   * Порядок тот же, что у суточной уборки: собрать пути → удалить
   * строку → удалить файлы. При сбое хранилища останется мусор, а не
   * живая сессия со ссылками на исчезнувшие файлы.
   */
  async deleteSession(id: string): Promise<{ ok: true }> {
    const row = await this.prisma.session.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Session ${id} not found`);

    const paths = sessionBlobPathnames(sessionFromRow(row));
    await this.prisma.session.delete({ where: { id } });

    if (paths.length > 0) {
      try {
        await this.blob.deleteMany(paths);
      } catch (error) {
        // Сессии уже нет; ронять ответ оператору из-за хранилища
        // незачем — остаток подберёт метла.
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `сессия ${id} удалена, но её файлы убрать не удалось: ${message}`,
        );
      }
    }
    return { ok: true };
  }

  async getTelemetry(): Promise<TelemetryResult> {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      total,
      byStatusRaw,
      createdLast24h,
      createdLast7d,
      failedGenerations,
    ] = await Promise.all([
      this.prisma.session.count(),
      this.prisma.session.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.session.count({ where: { createdAt: { gte: since24h } } }),
      this.prisma.session.count({ where: { createdAt: { gte: since7d } } }),
      // Этап 51 (В-4.1): статус рендера — колонка с индексом, а не путь в
      // JSON. Фильтр по пути распаковывал `data` у каждой строки: 39 мс и
      // 86 МБ буферов на штатных 3 500 сессиях, 2,6 с на 300 тысячах.
      this.prisma.session.count({
        where: { generationStatus: GenerationStatus.FAILED },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of byStatusRaw as Array<{
      status: string;
      _count: { _all: number };
    }>) {
      byStatus[row.status] = row._count._all;
    }

    return {
      total,
      byStatus,
      createdLast24h,
      createdLast7d,
      failedGenerations,
    };
  }

  /** Читает `process.env` живьём при каждом запросе (не кэшируется) —
   * так вкладка «Настройки» в админке сразу отражает правку .env после
   * рестарта процесса, без отдельного эндпоинта "reload config". */
  getEnvSettings(): EnvSettingsResult {
    const checks = getEnvSettings(process.env);
    return { checks, allOk: checks.every((c) => c.ok) };
  }

  private toSummary(row: SessionRow): SessionSummary {
    return summaryFromSlim({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      userId: row.userId,
      productName:
        (
          (row.data as Record<string, unknown>)?.productInformation as
            | { productName?: string }
            | undefined
        )?.productName ?? null,
      downloadUrl:
        (
          (row.data as Record<string, unknown>)?.generatedVideo as
            | { downloadUrl?: string }
            | undefined
        )?.downloadUrl ?? null,
    });
  }
}
