/**
 * Канал браузерного воркера (Э-С Ш3): тонкий слой над очередью
 * (`browser-jobs`) и выдача учётки Ш2 под обход «Админки» за логином.
 *
 * Учётка: только задание `admin-crawl` под действующей арендой, один раз на
 * попытку (`markCredentialsIssued`), аренда Ш2 от имени `browser-worker`
 * для продукта `assist-admin` (хост — среди хостов учётки и подтверждён для
 * `assist-admin-login`, учётка активна и отмечена тестовой — решает
 * `SiteCredentialsService`, каждое решение — в журнале доступа), погашение
 * сразу же и ответ — КОНВЕРТОМ под открытый ключ воркера
 * (`worker-seal.ts`), AAD — id задания и номер попытки. Открытый текст
 * живёт здесь только в Buffer, который затирается после запечатывания.
 */
import {
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
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
export class InternalWorkerService {
  private readonly logger = new Logger(InternalWorkerService.name);
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly jobs: BrowserJobsService,
    private readonly creds: SiteCredentialsService,
  ) {}

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
      const lease = await this.creds.lease(ctx.accountId, {
        testAccountId: ctx.testAccountId,
        product: 'assist-admin',
        hostId: ctx.hostId,
        actor: WORKER_ACTOR,
        runRef: `bjob:${jobId}`,
        channel: 'assist-admin',
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
