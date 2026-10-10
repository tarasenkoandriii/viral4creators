import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

export type SonioxOperation = 'stt' | 'tts' | 'catalog' | 'cleanup';
export { sonioxContext, sonioxRequestContext } from './soniox-context';
import { sonioxContext } from './soniox-context';
export function sonioxResultMetrics(
  operation: SonioxOperation,
  value: unknown,
) {
  const r = (value ?? {}) as Record<string, unknown>;
  const reason = String(r.reason ?? '');
  const status =
    operation === 'catalog'
      ? Array.isArray(value) && value.length
        ? 'ok'
        : Array.isArray(r.voices) && r.voices.length
          ? 'ok'
          : r.error
            ? 'error'
            : 'empty'
      : operation === 'cleanup'
        ? r.skipped || r.sonioxSkipped
          ? 'skipped'
          : (typeof r.dropped === 'number' && r.dropped > 0) ||
              (typeof r.sonioxFailed === 'number' && r.sonioxFailed > 0)
            ? 'error'
            : 'ok'
        : r.ok === true ||
            (operation === 'stt' && typeof r.text === 'string' && r.text.trim())
          ? 'ok'
          : /timeout|срок|таймаут/i.test(reason)
            ? 'timeout'
            : /no_key|not set|не задан/i.test(reason)
              ? 'not-configured'
              : /empty|no_speech|пуст/i.test(reason)
                ? 'empty'
                : 'error';
  const number = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  return {
    status,
    reasonCode:
      status === 'ok'
        ? null
        : /\b(400|401|403|408|409|429|500|502|503|504)\b/.exec(reason)?.[1]
          ? 'http-' +
            /\b(400|401|403|408|409|429|500|502|503|504)\b/.exec(reason)![1]
          : status,
    seconds: number(r.seconds ?? r.durationSeconds),
    characters: number(r.characters),
    words:
      operation === 'stt' && typeof r.text === 'string'
        ? r.text.trim().split(/\s+/).filter(Boolean).length
        : 0,
    language: typeof r.language === 'string' ? r.language.slice(0, 12) : null,
    confidence:
      typeof r.speechConfidence === 'number' &&
      Number.isFinite(r.speechConfidence)
        ? r.speechConfidence
        : null,
  };
}

@Injectable()
export class SonioxObservability {
  private readonly logger = new Logger(SonioxObservability.name);
  constructor(private readonly prisma: PrismaService) {}
  async track<T>(
    operation: SonioxOperation,
    fallbackRole: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const id = randomUUID(),
      start = Date.now();
    const c = sonioxContext.getStore() ?? {
      source: 'background',
      actorRole: fallbackRole,
      actorId: null,
      accountId: null,
      siteId: null,
    };
    let stored = false;
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO soniox_events (id, operation, source, actor_role, actor_id, account_id, site_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        id,
        operation,
        c.source,
        c.actorRole,
        c.actorId,
        c.accountId,
        c.siteId,
      );
      stored = true;
    } catch {
      this.logger.warn('Soniox telemetry unavailable: start not recorded');
    }
    try {
      const result = await run();
      if (stored)
        await this.finish(id, start, sonioxResultMetrics(operation, result));
      return result;
    } catch (e) {
      if (stored)
        await this.finish(id, start, {
          ...sonioxResultMetrics(operation, null),
          status: 'error',
          reasonCode: 'exception',
        });
      throw e;
    }
  }
  private async finish(
    id: string,
    start: number,
    r: ReturnType<typeof sonioxResultMetrics>,
  ) {
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE soniox_events SET finished_at=NOW(), status=$2, reason_code=$3, elapsed_ms=$4, seconds=$5, characters=$6, words=$7, language=$8, confidence=$9 WHERE id=$1`,
        id,
        r.status,
        r.reasonCode,
        Date.now() - start,
        r.seconds,
        r.characters,
        r.words,
        r.language,
        r.confidence,
      );
    } catch {
      this.logger.warn('Soniox telemetry unavailable: completion not recorded');
    }
  }
  async prune(): Promise<number> {
    try {
      return await this.prisma.$executeRawUnsafe(
        `DELETE FROM soniox_events WHERE id IN (SELECT id FROM soniox_events WHERE started_at < NOW()-INTERVAL '30 days' ORDER BY started_at LIMIT 5000)`,
      );
    } catch {
      this.logger.warn('Soniox telemetry retention unavailable');
      return 0;
    }
  }
  async report() {
    const generatedAt = new Date().toISOString();
    try {
      const results = await Promise.allSettled([
        this.prisma.$queryRawUnsafe(
          `SELECT CASE WHEN started_at >= NOW()-INTERVAL '24 hours' THEN 'day' ELSE 'previous' END AS "window", operation, actor_role AS "actorRole", source, CASE WHEN status='running' AND started_at < NOW()-INTERVAL '5 minutes' THEN 'interrupted' ELSE status END AS status, COUNT(*)::int AS calls, SUM(seconds)::float8 AS seconds, SUM(characters)::float8 AS characters, SUM(words)::float8 AS words, AVG(elapsed_ms)::float8 AS "latencyAvgMs", percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms)::float8 AS "latencyP95Ms", AVG(confidence)::float8 AS confidence, COUNT(*) FILTER (WHERE confidence < 0.6)::int AS "lowConfidence", COUNT(DISTINCT actor_id)::int AS actors, COUNT(DISTINCT account_id)::int AS accounts, COUNT(DISTINCT site_id)::int AS sites FROM soniox_events WHERE started_at >= NOW()-INTERVAL '7 days' GROUP BY 1,2,3,4,5`,
        ),
        this.prisma.$queryRawUnsafe(
          `SELECT date_trunc('hour',started_at) AS at, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE status IN ('error','timeout'))::int AS errors FROM soniox_events WHERE started_at >= NOW()-INTERVAL '7 days' GROUP BY 1 ORDER BY 1`,
        ),
        this.prisma.$queryRawUnsafe(
          `SELECT id, operation, source, actor_role AS "actorRole", actor_id AS "actorId", account_id AS "accountId", site_id AS "siteId", started_at AS "startedAt", finished_at AS "finishedAt", CASE WHEN status='running' AND started_at < NOW()-INTERVAL '5 minutes' THEN 'interrupted' ELSE status END AS status, reason_code AS "reasonCode", elapsed_ms AS "elapsedMs", seconds, characters, words, language, confidence FROM soniox_events WHERE started_at >= NOW()-INTERVAL '7 days' ORDER BY started_at DESC LIMIT 100`,
        ),
        this.prisma.$queryRawUnsafe(
          `SELECT MIN(started_at) AS "firstEventAt", COUNT(*) FILTER (WHERE status='running' AND started_at >= NOW()-INTERVAL '5 minutes')::int AS active, COUNT(*) FILTER (WHERE status='running' AND started_at < NOW()-INTERVAL '5 minutes')::int AS interrupted FROM soniox_events WHERE started_at >= NOW()-INTERVAL '7 days'`,
        ),
        this.prisma.$queryRawUnsafe(
          `SELECT operation, SUM(calls)::float8 AS calls, SUM(seconds)::float8 AS seconds, SUM(characters)::float8 AS characters, SUM("costMicroUsd")::float8 / 1000000 AS "costUsd", COUNT(*) FILTER (WHERE unpriced)::int AS unpriced FROM ai_usage WHERE provider='SONIOX' AND "createdAt" >= NOW()-INTERVAL '7 days' GROUP BY operation`,
        ),
        this.prisma.$queryRawUnsafe(
          `SELECT id, operation, source, actor_role AS "actorRole", actor_id AS "actorId", account_id AS "accountId", site_id AS "siteId", started_at AS "startedAt", finished_at AS "finishedAt", status, reason_code AS "reasonCode", elapsed_ms AS "elapsedMs", seconds, characters, words, language, confidence FROM soniox_events WHERE status='running' AND started_at >= NOW()-INTERVAL '5 minutes' ORDER BY started_at LIMIT 100`,
        ),
      ]);
      const [groups, hourly, recent, coverage, usage, active] = results.map(
        (r) => (r.status === 'fulfilled' ? r.value : []),
      );
      const available = results.every(
        (r, i) => i === 4 || r.status === 'fulfilled',
      );
      return {
        available,
        billingAvailable: results[4].status === 'fulfilled',
        ...(!available
          ? {
              error:
                'Оперативный журнал недоступен: проверьте миграцию и подключение к базе.',
            }
          : {}),
        generatedAt,
        keyConfigured: !!process.env.SONIOX_API_KEY?.trim(),
        active,
        groups,
        hourly,
        recent,
        coverage,
        usage,
        retentionDays: 30,
      };
    } catch {
      return {
        available: false,
        generatedAt,
        keyConfigured: !!process.env.SONIOX_API_KEY?.trim(),
        error:
          'Телеметрия недоступна: проверьте миграцию и подключение к базе.',
        groups: [],
        hourly: [],
        recent: [],
        coverage: [],
        usage: [],
      };
    }
  }
}
