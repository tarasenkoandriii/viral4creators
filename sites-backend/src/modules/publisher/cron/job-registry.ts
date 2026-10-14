/**
 * AI Publisher — реестр заданий кронов (P-A1, проектный документ §15.1,
 * Р-PUB-21). Два пути `vercel.json` (`publisher-tick` каждые 5 мин,
 * `publisher-daily` 04:25 UTC) раздают проход заданиям пакетов.
 *
 * Задание — провайдер пакета с `@PubContribution('cron-job')` (интерфейс
 * `CronJob`, `core/ports.ts`). `PUB_CRON_SCHEDULE` ниже — полный список
 * §15.1 с расписанием и пакетом-владельцем: задание вне списка или с другим
 * расписанием — ошибка старта; задание из списка, которого ещё нет, — в
 * отчёте прохода как `missing` (ответ крона — 501, не «успех», §16.0).
 *
 * Изоляция: исключение одного задания не останавливает остальные (статус
 * `error`, текст — имя ошибки и первые 300 символов сообщения, без данных).
 * Статусы и ответ крона (аудит P3-11): `error` → 500; `missing` или
 * `pending` (задание ждёт вклада другого пакета) → 501; `skipped` (бюджет
 * прохода исчерпан) → 503 `PUB_BUSY` — повтор, не успех. Порядок заданий
 * ротируется без состояния: проход начинается с задания
 * `floor(now / период) mod n`, поэтому хвост расписания не голодает каждый
 * раз; задания обязаны не зависеть от порядка.
 * Каждое задание само берёт свои строки (аренда/условные UPDATE) и
 * укладывается в `deadline`; продукты `kind=restored|eval` задания не
 * обрабатывают (кроме eval-заданий P-B2).
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { CronScope } from '../../../common/cron-scope';
import { PubContributions } from '../core/contributions';
import type { CronJob, CronResult, CronSchedule } from '../core/ports';

export type CronOwner =
  'P-A1' | 'P-B1' | 'P-B2' | 'P-C' | 'P-D' | 'P-E' | 'P-R';

/** §15.1 (+ Р-PUB-A1-9: `approvals-expire` — по задаче на тип, `backup-rotation`). */
export const PUB_CRON_SCHEDULE: Readonly<
  Record<string, { schedule: CronSchedule; owner: CronOwner }>
> = {
  'lead-enrich': { schedule: 'tick', owner: 'P-D' },
  'notifications-deliver': { schedule: 'tick', owner: 'P-D' },
  'contact-overdue': { schedule: 'tick', owner: 'P-D' },
  'approvals-expire-publish': { schedule: 'tick', owner: 'P-B1' },
  'approvals-expire-purchase': { schedule: 'tick', owner: 'P-C' },
  'publications-verify': { schedule: 'tick', owner: 'P-C' },
  /** Очередь AI-вызовов: 202 → задание исполняет (аудит P-B2 S2-1, §11.1). */
  'ai-calls-run': { schedule: 'minute', owner: 'P-B2' },
  'ai-calls-reap': { schedule: 'tick', owner: 'P-B2' },
  /** Открытие месяца и смена потолка — в течение 5 мин (аудит P-B2 S3-6). */
  'ai-month-open': { schedule: 'tick', owner: 'P-B2' },
  'integrations-staleness': { schedule: 'tick', owner: 'P-E' },
  'members-reconcile': { schedule: 'tick', owner: 'P-A1' },
  'backup-post-purchase': { schedule: 'tick', owner: 'P-E' },
  'rate-hits-sweep': { schedule: 'tick', owner: 'P-A1' },
  /** Сброс кэша сайта после снятия/закрытия public_publish (Р-PUB-Z2-8). */
  'site-revalidate': { schedule: 'minute', owner: 'P-A1' },
  /** Вторая линия сверки счётчиков бюджета (вместо deferred-триггера, Р-PUB-A0-2). */
  'budget-reconcile': { schedule: 'daily', owner: 'P-C' },
  'report-staleness': { schedule: 'daily', owner: 'P-E' },
  'placement-diagnostics': { schedule: 'daily', owner: 'P-E' },
  'retention-review': { schedule: 'daily', owner: 'P-D' },
  'form-after-t72': { schedule: 'daily', owner: 'P-D' },
  'backup-weekly': { schedule: 'daily', owner: 'P-E' },
  'backup-rotation': { schedule: 'daily', owner: 'P-E' },
  housekeeping: { schedule: 'daily', owner: 'P-A1' },
  /**
   * P-R M2 (§4): ретенция выдержек тредов Reddit — своё задание пакета, не
   * `housekeeping` (`pub_sources` пишет P-B1 через сервис, Р-RD-59).
   */
  'reddit-retention': { schedule: 'daily', owner: 'P-R' },
};

/** Бюджет прохода: запас до maxDuration функции (как перепроверка хостов). */
export const PUB_CRON_BUDGET_MS = 45_000;

/**
 * Период вызова пути `vercel.json` в минутах — шаг ротации порядка
 * заданий. Это номер «корзины» прохода, а не календарная арифметика
 * (сроки — только `kyiv-time`): сдвиг DST на ротацию не влияет.
 */
export const PUB_CRON_PERIOD_MIN: Readonly<Record<CronSchedule, number>> = {
  minute: 1,
  tick: 5,
  daily: 1_440,
};

/** Сдвиг порядка: каждый следующий проход начинается со следующего задания. */
export function rotationOffset(
  schedule: CronSchedule,
  now: Date,
  n: number,
): number {
  if (n <= 0) return 0;
  const bucket = Math.floor(
    now.getTime() / 60_000 / PUB_CRON_PERIOD_MIN[schedule],
  );
  return bucket % n;
}

export interface CronJobReport {
  key: string;
  owner: CronOwner;
  status: 'ok' | 'error' | 'missing' | 'pending' | 'skipped';
  /** `pending` — чего не хватает (ключи вкладов). */
  pending?: string[];
  processed?: number;
  details?: CronResult['details'];
  error?: string;
  ms?: number;
}

export interface CronRunReport {
  schedule: CronSchedule;
  startedAt: string;
  jobs: CronJobReport[];
  ok: number;
  errors: number;
  missing: number;
  pending: number;
  skipped: number;
}

@Injectable()
export class PubCronRegistry implements OnModuleInit {
  constructor(private readonly contributions: PubContributions) {}

  onModuleInit(): void {
    this.validate(this.contributions.list('cron-job'));
  }

  /** Задание вне §15.1 или не с тем расписанием — ошибка старта. */
  validate(jobs: readonly CronJob[]): void {
    const keys = jobs.map((j) => j.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) {
      throw new Error(
        `Publisher: задание крона «${dup}» зарегистрировано дважды`,
      );
    }
    for (const j of jobs) {
      const s = PUB_CRON_SCHEDULE[j.key];
      if (!s)
        throw new Error(
          `Publisher: задание крона «${j.key}» не описано в PUB_CRON_SCHEDULE`,
        );
      if (s.schedule !== j.schedule) {
        throw new Error(
          `Publisher: задание «${j.key}» — расписание ${j.schedule}, по §15.1 — ${s.schedule}`,
        );
      }
    }
  }

  jobsOf(
    schedule: CronSchedule,
  ): Array<{ key: string; owner: CronOwner; job: CronJob | null }> {
    const registered = new Map(
      this.contributions.list('cron-job').map((j) => [j.key, j]),
    );
    return Object.entries(PUB_CRON_SCHEDULE)
      .filter(([, s]) => s.schedule === schedule)
      .map(([key, s]) => ({
        key,
        owner: s.owner,
        job: registered.get(key) ?? null,
      }));
  }

  async run(
    schedule: CronSchedule,
    opts: { now?: Date; scope?: CronScope; budgetMs?: number } = {},
  ): Promise<CronRunReport> {
    const now = opts.now ?? new Date();
    const deadline = new Date(
      Date.now() + (opts.budgetMs ?? PUB_CRON_BUDGET_MS),
    );
    const jobs: CronJobReport[] = [];
    const list = this.jobsOf(schedule);
    const k = rotationOffset(schedule, now, list.length);
    for (const { key, owner, job } of [...list.slice(k), ...list.slice(0, k)]) {
      if (!job) {
        jobs.push({ key, owner, status: 'missing' });
        continue;
      }
      if (Date.now() > deadline.getTime()) {
        jobs.push({ key, owner, status: 'skipped' });
        continue;
      }
      const started = Date.now();
      try {
        const r = await job.run({ now, scope: opts.scope, deadline });
        jobs.push({
          key,
          owner,
          status: r.pending?.length ? 'pending' : 'ok',
          processed: r.processed,
          details: r.details,
          ...(r.pending?.length ? { pending: r.pending } : {}),
          ms: Date.now() - started,
        });
      } catch (e) {
        const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        jobs.push({
          key,
          owner,
          status: 'error',
          error: err.slice(0, 300),
          ms: Date.now() - started,
        });
      }
    }
    return {
      schedule,
      startedAt: now.toISOString(),
      jobs,
      ok: jobs.filter((j) => j.status === 'ok').length,
      errors: jobs.filter((j) => j.status === 'error').length,
      missing: jobs.filter((j) => j.status === 'missing').length,
      pending: jobs.filter((j) => j.status === 'pending').length,
      skipped: jobs.filter((j) => j.status === 'skipped').length,
    };
  }
}
