/**
 * Канал браузерного воркера (Э-С Ш3): тонкий слой над очередью
 * (`browser-jobs`) и выдача учётки Ш2 под обход «Админки» за логином.
 *
 * Учётка: только задание `admin-crawl` под действующей арендой, один раз на
 * попытку (`markCredentialsIssued`), аренда Ш2 от имени `browser-worker`
 * для продукта `assist-admin` (хост — среди хостов учётки и подтверждён для
 * `assist-admin-login`, учётка активна — решает `SiteCredentialsService`,
 * каждое решение — в журнале доступа; отметку «тестовая»
 * (`confirmedTestAccountAt`) требует и выбор учётки обхода, и сама аренда:
 * `assist-admin` — в `CONFIRMED_ONLY_PRODUCTS`, Ш2 (8), Р-З10-1), погашение
 * сразу же и ответ — КОНВЕРТОМ под открытый ключ воркера
 * (`worker-seal.ts`), AAD — id задания и номер попытки. Открытый текст
 * живёт здесь только в Buffer, который затирается после запечатывания.
 */
import {
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { workerSealPublicKey } from '../../config/browser-worker-env';
import {
  BrowserJobsService,
  jobError,
} from '../browser-jobs/browser-jobs.service';
import { sealAad, sealForWorker } from '../browser-jobs/worker-seal';
import { SiteCredentialsService } from '../site-credentials/site-credentials.service';

export const WORKER_ACTOR = 'browser-worker';

@Injectable()
export class InternalWorkerService implements OnModuleInit {
  private readonly logger = new Logger(InternalWorkerService.name);
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly jobs: BrowserJobsService,
    private readonly creds: SiteCredentialsService,
  ) {}

  /**
   * Ш3-хвост (7): хранилище Ш2 запечатывает секреты учёток «только для
   * воркера» (продукт — ровно `assist-admin`) под его открытый ключ уже при
   * записи. Само хранилище `worker-seal` не импортирует (правило графа
   * `worker-seal-private`) — запечатывание подключает канал воркера.
   * Ключ читается на каждой записи: нет ключа — запись под KEK, как раньше.
   */
  onModuleInit(): void {
    this.creds.useWorkerSealer({
      publicKey: () => workerSealPublicKey(this.env),
      seal: (pub, plaintext, aad) => sealForWorker(pub, plaintext, aad),
    });
  }

  async credentials(
    jobId: string,
    token: string,
  ): Promise<{ sealed: string; attempt: number }> {
    const pub = workerSealPublicKey(this.env);
    if (!this.jobs.enabled() || !pub) {
      throw jobError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'WORKER_CREDENTIALS_DISABLED',
        'Выдача учёток воркеру выключена (нет открытого ключа конверта)',
      );
    }
    const ctx = await this.jobs.markCredentialsIssued(jobId, token);
    let secrets: Awaited<ReturnType<SiteCredentialsService['redeem']>>;
    try {
      // Продукт аренды — по заданию: обход «Админки» (`assist-admin-login`)
      // или раунд обучалки со входом учёткой реестра (`tutorial-login`).
      const lease = await this.creds.lease(ctx.accountId, {
        testAccountId: ctx.testAccountId,
        product: ctx.product,
        hostId: ctx.hostId,
        actor: WORKER_ACTOR,
        runRef: `bjob:${jobId}`,
        channel: ctx.product,
      });
      secrets = await this.creds.redeem(
        ctx.accountId,
        lease.leaseId,
        WORKER_ACTOR,
      );
    } catch (e) {
      if (e instanceof ForbiddenException || e instanceof Error) {
        this.logger.warn(`учётка для задания не выдана: ${e.name}`);
      }
      throw jobError(
        HttpStatus.FORBIDDEN,
        'WORKER_CREDENTIALS_DENIED',
        'Учётка для задания не выдана (условия аренды не выполнены)',
      );
    }
    const plain = Buffer.from(
      JSON.stringify({
        username: secrets.username,
        password: secrets.secrets.password ?? null,
        loginFields: secrets.secrets['login-fields'] ?? null,
        sessionCookies: secrets.secrets['session-cookies'] ?? null,
        // Ш3-хвост (7): запечатанное при записи — как есть, открывает воркер.
        stored: (secrets.sealed ?? []).map((x) => ({
          purpose: x.purpose,
          sealed: x.sealed,
          aad: x.aad,
        })),
      }),
      'utf8',
    );
    try {
      return {
        sealed: sealForWorker(pub, plain, sealAad(jobId, ctx.attempt)),
        attempt: ctx.attempt,
      };
    } finally {
      plain.fill(0);
    }
  }
}
