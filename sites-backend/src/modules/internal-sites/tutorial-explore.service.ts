/**
 * Раунд исследователя обучалки на браузерном воркере (Ш3-хвост (3)) —
 * канал генератора (HMAC обучалки), по образцу кадров (`internal-frames.*`).
 *
 * Два источника заданий:
 *  - `tutorial-explore-open` — переход и ≤ 1 клик, в т.ч. РЕЖИМ B (хост не
 *    подтверждён): решение владельца «B ничего не блокирует» — задание
 *    ставится без подтверждения хоста, но замок — только ТОЧНЫЕ хосты
 *    черновика (хост перехода и хост origin, одного регистрируемого домена),
 *    лимиты — на человека (`subject` генератора) и на хост, плюс все защиты
 *    воркера (прокси, замок главного фрейма, стоп-лист кликов, потолки);
 *  - `tutorial-explore` — вход учёткой РЕЕСТРА (режим A): хост кабинета
 *    подтверждён для обучалки и совпадает с хостом перехода ТОЧНО, секреты —
 *    арендой воркера Ш2 (`tutorial-login`) по запросу `credentials`, не в
 *    параметрах. Пароли, введённые руками, через очередь не ходят вовсе —
 *    такие раунды генератор оставляет в функции.
 *
 * Сессия черновика (cookie jar) — только конвертом: генератор запечатывает
 * её под открытый ключ воркера (`seal-key`), воркер возвращает новую под
 * одноразовый ключ генератора. Здесь — только шифротекст.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { workerSealPublicKey } from '../../config/browser-worker-env';
import { AccountService } from '../site-core/account/account.service';
import { registrableDomain } from '../site-core/hosts/host-normalize';
import {
  OPEN_ACCOUNT_PREFIX,
  OPEN_SUBJECT_RE,
  lockHostName,
} from '../browser-jobs/browser-job-rules';
import {
  BrowserJobsService,
  jobError,
  type BrowserJobView,
} from '../browser-jobs/browser-jobs.service';
import {
  ProtocolError,
  lockHostOf,
  parseJobParams,
  type ExploreLoginPick,
  type TutorialExploreParams,
  type TutorialExploreResult,
} from '../browser-jobs/protocol';
import { SitesDb } from '../../prisma/sites-db.service';
import { InternalSitesService } from './internal-sites.service';

const MANAGE = new Set(['owner', 'manager']);

export interface ExploreRequest {
  subject: string;
  url: string;
  allowedOrigin: string;
  clicks: string[];
  /** Ввод в поля: значения — конвертами под ключ воркера. */
  fills: unknown[];
  /** Переигровка (`/undo`) или null. */
  replay: unknown[] | null;
  session: string | null;
  replyKey: string;
  nonce: string;
  videoFrame: boolean;
  registry: {
    telegramId: bigint;
    testAccountId: string;
    needUsername: boolean;
    pick: ExploreLoginPick | null;
  } | null;
}

export interface ExploreStatus {
  jobId: string;
  status: string;
  errorCode: string | null;
  /**
   * Воркер брал задание (`null` — нет): по нему генератор решает, можно ли
   * после отказа выполнить раунд в функции (ничего не исполнялось).
   */
  startedAt: Date | null;
  result: TutorialExploreResult | null;
  artifacts: Array<{
    idx: number;
    url: string;
    contentType: string;
    linkExpiresAt: Date;
  }>;
  expiresAt: Date;
}

const notFound = () =>
  jobError(
    HttpStatus.NOT_FOUND,
    'TUTORIAL_EXPLORE_NOT_FOUND',
    'Раунд на воркере не найден',
  );

const badHost = (message: string) =>
  jobError(HttpStatus.CONFLICT, 'TUTORIAL_EXPLORE_HOST', message);

@Injectable()
export class TutorialExploreService {
  /** Тесты подменяют env (ключ воркера). */
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly sites: InternalSitesService,
    private readonly jobs: BrowserJobsService,
    private readonly accounts: AccountService,
    private readonly db: SitesDb,
  ) {}

  /** Воркер включён и ключ конверта задан — иначе 409 (генератор — в функцию). */
  private assertReady(): string {
    this.jobs.assertEnabled();
    const pub = workerSealPublicKey(this.env);
    if (!this.jobs.credentialsEnabled() || !pub) {
      throw jobError(
        HttpStatus.CONFLICT,
        'BROWSER_WORKER_DISABLED',
        'Браузерный воркер без ключа конверта — раунд не поставлен',
      );
    }
    return pub;
  }

  /** Открытый ключ воркера — генератор запечатывает им сессию черновика. */
  sealKey(): { publicKey: string } {
    return { publicKey: this.assertReady() };
  }

  async request(
    req: ExploreRequest,
  ): Promise<{ jobId: string; status: string; mode: 'A' | 'B' }> {
    this.assertReady();
    if (!OPEN_SUBJECT_RE.test(req.subject)) {
      throw jobError(HttpStatus.BAD_REQUEST, 'INTERNAL_BAD_BODY', 'subject');
    }
    let url: URL;
    let origin: URL;
    try {
      url = new URL(req.url);
      origin = new URL(req.allowedOrigin);
    } catch {
      throw jobError(HttpStatus.BAD_REQUEST, 'INTERNAL_BAD_BODY', 'url');
    }
    // Замок — ТОЧНЫЕ хосты черновика: хост перехода, хост origin и (для
    // переигровки) хосты её переходов, и все они — один сайт (тот же
    // регистрируемый домен, что держит генератор, §8.1). Генератор считает
    // тот же набор для AAD конвертов (`exploreLockHosts`).
    const urls = [url, origin];
    for (const st of req.replay ?? []) {
      if (
        st &&
        typeof st === 'object' &&
        (st as { kind?: unknown }).kind === 'goto'
      ) {
        try {
          urls.push(new URL(String((st as { url?: unknown }).url)));
        } catch {
          throw jobError(HttpStatus.BAD_REQUEST, 'INTERNAL_BAD_BODY', 'replay');
        }
      }
    }
    const hosts = [...new Set(urls.map(lockHostOf))];
    const reg = registrableDomain(url.hostname.toLowerCase());
    if (
      !reg ||
      urls.some((u) => registrableDomain(u.hostname.toLowerCase()) !== reg)
    ) {
      throw badHost('Адрес раунда — не сайт черновика');
    }
    const raw = {
      url: req.url,
      allowedHosts: hosts,
      allowedOrigin: req.allowedOrigin,
      viewport: 'mobile',
      clicks: req.clicks,
      fills: req.fills,
      replay: req.replay,
      login: req.registry
        ? { needUsername: req.registry.needUsername, pick: req.registry.pick }
        : null,
      session: req.session,
      replyKey: req.replyKey,
      nonce: req.nonce,
      videoFrame: req.videoFrame,
    };
    let params: TutorialExploreParams;
    try {
      params = parseJobParams('tutorial-explore', raw) as TutorialExploreParams;
    } catch (e) {
      throw jobError(
        HttpStatus.BAD_REQUEST,
        'INTERNAL_BAD_BODY',
        e instanceof ProtocolError ? e.field : 'params',
      );
    }
    if (!req.registry) {
      const job = await this.jobs.enqueueOpen({
        subject: req.subject,
        origin: 'tutorial-explore-open',
        params,
        requestedBy: `generator:${req.subject}`,
      });
      return { jobId: job.id, status: job.status, mode: 'B' };
    }
    return this.requestRegistry(req.registry, params);
  }

  /** Вход учёткой реестра: режим A, хост кабинета = хост перехода ТОЧНО. */
  private async requestRegistry(
    reg: NonNullable<ExploreRequest['registry']>,
    params: TutorialExploreParams,
  ): Promise<{ jobId: string; status: string; mode: 'A' }> {
    const st = await this.sites.hostStatus(reg.telegramId, params.url);
    if (st.mode !== 'A' || !st.hostId) {
      throw badHost(
        'Вход учёткой на воркере — только для подтверждённого сайта',
      );
    }
    const lock = lockHostOf(new URL(params.url));
    if (params.allowedHosts.length !== 1 || params.allowedHosts[0] !== lock) {
      throw badHost(
        'Вход учёткой на воркере — только на одном хосте черновика',
      );
    }
    for (const m of await this.accounts.memberships(reg.telegramId)) {
      if (!MANAGE.has(m.role)) continue;
      const host = await this.db
        .forAccount(m.accountId)
        .siteHost.findFirst({ where: { id: st.hostId } });
      if (!host) continue;
      if (lockHostName(host) !== lock) {
        throw badHost(
          'Вход учёткой на воркере — только на самом подтверждённом хосте',
        );
      }
      const job = await this.jobs.enqueue(m.accountId, {
        siteId: host.siteId,
        hostId: host.id,
        origin: 'tutorial-explore',
        testAccountId: reg.testAccountId,
        requestedBy: `generator:${reg.telegramId.toString()}`,
        params,
      });
      return { jobId: job.id, status: job.status, mode: 'A' };
    }
    throw badHost('Вход учёткой на воркере — только для подтверждённого сайта');
  }

  /** Задание и кабинет-ключ: своё open-задание человека или задание кабинета. */
  private async find(
    subject: string,
    jobId: string,
    telegramId: bigint | null,
  ): Promise<{ accountId: string; job: BrowserJobView }> {
    if (OPEN_SUBJECT_RE.test(subject)) {
      const accountId = `${OPEN_ACCOUNT_PREFIX}${subject}`;
      const job = await this.jobs.view(accountId, jobId, {
        origin: 'tutorial-explore-open',
      });
      if (job) return { accountId, job };
    }
    if (telegramId !== null) {
      for (const m of await this.accounts.memberships(telegramId)) {
        if (!MANAGE.has(m.role)) continue;
        const job = await this.jobs.view(m.accountId, jobId, {
          origin: 'tutorial-explore',
        });
        if (job) return { accountId: m.accountId, job };
      }
    }
    throw notFound();
  }

  async status(
    subject: string,
    jobId: string,
    telegramId: bigint | null,
  ): Promise<ExploreStatus> {
    const { accountId, job } = await this.find(subject, jobId, telegramId);
    const result =
      job.status === 'done' ? (job.result as TutorialExploreResult) : null;
    const links = result
      ? await this.jobs.artifactLinks(accountId, job.id)
      : [];
    return {
      jobId: job.id,
      status: job.status,
      errorCode: job.errorCode,
      startedAt: job.startedAt,
      result,
      artifacts: links.map((l) => ({
        idx: l.idx,
        url: l.url,
        contentType: l.contentType,
        linkExpiresAt: l.linkExpiresAt,
      })),
      expiresAt: job.expiresAt,
    };
  }

  /**
   * Отмена. По умолчанию — только ожидающего (`cancelled`: воркер его не
   * получит, генератор может выполнить раунд в функции); идущее не
   * трогается. `running: true` — и идущее (на ближайшем heartbeat):
   * генератор сдался по сроку. Ответ — статус после попытки.
   */
  async cancel(
    subject: string,
    jobId: string,
    telegramId: bigint | null,
    running = false,
  ): Promise<{ jobId: string; status: string }> {
    const { accountId } = await this.find(subject, jobId, telegramId);
    if (running) await this.jobs.cancel(accountId, jobId);
    else await this.jobs.cancelIfQueued(accountId, jobId);
    const after = await this.jobs.view(accountId, jobId);
    return { jobId, status: after?.status ?? 'cancelled' };
  }
}
