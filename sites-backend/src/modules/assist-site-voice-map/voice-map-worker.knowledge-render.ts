/**
 * Ш3 (20), Р-З10-20: порт рендера SPA для обхода «Сайта»
 * (`SiteCrawlService.spaRender`). Обход (`site-crawl`) очередь воркера не
 * импортирует — правило графа `browser-jobs-zone` пускает к ней из модулей
 * «Сайта» только `assist-site-voice-map` (единственный «шлюз» режима к
 * браузерному воркеру), поэтому порт живёт здесь, рядом с «Снимком».
 * Логики знаний здесь нет: постановка задания `knowledge-render` (замок —
 * хост страницы, L1 `assist-crawl` проверяет очередь; ≤ 50 страниц/сайт/сутки
 * — лимит источника) и чтение итога. Разбор HTML и запись страниц — в
 * site-crawl, под арендой прогона, тем же `extractPage`, что у обхода.
 */
import { HttpException } from '@nestjs/common';
import type { BrowserJobsService } from '../browser-jobs/browser-jobs.service';
import {
  WORKER_LIMITS,
  type KnowledgeRenderParams,
  type KnowledgeRenderResult,
} from '../browser-jobs/protocol';
import type {
  SpaRenderPoll,
  SpaRenderPort,
  SpaRenderTicket,
} from '../site-crawl/types';

function codeOf(e: unknown): string | null {
  if (!(e instanceof HttpException)) return null;
  const r = e.getResponse() as { code?: unknown } | string;
  return typeof r === 'object' && typeof r.code === 'string' ? r.code : null;
}

export function knowledgeRenderPort(
  jobs: Pick<
    BrowserJobsService,
    'enabled' | 'enqueue' | 'view' | 'cancel' | 'dropResult' | 'health'
  >,
  now: () => Date = () => new Date(),
): SpaRenderPort {
  return {
    async request(r): Promise<SpaRenderTicket> {
      if (!jobs.enabled()) return { refused: 'disabled' };
      if (!r.urls.length || r.urls.length > WORKER_LIMITS.renderPages) {
        return { refused: 'error' };
      }
      const params: KnowledgeRenderParams = {
        urls: r.urls,
        allowedHosts: [r.host],
        viewport: 'desktop',
      };
      try {
        const job = await jobs.enqueue(r.accountId, {
          siteId: r.siteId,
          hostId: r.hostId,
          origin: 'knowledge-render',
          refId: r.runId,
          params,
          requestedBy: `crawl:${r.runId}`,
        });
        return { jobId: job.id };
      } catch (e) {
        switch (codeOf(e)) {
          case 'BROWSER_JOB_BUSY':
            return { retry: true };
          case 'BROWSER_JOB_DAILY_LIMIT':
            return { refused: 'limit' };
          case 'BROWSER_WORKER_DISABLED':
            return { refused: 'disabled' };
          case 'BROWSER_JOB_HOST':
            return { refused: 'host' };
          default:
            return { refused: 'error' };
        }
      }
    },

    async poll(accountId, jobId): Promise<SpaRenderPoll> {
      const job = await jobs.view(accountId, jobId, {
        origin: 'knowledge-render',
      });
      if (!job) return { status: 'failed' };
      if (job.status === 'queued' || job.status === 'running')
        return { status: 'waiting', claimed: job.status === 'running' };
      // Сдано, но запись ещё идёт (`{pending:true}`) — подождать.
      const result = job.result as
        KnowledgeRenderResult | { pending: true } | null;
      if (job.status === 'done' && result && 'pending' in result)
        return { status: 'waiting' };
      if (job.status !== 'done' || !result || !('pages' in result))
        return { status: 'failed' };
      // Номер страницы — из параметров задания (адрес знает обход).
      return {
        status: 'done',
        pages: result.pages.map((pg) => ({
          i: pg.i,
          ok: pg.ok,
          html: pg.ok ? pg.html : null,
          links: pg.ok ? pg.links : [],
        })),
      };
    },

    async cancel(accountId, jobId): Promise<void> {
      await jobs.cancel(accountId, jobId).catch(() => undefined);
    },

    async release(accountId, jobId): Promise<void> {
      await jobs
        .dropResult(accountId, jobId, { origin: 'knowledge-render' })
        .catch(() => undefined);
    },

    async workerAlive(staleMs): Promise<boolean> {
      const h = await jobs.health().catch(() => null);
      return (
        !!h?.enabled &&
        !!h.lastHeartbeatAt &&
        now().getTime() - h.lastHeartbeatAt.getTime() <= staleMs
      );
    },
  };
}
