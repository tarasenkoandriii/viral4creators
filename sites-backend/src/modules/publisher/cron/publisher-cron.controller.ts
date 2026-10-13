/**
 * AI Publisher — кроны (P-A1, проектный документ §15.1, Р-PUB-21): ровно
 * пути `vercel.json` — `GET /cron/publisher-minute` (каждую минуту, очередь
 * AI-вызовов, аудит P-B2 S2-1), `GET /cron/publisher-tick` (каждые 5 мин) и
 * `GET /cron/publisher-daily` (04:25 UTC). Доступ — `CRON_SECRET`; замок —
 * `site_cron_locks` (`withCronLock`, ключ `publisher-<расписание>`): тик
 * Vercel и ручной вызов не идут одновременно.
 *
 * Ответ (Р-PUB-A1-10):
 *  - 200 `{ran:true, …отчёт}` — все задания расписания есть и прошли;
 *  - 500 `PUB_CRON_FAILED` — хоть одно упало (остальные выполнены);
 *  - 501 `PUB_NOT_IMPLEMENTED {jobs}` — часть заданий §15.1 ещё не
 *    подключена пакетами (зарегистрированные выполнены): заглушка — не
 *    «успех» (§16.0);
 *  - 200 `{ran:false}` — замок занят другим проходом.
 */
import {
  Controller,
  Get,
  Headers,
  HttpException,
  UseFilters,
} from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import { assertCronSecret } from '../../../common/cron-secret';
import { PrismaService } from '../../../prisma/prisma.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { PubError, PubExceptionFilter } from '../core/errors';
import type { CronSchedule } from '../core/ports';
import {
  PUB_CRON_BUDGET_MS,
  PubCronRegistry,
  type CronRunReport,
} from './job-registry';

/** TTL замка: бюджет прохода + запас (как у кронов обхода). */
export const PUB_CRON_LOCK_TTL_MS = PUB_CRON_BUDGET_MS + 4 * 60 * 1000;

export type PubCronResponse = ({ ran: true } & CronRunReport) | { ran: false };

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
@UseFilters(PubExceptionFilter)
export class PublisherCronController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PubCronRegistry,
  ) {}

  @Get('publisher-tick')
  tick(
    @Headers('authorization') authHeader?: string,
  ): Promise<PubCronResponse> {
    assertCronSecret(authHeader);
    return this.pass('tick');
  }

  /** Очередь AI-вызовов (`ai-calls-run`, аудит P-B2 S2-1). */
  @Get('publisher-minute')
  minute(
    @Headers('authorization') authHeader?: string,
  ): Promise<PubCronResponse> {
    assertCronSecret(authHeader);
    return this.pass('minute');
  }

  @Get('publisher-daily')
  daily(
    @Headers('authorization') authHeader?: string,
  ): Promise<PubCronResponse> {
    assertCronSecret(authHeader);
    return this.pass('daily');
  }

  private async pass(schedule: CronSchedule): Promise<PubCronResponse> {
    const res = await withCronLock(
      this.prisma,
      `publisher-${schedule}`,
      PUB_CRON_LOCK_TTL_MS,
      () => this.registry.run(schedule),
    );
    if (!res.ran || !res.result) return { ran: false };
    const report = res.result;
    if (report.errors > 0) {
      const failed = report.jobs
        .filter((j) => j.status === 'error')
        .map((j) => j.key);
      throw new HttpException(
        {
          error: 'PUB_CRON_FAILED',
          code: 'PUB_CRON_FAILED',
          message: `publisher-${schedule}: задания с ошибкой — ${failed.join(', ')}`,
          reason: failed.join(','),
        },
        500,
      );
    }
    if (report.missing > 0 || report.pending > 0) {
      throw new PubError('PUB_NOT_IMPLEMENTED', {
        schedule,
        missing: report.jobs
          .filter((j) => j.status === 'missing')
          .map((j) => ({ key: j.key, owner: j.owner })),
        pending: report.jobs
          .filter((j) => j.status === 'pending')
          .map((j) => ({ key: j.key, owner: j.owner, waitsFor: j.pending })),
        jobs: report.jobs,
      });
    }
    if (report.skipped > 0) {
      // Аудит P3-11: не уложились в бюджет прохода — не успех, повтор.
      throw new PubError('PUB_BUSY', {
        schedule,
        skipped: report.jobs
          .filter((j) => j.status === 'skipped')
          .map((j) => j.key),
        jobs: report.jobs,
      });
    }
    return { ran: true, ...report };
  }
}
