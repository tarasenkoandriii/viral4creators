/**
 * Внутренний API хранилища учётных данных для обучалки генератора (Э-С
 * Ш2): тонкий слой над `site-credentials` — кто зовёт (telegramId для
 * реестра сайта, `ownerRef` для личных записей B) и в каком кабинете он
 * вправе действовать. Решения о секретах, аренде и журнале — в
 * `SiteCredentialsService`, не здесь.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CredentialPurpose } from '../site-credentials/credential-types';
import {
  SiteCredentialsService,
  credError,
} from '../site-credentials/site-credentials.service';
import {
  badInput,
  type TestAccountInput,
  type TestAccountProduct,
} from '../site-credentials/test-account-input';

export const generatorActor = (telegramId: bigint) =>
  `generator:${telegramId.toString()}`;

/**
 * Продукты, которыми распоряжается канал генератора (Э-С Ш3): `assist-admin`
 * (обход «Админки» воркером) включает только кабинет помощника — генератор
 * его не ставит и, правя учётку своим списком, не снимает.
 */
const GENERATOR_PRODUCTS: readonly string[] = ['tutorial', 'qa'];

@Injectable()
export class InternalCredentialsService {
  constructor(private readonly creds: SiteCredentialsService) {}

  status() {
    return this.creds.status();
  }

  /** Учётки сайта, которому принадлежит хост (метаданные, без секретов). */
  async list(telegramId: bigint, hostId: string) {
    const { m, siteId } = await this.creds.managedHost(telegramId, hostId);
    const all = await this.creds.list(m.accountId, siteId);
    return {
      siteId,
      hosts: await this.creds.siteHosts(m.accountId, siteId),
      accounts: all.map((a) => ({
        ...a,
        coversHost: a.hostIds.includes(hostId),
      })),
    };
  }

  /**
   * Завести/обновить учётку от имени обучалки: по id (правка из TMA
   * генератора), по ключу черновика (`project:<id>` — идемпотентно), иначе
   * новая. Хост черновика — среди хостов учётки всегда.
   */
  async upsert(
    telegramId: bigint,
    hostId: string,
    req: {
      testAccountId: string | null;
      clientRef: string | null;
      input: TestAccountInput;
    },
  ) {
    const actor = generatorActor(telegramId);
    if (req.input.products?.some((p) => !GENERATOR_PRODUCTS.includes(p))) {
      throw badInput('«products»: tutorial | qa');
    }
    if (req.testAccountId) {
      const { m, row } = await this.creds.managedAccount(
        telegramId,
        req.testAccountId,
      );
      const input: TestAccountInput = req.input.products
        ? {
            ...req.input,
            products: [
              ...req.input.products,
              ...(row.products.filter(
                (p) => !GENERATOR_PRODUCTS.includes(p),
              ) as TestAccountProduct[]),
            ],
          }
        : req.input;
      return this.creds.update(m.accountId, row.siteId, row.id, input, actor);
    }
    const { m, siteId } = await this.creds.managedHost(telegramId, hostId);
    const input: TestAccountInput = {
      products: ['tutorial'],
      ...req.input,
      hostIds: [...new Set([hostId, ...(req.input.hostIds ?? [])])],
      label: req.input.label ?? 'Tutorial',
    };
    if (req.clientRef) {
      return this.creds.upsertByClientRef(
        m.accountId,
        siteId,
        req.clientRef,
        input,
        actor,
      );
    }
    return this.creds.create(m.accountId, siteId, input, actor);
  }

  async remove(telegramId: bigint, testAccountId: string) {
    const { m } = await this.creds.managedAccount(telegramId, testAccountId);
    return this.creds.remove(
      m.accountId,
      null,
      testAccountId,
      generatorActor(telegramId),
    );
  }

  async putSecret(
    telegramId: bigint,
    testAccountId: string,
    purpose: CredentialPurpose,
    secret: string | null,
  ) {
    const { m } = await this.creds.managedAccount(telegramId, testAccountId);
    return this.creds.putSecret(
      m.accountId,
      testAccountId,
      purpose,
      secret,
      generatorActor(telegramId),
    );
  }

  async forgetSecrets(telegramId: bigint, testAccountId: string) {
    const { m } = await this.creds.managedAccount(telegramId, testAccountId);
    return this.creds.forgetSecrets(
      m.accountId,
      testAccountId,
      generatorActor(telegramId),
    );
  }

  async lease(
    telegramId: bigint,
    req: {
      testAccountId: string;
      hostId: string;
      product: TestAccountProduct;
      runRef: string | null;
    },
  ) {
    const { m } = await this.creds.managedAccount(
      telegramId,
      req.testAccountId,
    );
    return this.creds.lease(m.accountId, {
      ...req,
      actor: generatorActor(telegramId),
      // Канал HMAC — обучалка генератора: аренда для QA отсюда не выдаётся.
      channel: 'tutorial',
    });
  }

  /** Аренда ищется в кабинетах человека; погашает — тот же, кто брал. */
  async redeem(telegramId: bigint, leaseId: string) {
    const accountId = await this.creds.leaseAccount(telegramId, leaseId);
    if (!accountId) {
      throw credError(
        ForbiddenException,
        'CREDENTIAL_LEASE_INVALID',
        'Аренда недействительна: истекла, уже погашена или чужая',
        { reason: 'not_found' },
      );
    }
    return this.creds.redeem(accountId, leaseId, generatorActor(telegramId));
  }
}
