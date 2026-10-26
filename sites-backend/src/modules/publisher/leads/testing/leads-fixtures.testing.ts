/**
 * AI Publisher — построители тестовых данных P-D (проектный документ
 * §16.6, план внешнего аудита): TD-06 (заявки для квалификации) и TD-07
 * (тела формы, `submissionKey`, отказ сервера, сбой уведомления) — поверх
 * фабрик P-A1 (`seedAccount`, `seedProduct`, `seedMembers`).
 *
 *  - `leadsStack()` — стенд ядра + модули P-D (кабинет и публичный приём);
 *    фейки портов соседей, но НАСТОЯЩИЕ свои (`LEAD_ENRICH_PORT`,
 *    `RATE_LIMIT_RESET_PORT`, вклад `leads`).
 *  - `intakeProduct()` — продукт, принимающий заявки: `kind=test` в
 *    режиме test (Origin из `test_hosts` решением-допущением) или рабочий
 *    `live` (verified-хост, флаги гейтов, утверждённые параметры формы).
 *  - Синтетические контакты — уникальные, чтобы поиск ПД по базе и логам
 *    находил ровно их (AT-CORE-09).
 */
import { randomBytes, randomUUID } from 'crypto';
import * as request from 'supertest';
import type { LeadBody } from '../../contracts/lead-validation';
import type { ParameterKey } from '../../contracts/parameters';
import type { ProductKind } from '../../contracts/states';
import { ParametersService } from '../../core/parameters.service';
import { OPERATION_TX_OPTIONS } from '../../core/operation';
import {
  coreStack,
  type CoreStack,
} from '../../core/testing/core-stack.testing';
import {
  FakeActionsReassign,
  FakeBudgetLimitInit,
  FakeContentsReassign,
  FakePilotExperimentInit,
  FakeSiteChannelInit,
  fakePorts,
} from '../../core/testing/fake-ports';
import {
  AI_GATEWAY,
  BUDGET_LIMIT_PORT,
  BUDGET_READ_PORT,
  CONTENT_PORT,
  PILOT_CLOCK_PORT,
} from '../../core/ports';
import {
  seedAccount,
  seedProduct,
  seedVerifiedHost,
  type SeededAccount,
  type SeededProduct,
} from '../../testing/fixtures.testing';
import { PublisherIntakePublicModule } from '../../public/intake-public.module';
import { PublisherLeadsModule } from '../leads.module';

export const TEST_SECRETS = {
  ASSIST_SECRETS_KEY: 'pubd-test-secrets-key',
  ASSIST_SECRETS_KEY_VERSION: 'v1',
};

/** Ключ связки для тестов (контакты, HMAC, лимит). */
export function useTestSecrets(): () => void {
  const saved = {
    ASSIST_SECRETS_KEY: process.env.ASSIST_SECRETS_KEY,
    ASSIST_SECRETS_KEY_VERSION: process.env.ASSIST_SECRETS_KEY_VERSION,
    ASSIST_SECRETS_KEYS_OLD: process.env.ASSIST_SECRETS_KEYS_OLD,
  };
  process.env.ASSIST_SECRETS_KEY = TEST_SECRETS.ASSIST_SECRETS_KEY;
  process.env.ASSIST_SECRETS_KEY_VERSION =
    TEST_SECRETS.ASSIST_SECRETS_KEY_VERSION;
  delete process.env.ASSIST_SECRETS_KEYS_OLD;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Стенд: ядро + P-D; фейки портов других пакетов. */
export async function leadsStack(
  opts: { http?: boolean } = {},
): Promise<CoreStack> {
  const f = fakePorts();
  return coreStack({
    http: opts.http,
    fakes: false,
    imports: [PublisherLeadsModule, PublisherIntakePublicModule],
    providers: [
      { provide: BUDGET_LIMIT_PORT, useValue: f.budgetLimit },
      { provide: BUDGET_READ_PORT, useValue: f.budgetRead },
      { provide: CONTENT_PORT, useValue: f.content },
      { provide: PILOT_CLOCK_PORT, useValue: f.pilotClock },
      { provide: AI_GATEWAY, useValue: f.ai },
      FakeSiteChannelInit,
      FakeBudgetLimitInit,
      FakePilotExperimentInit,
      FakeActionsReassign,
      FakeContentsReassign,
    ],
  });
}

export const testOrigin = (): string =>
  `https://pubd-${randomBytes(4).toString('hex')}.example`;

/** Решение по параметру через ядро (как владелец продукта). */
export async function decideParam(
  s: CoreStack,
  product: { id: string; accountId: string },
  key: ParameterKey,
  value: unknown,
  toStatus: 'assumption' | 'approved',
  ownerMemberId: string,
): Promise<void> {
  const params = s.mod.get(ParametersService);
  await s.db.forAccount(product.accountId).$transaction(
    (tx) =>
      params.decide(tx, product, {
        key,
        toStatus,
        value,
        basis: 'Рішення для тестового стенду P-D',
        decidedBy: `member:${ownerMemberId}`,
        actors: ['product_owner'],
      }),
    OPERATION_TX_OPTIONS,
  );
}

export interface IntakeWorld {
  account: SeededAccount;
  product: SeededProduct;
  origin: string;
}

export interface IntakeProductOptions {
  kind?: Extract<ProductKind, 'working' | 'test'>;
  analytics?: 'none' | 'session';
  formLimit?: { count: number; windowSec: number };
  altContact?: { label: string; href: string | null };
}

/**
 * Продукт, принимающий заявки. `kind=test` — режим test, Origin —
 * `test_hosts` (допущение, записанное решением); `working` — режим live
 * на verified-хосте с открытыми флагами гейтов и утверждёнными
 * параметрами формы.
 */
export async function intakeProduct(
  s: CoreStack,
  opts: IntakeProductOptions = {},
): Promise<IntakeWorld> {
  const kind = opts.kind ?? 'test';
  const account = await seedAccount(s.prisma);
  const status = kind === 'test' ? 'assumption' : 'approved';
  let origin: string;
  let product: SeededProduct;
  if (kind === 'test') {
    product = await seedProduct(s.prisma, {
      accountId: account.accountId,
      siteId: account.siteId,
      kind: 'test',
      mode: 'test',
    });
    origin = testOrigin();
    await decideParam(
      s,
      product,
      'test_hosts',
      [origin],
      status,
      account.owner.memberId,
    );
  } else {
    product = await seedProduct(s.prisma, {
      accountId: account.accountId,
      siteId: account.siteId,
      kind: 'working',
      mode: 'closed',
    });
    const host = `pubd-${randomBytes(4).toString('hex')}.example`;
    await seedVerifiedHost(s.prisma, account.accountId, account.siteId, host);
    origin = `https://${host}`;
  }
  await decideParam(
    s,
    product,
    'form_limit',
    opts.formLimit ?? { count: 5, windowSec: 600 },
    status,
    account.owner.memberId,
  );
  await decideParam(
    s,
    product,
    'alt_contact',
    opts.altContact ?? {
      label: 'Напишіть нам у Telegram',
      href: 'https://t.me/pubd_support',
    },
    status,
    account.owner.memberId,
  );
  if (opts.analytics === 'session') {
    await decideParam(
      s,
      product,
      'analytics_storage',
      'session',
      status,
      account.owner.memberId,
    );
  }
  if (kind === 'working') {
    // Флаги гейтов — ПОСЛЕ решений (ядро пересчитывает их при каждом
    // решении): стенд живого приёма без полного утверждения D0.
    await openLive(s, product.id);
    product = { ...product, mode: 'live' };
  }
  return { account, product, origin };
}

/** Рабочий продукт в live с открытыми флагами гейтов (как `openForIntake` P-A0). */
export async function openLive(s: CoreStack, productId: string): Promise<void> {
  await s.prisma.$executeRaw`
    UPDATE "sites"."pub_products"
       SET "mode" = 'live', "liveSince" = now(),
           "paramsPublicPublishOk" = true, "paramsRealLeadsOk" = true
     WHERE "id" = ${productId}`;
}

/** Доверять адресу из X-Forwarded-For на стенде (локальный прокси). */
export function trustLocalProxy(): () => void {
  const saved = process.env.TRUSTED_PROXY_CIDRS;
  process.env.TRUSTED_PROXY_CIDRS = '127.0.0.0/8,::1/128';
  return () => {
    if (saved === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = saved;
  };
}

/** Уникальный синтетический контакт (TD-07; ищется в базе и логах). */
export function syntheticPerson(tag = randomBytes(5).toString('hex')) {
  const digits = String(parseInt(tag.slice(0, 7), 16) % 10_000_000).padStart(
    7,
    '0',
  );
  return {
    name: `Синтетичний Заявник ${tag}`,
    email: `pubd.synthetic.${tag}@example.com`,
    phone: `+38067${digits}`,
    task: `Синтетична задача ${tag}: потрібна стаття про сервіс`,
    business: `Синтетичний бізнес ${tag}`,
    note: `Синтетична нотатка ${tag}`,
  };
}

/** Тело формы (TD-07). */
export function leadBody(
  key: string,
  over: Partial<LeadBody> & Record<string, unknown> = {},
): LeadBody & Record<string, unknown> {
  const p = syntheticPerson();
  return {
    key,
    submissionKey: randomUUID(),
    name: p.name,
    contactMethod: 'email',
    contact: p.email,
    business: p.business,
    task: p.task,
    budgetRange: 'unknown',
    dataNoticeVersion: 'draft-1',
    consentState: 'not_required',
    elapsedMs: 15_000,
    ...over,
  };
}

/** Отправка формы по HTTP (supertest) с Origin и IP. */
export function postLead(
  s: CoreStack,
  body: unknown,
  o: { origin?: string; ip?: string } = {},
) {
  const r = request(s.app!.getHttpServer())
    .post('/public/publisher/v1/leads')
    .set('X-Forwarded-For', o.ip ?? '203.0.113.10');
  if (o.origin) r.set('Origin', o.origin);
  return r.send(body as object);
}

/** Событие по HTTP: `text/plain` с JSON (как `sendBeacon`). */
export function postEvent(
  s: CoreStack,
  body: unknown,
  o: { origin?: string; ip?: string } = {},
) {
  const r = request(s.app!.getHttpServer())
    .post('/public/publisher/v1/events')
    .set('Content-Type', 'text/plain;charset=UTF-8')
    .set('X-Forwarded-For', o.ip ?? '203.0.113.20');
  if (o.origin) r.set('Origin', o.origin);
  return r.send(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * `sessionRef` стенда: как у трекера (случайный), но только буквы — hex
 * UUID часто содержит 7+ цифр подряд, а такой ref сервер не хранит как
 * «похожий на телефон» (аудит P-D S3-2).
 */
export const testSessionRef = (): string =>
  `sr_${[...randomBytes(20)].map((b) => String.fromCharCode(97 + (b % 26))).join('')}`;

/** Случайный IP источника (документационные сети), чтобы окна не пересекались. */
// Each call represents a fresh visitor. Random selection from 250 addresses
// collided with earlier rate-limit tests in the same product and caused 429s.
// Benchmark-only address space; never sent to a real external service.
let testIpSequence = 0;
export const randomIp = (): string => {
  if (testIpSequence >= 65_534) throw new Error('test IP pool exhausted');
  const n = ++testIpSequence;
  return `198.18.${Math.floor(n / 256)}.${n % 256}`;
};
