/**
 * Кадры обучалки браузерным воркером Ш3 (аудит слияния §3.2 вариант C:
 * «генератор заказывает съёмку через API и получает кадры»; кадры —
 * приватно и со сроком жизни).
 *
 * Только режим A и только ТОЧНЫЙ подтверждённый хост (не через родителя):
 * замок задания воркера — ровно этот хост. Кадры — артефакты задания в
 * приватном Blob (3 суток), генератору — подписанные ссылки на 15 минут.
 * Канал — HMAC обучалки (`SITES_TUTORIAL_HMAC_SECRET`); задание видно
 * только владельцу/менеджеру кабинета, где оно поставлено.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { AccountService } from '../site-core/account/account.service';
import { lockHostName } from '../browser-jobs/browser-job-rules';
import {
  BrowserJobsService,
  jobError,
} from '../browser-jobs/browser-jobs.service';
import {
  BROWSER_VIEWPORTS,
  WORKER_LIMITS,
  lockHostOf,
  type BrowserViewport,
  type FrameImage,
  type FramesCaptureResult,
} from '../browser-jobs/protocol';
import { SitesDb } from '../../prisma/sites-db.service';
import { InternalSitesService } from './internal-sites.service';

const MANAGE = new Set(['owner', 'manager']);

export interface FramesStatus {
  jobId: string;
  status: string;
  errorCode: string | null;
  frames: Array<{
    idx: number;
    scrollY: number;
    url: string;
    linkExpiresAt: Date;
    width: number | null;
    height: number | null;
  }>;
  expiresAt: Date;
}

@Injectable()
export class InternalFramesService {
  constructor(
    private readonly sites: InternalSitesService,
    private readonly jobs: BrowserJobsService,
    private readonly accounts: AccountService,
    private readonly db: SitesDb,
  ) {}

  async request(
    telegramId: bigint,
    req: {
      url: string;
      frames: number;
      viewport: BrowserViewport;
      image?: FrameImage;
    },
  ): Promise<{ jobId: string; status: string }> {
    this.jobs.assertEnabled();
    if (!(BROWSER_VIEWPORTS as readonly string[]).includes(req.viewport)) {
      throw jobError(HttpStatus.BAD_REQUEST, 'INTERNAL_BAD_BODY', 'viewport');
    }
    const st = await this.sites.hostStatus(telegramId, req.url);
    if (st.mode !== 'A' || !st.hostId) {
      throw jobError(
        HttpStatus.CONFLICT,
        'TUTORIAL_FRAMES_MODE_A',
        'Съёмка воркером — только для подтверждённого сайта (режим A)',
      );
    }
    const u = new URL(req.url);
    for (const m of await this.accounts.memberships(telegramId)) {
      if (!MANAGE.has(m.role)) continue;
      const host = await this.db
        .forAccount(m.accountId)
        .siteHost.findFirst({ where: { id: st.hostId } });
      if (!host) continue;
      if (lockHostName(host) !== lockHostOf(u)) {
        throw jobError(
          HttpStatus.CONFLICT,
          'TUTORIAL_FRAMES_MODE_A',
          'Съёмка воркером — только на самом подтверждённом хосте (не через родительский домен)',
        );
      }
      u.hash = '';
      const job = await this.jobs.enqueue(m.accountId, {
        siteId: host.siteId,
        hostId: host.id,
        origin: 'tutorial-frames',
        requestedBy: `generator:${telegramId.toString()}`,
        params: {
          url: u.toString(),
          allowedHosts: [lockHostName(host)],
          viewport: req.viewport,
          frames: Math.min(Math.max(1, req.frames), WORKER_LIMITS.frames),
          ...(req.image ? { image: req.image } : {}),
        },
      });
      return { jobId: job.id, status: job.status };
    }
    throw jobError(
      HttpStatus.CONFLICT,
      'TUTORIAL_FRAMES_MODE_A',
      'Съёмка воркером — только для подтверждённого сайта (режим A)',
    );
  }

  async status(telegramId: bigint, jobId: string): Promise<FramesStatus> {
    for (const m of await this.accounts.memberships(telegramId)) {
      if (!MANAGE.has(m.role)) continue;
      const job = await this.jobs.view(m.accountId, jobId, {
        origin: 'tutorial-frames',
      });
      if (!job) continue;
      const r = job.result as FramesCaptureResult | null;
      const links = r ? await this.jobs.artifactLinks(m.accountId, job.id) : [];
      return {
        jobId: job.id,
        status: job.status,
        errorCode: job.errorCode,
        frames: (r?.frames ?? []).flatMap((f) => {
          const l = links.find((x) => x.idx === f.artifact);
          return l
            ? [
                {
                  idx: f.artifact,
                  scrollY: f.scrollY,
                  url: l.url,
                  linkExpiresAt: l.linkExpiresAt,
                  width: l.width,
                  height: l.height,
                },
              ]
            : [];
        }),
        expiresAt: job.expiresAt,
      };
    }
    throw jobError(
      HttpStatus.NOT_FOUND,
      'TUTORIAL_FRAMES_NOT_FOUND',
      'Задание съёмки не найдено',
    );
  }
}
