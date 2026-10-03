/**
 * Обход админки за логином — знания об интерфейсе (ТЗ §5.3, §4.3-бис У-9;
 * Э7): opt-in владельца «Админки», только verified-хост сайта (L1
 * `assist-admin`, без льготы) и тестовая учётка из реестра Ш2
 * (`site-credentials`: активная, отмеченная как тестовая, действует на этом
 * хосте).
 *
 * Исполнение — ТОЛЬКО изолированный браузерный воркер Ш3 (общий с QA, с
 * egress-фильтром): он арендует учётку (аренда Ш2, 2 мин, одно погашение),
 * обходит админку и пишет страницы в assist_admin_pages (не в общий
 * site_pages). Воркера пока нет — задание создаётся со статусом
 * `waiting_worker` и ждёт; браузер на сервере Vercel не запускается никогда,
 * секреты учётки здесь не расшифровываются и не арендуются.
 *
 * Этот модуль — единственный в «Админке», кому граф разрешает
 * `site-credentials` (только чтение реестра без секретов).
 */
import { HttpException, Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { notFoundSite } from '../site-core/site-core.constants';
import { SiteCredentialsService } from '../site-credentials/site-credentials.service';

export interface PrivateCrawlView {
  enabled: boolean;
  hostId: string | null;
  testAccountId: string | null;
  startPath: string;
  /** Хосты сайта, годные для обхода (verified для «Админки»). */
  hosts: Array<{ id: string; host: string }>;
  /** Учётки реестра Ш2, годные для хоста (без секретов). */
  testAccounts: Array<{
    id: string;
    label: string;
    hostIds: string[];
    status: string;
  }>;
  jobs: Array<{
    id: string;
    status: string;
    createdAt: string;
    note: string | null;
  }>;
  /** Воркер Ш3 ещё не подключён: задания ждут. */
  worker: 'waiting_sh3';
}

const bad = (message: string) =>
  new HttpException(
    { error: 'PRIVATE_CRAWL_INVALID', code: 'PRIVATE_CRAWL_INVALID', message },
    409,
  );

@Injectable()
export class AdminCrawlService {
  constructor(
    private readonly db: SitesDb,
    private readonly credentials: SiteCredentialsService,
  ) {}

  private async context(m: AccountMembership, siteId: string, now: Date) {
    const db = this.db.forAccount(m.accountId);
    const site = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw notFoundSite();
    await db.assistAdminSettings.createMany({
      data: [{ accountId: m.accountId, siteId }],
      skipDuplicates: true,
    });
    const s = await db.assistAdminSettings.findFirstOrThrow({
      where: { siteId },
    });
    const hosts = (await db.siteHost.findMany({ where: { siteId } })).filter(
      (h) => evaluateHostAccess(h, 'assist-admin', now).ok,
    );
    const accounts = (
      await this.credentials.list(m.accountId, siteId, now)
    ).filter((a) => a.status === 'active' && a.confirmedTestAccount);
    return { db, s, hosts, accounts };
  }

  async view(
    m: AccountMembership,
    siteId: string,
    now = new Date(),
  ): Promise<PrivateCrawlView> {
    const { db, s, hosts, accounts } = await this.context(m, siteId, now);
    const jobs = await db.assistAdminCrawlJob.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return {
      enabled: s.privateCrawlEnabled,
      hostId: s.privateCrawlHostId,
      testAccountId: s.privateCrawlTestAccountId,
      startPath: s.privateCrawlStartPath ?? '/',
      hosts: hosts.map((h) => ({ id: h.id, host: h.host })),
      testAccounts: accounts.map((a) => ({
        id: a.id,
        label: a.label,
        hostIds: a.hostIds,
        status: a.status,
      })),
      jobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        createdAt: j.createdAt.toISOString(),
        note: j.note,
      })),
      worker: 'waiting_sh3',
    };
  }

  async put(
    m: AccountMembership,
    siteId: string,
    dto: {
      enabled: boolean;
      hostId?: string;
      testAccountId?: string;
      startPath?: string;
    },
    now = new Date(),
  ): Promise<PrivateCrawlView> {
    const { db, hosts, accounts } = await this.context(m, siteId, now);
    if (dto.enabled) {
      const host = hosts.find((h) => h.id === dto.hostId);
      if (!host) throw bad('Нужен подтверждённый хост админки этого сайта');
      const acc = accounts.find((a) => a.id === dto.testAccountId);
      if (!acc) {
        throw bad(
          'Нужна активная тестовая учётная запись из реестра сайта (отмечена «это тестовый аккаунт»)',
        );
      }
      if (!acc.hostIds.includes(host.id)) {
        throw bad('Тестовая учётная запись не действует на этом хосте');
      }
    }
    await db.assistAdminSettings.updateMany({
      where: { siteId },
      data: dto.enabled
        ? {
            privateCrawlEnabled: true,
            privateCrawlHostId: dto.hostId!,
            privateCrawlTestAccountId: dto.testAccountId!,
            privateCrawlStartPath: dto.startPath ?? '/',
          }
        : { privateCrawlEnabled: false },
    });
    if (!dto.enabled) {
      await db.assistAdminCrawlJob.updateMany({
        where: { siteId, status: 'waiting_worker' },
        data: { status: 'cancelled', note: 'обход выключен владельцем' },
      });
    }
    return this.view(m, siteId, now);
  }

  /** Поставить задание обхода в очередь воркера Ш3 (одно ожидающее на сайт). */
  async request(m: AccountMembership, siteId: string, now = new Date()) {
    const { db, s, hosts, accounts } = await this.context(m, siteId, now);
    if (
      !s.privateCrawlEnabled ||
      !s.privateCrawlHostId ||
      !s.privateCrawlTestAccountId ||
      !hosts.some((h) => h.id === s.privateCrawlHostId) ||
      !accounts.some((a) => a.id === s.privateCrawlTestAccountId)
    ) {
      throw bad(
        'Обход за логином выключен или условия больше не выполняются (хост/учётка)',
      );
    }
    const waiting = await db.assistAdminCrawlJob.findFirst({
      where: { siteId, status: 'waiting_worker' },
    });
    const job =
      waiting ??
      (await db.assistAdminCrawlJob.create({
        data: {
          accountId: m.accountId,
          siteId,
          hostId: s.privateCrawlHostId,
          testAccountId: s.privateCrawlTestAccountId,
          startPath: s.privateCrawlStartPath ?? '/',
          requestedByTelegramId: m.telegramId,
          note: 'ждёт браузерного воркера Ш3',
        },
      }));
    return {
      jobId: job.id,
      status: job.status,
      worker: 'waiting_sh3' as const,
    };
  }
}
