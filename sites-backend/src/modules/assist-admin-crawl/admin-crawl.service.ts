/**
 * Обход админки за логином — знания об интерфейсе (ТЗ §5.3, §4.3-бис У-9;
 * Э7): opt-in владельца «Админки», только verified-хост сайта (L1
 * `assist-admin`, без льготы) и тестовая учётка из реестра Ш2
 * (`site-credentials`: активная, отмеченная как тестовая, действует на этом
 * хосте).
 *
 * Исполнение — ТОЛЬКО изолированный браузерный воркер Ш3 (общий с QA, с
 * egress-фильтром): он арендует учётку (аренда Ш2 `assist-admin-login`,
 * 2 мин, одно погашение — канал `internal-worker`, конвертом под ключ
 * воркера), обходит админку БЕЗ действий (ссылки своего хоста, стоп-лист
 * опасных целей) и сдаёт ТОЛЬКО знания об интерфейсе (заголовки, подписи
 * кнопок и полей, шапки таблиц — не содержимое ячеек); страницы пишутся в
 * assist_admin_pages (не в общий site_pages). Браузер на сервере Vercel не
 * запускается никогда, секреты учётки здесь не расшифровываются.
 *
 * Э-С Ш3: пока `BROWSER_WORKER_ENABLED` выключен — как в Э7: задание
 * `waiting_worker` ждёт. Включён — задание `queued` + задание очереди
 * воркера (`browser-jobs`, источник `assist-admin-crawl`, одна попытка —
 * вход не повторяется автоматически); учётке нужен продукт `assist-admin`
 * (О-Э7-1). Ожидавшие `waiting_worker` ставятся в очередь при следующем
 * «Запустить».
 *
 * Этот модуль — единственный в «Админке», кому граф разрешает
 * `site-credentials` (только чтение реестра без секретов).
 */
import { createHash } from 'crypto';
import { HttpException, Injectable, OnModuleInit } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import { maskLabel } from '../assist-ui-core/snapshot';
import { hostOrigin } from '../browser-jobs/browser-job-rules';
import { BrowserJobsService } from '../browser-jobs/browser-jobs.service';
import {
  BrowserJobHandlers,
  type HandlerJob,
} from '../browser-jobs/job-handlers';
import type { AdminCrawlResult } from '../browser-jobs/protocol';
import type { AccountMembership } from '../site-core/account/roles';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { notFoundSite } from '../site-core/site-core.constants';
import { SiteCredentialsService } from '../site-credentials/site-credentials.service';

/** Продукт реестра Ш2 для обхода «Админки» (О-Э7-1, Ш3). */
export const ADMIN_CRAWL_PRODUCT = 'assist-admin';
/** Страниц за обход и глубина ссылок от стартовой. */
export const ADMIN_CRAWL_LIMITS = { maxPages: 20, maxDepth: 2 } as const;
/** Задания обхода, которые ещё не кончились. */
const ACTIVE = ['waiting_worker', 'queued', 'running'];

/** Причина отказа воркера → строка для владельца (без внутренних кодов). */
const FAIL_NOTES: Record<string, string> = {
  login_form_missing: 'не найдена форма входа на стартовой странице',
  login_failed: 'вход не удался — проверьте учётку и пароль',
  credentials_unavailable: 'учётка не выдана (условия аренды не выполнены)',
  host_not_verified: 'подтверждение хоста истекло или отозвано',
  offhost_redirect: 'страница увела на другой сайт — обход остановлен',
  egress_blocked: 'адрес недоступен из изолированной сети воркера',
  cancelled: 'отменено',
  job_timeout: 'воркер не успел — попробуйте позже',
  worker_disabled: 'браузерный воркер выключен — запустите обход позже',
  internal: 'сбой при сохранении результата — запустите обход ещё раз',
};

/**
 * Запись обхода «идёт» дольше этого без живого задания воркера — сверка
 * (`reconcile`) доводит её до итога задания (аудит Ш3 P2).
 */
export const ADMIN_CRAWL_RECONCILE_AFTER_MS = 10 * 60_000;

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
    /** Разрешена обходу (продукт `assist-admin` в реестре Ш2). */
    adminCrawl: boolean;
  }>;
  jobs: Array<{
    id: string;
    status: string;
    createdAt: string;
    note: string | null;
  }>;
  /** `waiting_sh3` — воркер Ш3 не подключён (задания ждут); `ready` — подключён. */
  worker: 'waiting_sh3' | 'ready';
}

const bad = (message: string) =>
  new HttpException(
    { error: 'PRIVATE_CRAWL_INVALID', code: 'PRIVATE_CRAWL_INVALID', message },
    409,
  );

@Injectable()
export class AdminCrawlService implements OnModuleInit {
  constructor(
    private readonly db: SitesDb,
    private readonly credentials: SiteCredentialsService,
    private readonly jobs: BrowserJobsService,
    private readonly handlers: BrowserJobHandlers,
  ) {}

  onModuleInit(): void {
    this.handlers.register('assist-admin-crawl', {
      onStarted: (j) => this.mark(j, 'running', null),
      onDone: (j, r) => this.ingest(j, r as AdminCrawlResult),
      onFailed: (j, code) =>
        this.mark(
          j,
          code === 'cancelled' ? 'cancelled' : 'failed',
          FAIL_NOTES[code] ?? 'обход не удался',
        ),
      reconcile: (now) => this.reconcile(now),
    });
  }

  /**
   * Сверка с очередью воркера (крон `browser-jobs-reap`, аудит Ш3 P2):
   * обход `queued`/`running`, чьё задание уже кончилось (функция
   * оборвалась между переходом задания и обработчиком, обработчик отказа
   * упал) или пропало (ретенция, постановка не дошла), — доводится до
   * итога задания. Живое задание (`queued`/`running`) и «сдано, обработчик
   * ещё пишет» (`result.pending`) не трогаются: их доведёт очередь.
   */
  async reconcile(now = new Date()): Promise<number> {
    const sys = this.db.system('сверка обходов «Админки» с очередью воркера');
    const stuck = await sys.assistAdminCrawlJob.findMany({
      where: {
        status: { in: ['queued', 'running'] },
        updatedAt: {
          lt: new Date(now.getTime() - ADMIN_CRAWL_RECONCILE_AFTER_MS),
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });
    let fixed = 0;
    for (const c of stuck) {
      const bj = await this.jobs.latest(c.accountId, {
        siteId: c.siteId,
        origin: 'assist-admin-crawl',
        refId: c.id,
      });
      let status: string;
      let note: string;
      if (!bj) {
        status = 'failed';
        note = 'задание воркера не найдено — запустите обход ещё раз';
      } else if (bj.status === 'queued' || bj.status === 'running') {
        continue;
      } else if (bj.status === 'done') {
        const r = bj.result;
        if (
          r &&
          typeof r === 'object' &&
          (r as { pending?: unknown }).pending === true
        )
          continue;
        const pages =
          r &&
          typeof r === 'object' &&
          typeof (r as { pages?: unknown }).pages === 'number'
            ? (r as { pages: number }).pages
            : null;
        const loggedIn = !(
          r &&
          typeof r === 'object' &&
          (r as { loggedIn?: unknown }).loggedIn === false
        );
        status = loggedIn ? 'done' : 'failed';
        note = loggedIn
          ? pages !== null
            ? `страниц: ${pages}`
            : 'обход завершён'
          : FAIL_NOTES.login_failed;
      } else {
        const code = bj.errorCode ?? '';
        status =
          bj.status === 'cancelled' || code === 'cancelled'
            ? 'cancelled'
            : 'failed';
        note = FAIL_NOTES[code] ?? 'обход не удался';
      }
      const u = await this.db
        .forAccount(c.accountId)
        .assistAdminCrawlJob.updateMany({
          where: { id: c.id, status: { in: ['queued', 'running'] } },
          data: { status, note },
        });
      fixed += u.count;
    }
    return fixed;
  }

  private worker(): 'waiting_sh3' | 'ready' {
    return this.jobs.enabled() ? 'ready' : 'waiting_sh3';
  }

  private async mark(j: HandlerJob, status: string, note: string | null) {
    if (!j.refId) return;
    await this.db.forAccount(j.accountId).assistAdminCrawlJob.updateMany({
      where: { id: j.refId, status: { in: ACTIVE } },
      data: { status, ...(note !== null ? { note } : {}) },
    });
  }

  /**
   * Итог обхода → `assist_admin_pages` (одна строка на адрес; страницы, не
   * встреченные этим обходом, уходят — карта «Админки» = последний обход).
   * Текст маскируется ещё раз (e-mail, телефоны, ключи, длинные цифры).
   */
  private async ingest(j: HandlerJob, r: AdminCrawlResult) {
    const db = this.db.forAccount(j.accountId);
    const now = new Date();
    const urls: string[] = [];
    for (const p of r.pages) {
      const text = p.text
        .split('\n')
        .map((line) => maskLabel(line))
        .join('\n');
      const title = maskLabel(p.title).slice(0, 200);
      const contentHash = createHash('sha256')
        .update(`${title}\n${text}`)
        .digest('hex');
      urls.push(p.url);
      const prev = await db.assistAdminPage.findFirst({
        where: { siteId: j.siteId, url: p.url },
        select: { id: true },
      });
      if (prev) {
        await db.assistAdminPage.updateMany({
          where: { id: prev.id },
          data: {
            title,
            text,
            contentHash,
            crawlJobId: j.refId,
            fetchedAt: now,
          },
        });
      } else {
        await db.assistAdminPage.create({
          data: {
            accountId: j.accountId,
            siteId: j.siteId,
            url: p.url,
            title,
            text,
            contentHash,
            crawlJobId: j.refId,
            fetchedAt: now,
          },
        });
      }
    }
    if (r.loggedIn && urls.length) {
      await db.assistAdminPage.deleteMany({
        where: { siteId: j.siteId, url: { notIn: urls } },
      });
    }
    await this.mark(
      j,
      r.loggedIn ? 'done' : 'failed',
      r.loggedIn ? `страниц: ${urls.length}` : FAIL_NOTES.login_failed,
    );
    return {
      loggedIn: r.loggedIn,
      pages: urls.length,
      refusedClicks: r.refusedClicks,
      skippedLinks: r.skippedLinks,
    };
  }

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
        adminCrawl: a.products.includes(ADMIN_CRAWL_PRODUCT),
      })),
      jobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        createdAt: j.createdAt.toISOString(),
        note: j.note,
      })),
      worker: this.worker(),
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
      if (this.jobs.enabled() && !acc.products.includes(ADMIN_CRAWL_PRODUCT)) {
        throw bad(
          'Разрешите учётке продукт «Помощник: Админка» в реестре тестовых учётных записей',
        );
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
      const pending = await db.assistAdminCrawlJob.findMany({
        where: { siteId, status: { in: ['waiting_worker', 'queued'] } },
        select: { id: true },
      });
      await db.assistAdminCrawlJob.updateMany({
        where: { siteId, status: { in: ['waiting_worker', 'queued'] } },
        data: { status: 'cancelled', note: 'обход выключен владельцем' },
      });
      // Задания воркера этих обходов — отменить (ожидающее — сразу).
      for (const p of pending) {
        const bj = await this.jobs.latest(m.accountId, {
          siteId,
          origin: 'assist-admin-crawl',
          refId: p.id,
        });
        if (bj) await this.jobs.cancel(m.accountId, bj.id);
      }
    }
    return this.view(m, siteId, now);
  }

  /** Поставить задание обхода в очередь воркера Ш3 (одно активное на сайт). */
  async request(m: AccountMembership, siteId: string, now = new Date()) {
    const { db, s, hosts, accounts } = await this.context(m, siteId, now);
    const host = hosts.find((h) => h.id === s.privateCrawlHostId);
    const acc = accounts.find((a) => a.id === s.privateCrawlTestAccountId);
    if (
      !s.privateCrawlEnabled ||
      !s.privateCrawlHostId ||
      !s.privateCrawlTestAccountId ||
      !host ||
      !acc
    ) {
      throw bad(
        'Обход за логином выключен или условия больше не выполняются (хост/учётка)',
      );
    }
    const active = await db.assistAdminCrawlJob.findFirst({
      where: { siteId, status: { in: ACTIVE } },
      orderBy: { createdAt: 'desc' },
    });
    if (!this.jobs.enabled()) {
      const job =
        active ??
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
      return { jobId: job.id, status: job.status, worker: this.worker() };
    }
    if (active && active.status !== 'waiting_worker') {
      return { jobId: active.id, status: active.status, worker: this.worker() };
    }
    if (!acc.products.includes(ADMIN_CRAWL_PRODUCT)) {
      throw bad(
        'Разрешите учётке продукт «Помощник: Админка» в реестре тестовых учётных записей',
      );
    }
    const startPath = s.privateCrawlStartPath ?? '/';
    const job =
      active ??
      (await db.assistAdminCrawlJob.create({
        data: {
          accountId: m.accountId,
          siteId,
          hostId: s.privateCrawlHostId,
          testAccountId: s.privateCrawlTestAccountId,
          startPath,
          requestedByTelegramId: m.telegramId,
          status: 'queued',
          note: 'в очереди браузерного воркера',
        },
      }));
    const origin = hostOrigin(host);
    await this.jobs.enqueue(m.accountId, {
      siteId,
      hostId: host.id,
      origin: 'assist-admin-crawl',
      refId: job.id,
      testAccountId: acc.id,
      idempotencyKey: `admin-crawl:${job.id}`,
      requestedBy: `tg:${m.telegramId.toString()}`,
      params: {
        startUrl: `${origin}${startPath}`,
        allowedHosts: [new URL(origin).host],
        viewport: 'desktop',
        maxPages: ADMIN_CRAWL_LIMITS.maxPages,
        maxDepth: ADMIN_CRAWL_LIMITS.maxDepth,
        loginMethod: (['password', 'session', 'sso'].includes(acc.loginMethod)
          ? acc.loginMethod
          : 'password') as 'password' | 'session' | 'sso',
      },
    });
    if (job.status === 'waiting_worker') {
      await db.assistAdminCrawlJob.updateMany({
        where: { id: job.id, status: 'waiting_worker' },
        data: { status: 'queued', note: 'в очереди браузерного воркера' },
      });
    }
    return { jobId: job.id, status: 'queued', worker: this.worker() };
  }
}
