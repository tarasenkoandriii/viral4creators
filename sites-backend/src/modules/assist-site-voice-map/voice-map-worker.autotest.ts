/**
 * №29, Р-З10-19: порт Т-3 по расписанию для монитора Т-4
 * (`VoiceMonitorService.autotest`). Монитор очередь воркера не импортирует
 * (правило графа `browser-jobs-zone`), поэтому постановку и разбор итога
 * делает модуль голосовой карты — тем же кодом, что «Звірка» версии
 * (`checkPaths`, CSS-кандидаты целей, `report` с `findInSnapshot`):
 *  - страницы: образцы опубликованной версии карты + страницы контрольных
 *    команд монитора (≤ 10), хост — первый verified-хост «Сайта» (не
 *    admin-хост), только сверка дескрипторов — без кликов;
 *  - источник очереди `voice-autotest` (≤ 1 задание/сайт/сутки — лимит
 *    источника, вторая линия к проверке монитора), `refId` —
 *    `<id строки отчёта>:v<версия>`;
 *  - итог → `VoiceMonitorService.completeAutotest` (отчёт `autotest`,
 *    отметки команд, тревога владельцу при провале), отказ воркера →
 *    `failAutotest`.
 */
import { HttpException } from '@nestjs/common';
import type { UiSnapshot } from '../assist-ui-core/types';
import {
  descriptorCandidates,
  type VoiceMapContent,
} from '../assist-ui-core/voice-map';
import type {
  AutotestOutcome,
  AutotestTicket,
  VoiceAutotestPort,
} from '../assist-site-voice-control/system/voice-monitor-autotest';
import { hostOrigin, lockHostName } from '../browser-jobs/browser-job-rules';
import type { BrowserJobsService } from '../browser-jobs/browser-jobs.service';
import type { BrowserJobHandlers } from '../browser-jobs/job-handlers';
import {
  WORKER_LIMITS,
  isSafeSelector,
  type DescriptorResolveResult,
} from '../browser-jobs/protocol';
import type { VoiceMapService } from './voice-map.service';

/** Что нужно от монитора (класс — в модуле аналитики; ищется по ModuleRef). */
export interface AutotestMonitor {
  autotest: VoiceAutotestPort | null;
  completeAutotest(i: {
    accountId: string;
    siteId: string;
    testId: string;
    outcome: AutotestOutcome;
  }): Promise<string | null>;
  failAutotest(i: {
    accountId: string;
    siteId: string;
    testId: string;
    code: string;
  }): Promise<void>;
}

export interface AutotestDeps {
  jobs: Pick<BrowserJobsService, 'enabled' | 'enqueue'>;
  handlers: Pick<BrowserJobHandlers, 'register'>;
  maps: Pick<VoiceMapService, 'db' | 'siteHosts'>;
  monitor: AutotestMonitor;
  /** Содержимое версии карты (VoiceMapWorkerService.versionContent). */
  versionContent(
    accountId: string,
    siteId: string,
    n: number,
  ): Promise<VoiceMapContent>;
  checkPaths(content: VoiceMapContent): string[];
  report(
    version: number,
    content: VoiceMapContent,
    r: DescriptorResolveResult,
  ): {
    targets: Array<{ key: string; lost: boolean; stability: string }>;
    lost: number;
    fragile: number;
  };
  snapshotsOf(
    r: DescriptorResolveResult,
  ): Array<{ path: string; snapshot: UiSnapshot }>;
}

const REF_RE = /^([A-Za-z0-9_-]{1,64}):v(\d{1,9})$/;

function codeOf(e: unknown): string | null {
  if (!(e instanceof HttpException)) return null;
  const r = e.getResponse() as { code?: unknown } | string;
  return typeof r === 'object' && typeof r.code === 'string' ? r.code : null;
}

const cleanPath = (p: string) =>
  p.startsWith('/') && !p.includes('*') && p.length <= 500;

export function attachVoiceAutotest(d: AutotestDeps): void {
  d.monitor.autotest = {
    async enqueue(i): Promise<AutotestTicket> {
      if (!d.jobs.enabled()) return { skipped: 'worker_disabled' };
      const db = d.maps.db(i.accountId);
      const now = new Date();
      const host = (await d.maps.siteHosts(db, i.siteId, now))[0];
      if (!host) return { skipped: 'no_host' };
      const map = await db.assistSiteVoiceMap.findFirst({
        where: { siteId: i.siteId },
        select: { publishedVersion: true },
      });
      const version = map?.publishedVersion ?? null;
      const content = version
        ? await d
            .versionContent(i.accountId, i.siteId, version)
            .catch(() => null)
        : null;
      const paths = new Set<string>();
      if (content) for (const p of d.checkPaths(content)) paths.add(p);
      for (const p of i.paths) if (cleanPath(p)) paths.add(p);
      const pages = [...paths].slice(0, WORKER_LIMITS.descriptorPages);
      if (!pages.length || (!content && !i.paths.length))
        return { skipped: 'nothing_to_check' };
      const targets = (content?.targets ?? [])
        .filter((t) => t.status === 'active')
        .slice(0, WORKER_LIMITS.descriptorTargets)
        .map((t) => ({
          key: t.key,
          selectors: descriptorCandidates(t.descriptor)
            .map((c) => c.selector)
            .filter((s): s is string => isSafeSelector(s))
            .slice(0, WORKER_LIMITS.selectorsPerTarget),
        }));
      const origin = hostOrigin(host);
      try {
        const job = await d.jobs.enqueue(i.accountId, {
          siteId: i.siteId,
          hostId: host.id,
          origin: 'voice-autotest',
          refId: `${i.testId}:v${content ? version : 0}`,
          requestedBy: 'monitor:t3',
          idempotencyKey: `voice-autotest:${i.testId}`,
          params: {
            pages: pages.map((p) => `${origin}${p}`),
            allowedHosts: [lockHostName(host)],
            viewport: 'desktop',
            targets,
          },
        });
        return {
          jobId: job.id,
          host: lockHostName(host),
          origin,
          version: content ? version : null,
        };
      } catch (e) {
        const code = codeOf(e);
        if (code === 'BROWSER_WORKER_DISABLED')
          return { skipped: 'worker_disabled' };
        if (code === 'BROWSER_JOB_DAILY_LIMIT' || code === 'BROWSER_JOB_BUSY')
          return { skipped: 'limit' };
        if (code === 'BROWSER_JOB_HOST') return { skipped: 'no_host' };
        return { skipped: 'error' };
      }
    },
  };

  d.handlers.register('voice-autotest', {
    onDone: async (j, raw) => {
      const r = raw as DescriptorResolveResult;
      const m = REF_RE.exec(j.refId ?? '');
      if (!m) return null;
      const [, testId, v] = m;
      const version = Number(v);
      const content = version
        ? await d
            .versionContent(j.accountId, j.siteId, version)
            .catch(() => null)
        : null;
      const rep = content ? d.report(version, content, r) : null;
      const pages = r.pages.map((pg) => {
        let path = '/';
        try {
          path = new URL(pg.url).pathname;
        } catch {
          /* адрес уже проверен протоколом */
        }
        return { path, ok: pg.ok, error: pg.error };
      });
      const result = await d.monitor.completeAutotest({
        accountId: j.accountId,
        siteId: j.siteId,
        testId,
        outcome: {
          pages,
          snapshots: d.snapshotsOf(r),
          map: rep && content ? { version, ...rep } : null,
        },
      });
      // В очереди — только сводка: снимки нужны были один раз.
      return { testId, result };
    },
    onFailed: async (j, code) => {
      const m = REF_RE.exec(j.refId ?? '');
      if (!m) return;
      await d.monitor.failAutotest({
        accountId: j.accountId,
        siteId: j.siteId,
        testId: m[1],
        code,
      });
    },
  });
}
