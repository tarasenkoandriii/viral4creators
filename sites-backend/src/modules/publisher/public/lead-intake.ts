/**
 * AI Publisher — приём заявки `POST /public/publisher/v1/leads` (P-D,
 * проектный документ §11.4 «минимальная запись + исходящая очередь»,
 * решение координатора по аудиту P1-2; ТЗ §6, §8.3, §19, §20; AT-CORE-02,
 * 03, 04, 09).
 *
 * До базы: ключ → продукт (`pub_public_products`), Origin, форма открыта,
 * тело (`contracts/lead-validation.ts` — те же правила, что у сайта), ключи
 * шифрования. Затем ОДНА транзакция под `publisher_public` (READ
 * COMMITTED):
 *
 *  1. `pg_advisory_xact_lock(продукт + submissionKey)` и поиск по
 *     `(productId, submissionKey)` колоночным SELECT: найдено с тем же
 *     `requestHash` → 200 с прежним `leadRef` БЕЗ лимитера (повтор после
 *     обрыва проходит и при исчерпанном лимите, AT-CORE-03/04); с другим
 *     → 409 `PUB_IDEMPOTENCY_REUSED`. Блокировка ключа отправки
 *     сериализует параллельные повторы: 10 одинаковых запросов дают одну
 *     заявку и один ответ, а не 10 ударов по лимиту;
 *  2. лимитер — скользящее окно `pub_rate_hits` (`form_limit`, умолчание
 *     5 / 600 с) → 429 `PUB_RATE_LIMITED {retryAfterSec, altContact}`;
 *  3. ловушка `hp` → ответ «как при успехе» (201 со случайным `leadRef`)
 *     без записи заявки (удар лимита остаётся — бот упирается в лимит);
 *  4. `INSERT pub_leads` (минимальные поля, `reviewDueAt = +90 дней`,
 *     `testFlag` по виду/режиму) → шифр контакта и `INSERT pub_lead_contacts`
 *     (с `matchHash`) → `INSERT pub_sessions … ON CONFLICT DO NOTHING`
 *     (только при `analytics_storage='session'`) → `INSERT pub_events
 *     (lead_submit_success, leadId)` → `INSERT pub_lead_outbox` → COMMIT.
 *
 * Сбой до COMMIT — 5xx и НИ события успеха, НИ заявки, НИ удара лимита
 * (AT-CORE-03). Обогащение, проспект, уведомления — задание `lead-enrich`
 * под основной ролью.
 *
 * Контракт P-A0: в SQL нет `createdBy`/`receivedAt`/`occurredAt`/
 * `startedAt` (DEFAULT ставит сервер БД), `ON CONFLICT DO NOTHING` без
 * цели, `RETURNING` — только у `pub_leads` (`id, publicRef, receivedAt`).
 * Контракт P-A1 (аудит P3-10): `requestHash` — ключевой HMAC
 * (`leadRequestHmac`), повтор во время ротации ключа — по всем ключам.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PublisherPublicDb } from '../../../prisma/publisher-public-db.service';
import type { DerivedKeys } from '../../../common/secrets-keyring';
import type { LeadAccepted } from '../contracts/public-api';
import { validateLeadBody, type LeadInput } from '../contracts/lead-validation';
import {
  contactMatchHash,
  leadRequestHmac,
  leadRequestHmacs,
  publisherKeys,
  sealContact,
  type ContactPayload,
} from '../core/contact-crypto';
import { applyStandDbClock } from '../core/clock';
import { addKyivCalendarDays } from '../core/kyiv-time';
import { cleanUtm, cleanUtmValue } from '../core/utm';
import {
  PublicProductResolver,
  assertIntakeConfigured,
  assertOrigin,
  publicError,
  publicKeyOf,
  testFlagOf,
  isPublicError,
  type PublicProduct,
} from './public-guard';
import {
  RATE_SCOPES,
  ipKeyHmac,
  lockKey,
  rateKey,
  slidingWindowHit,
  trapKey,
  type RawTx,
} from './rate-limit';

/** Ретенция при приёме (§15.3): +90 календарных дней; обогащение пересчитает. */
export const INTAKE_REVIEW_DAYS = 90;
export const PUBLIC_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5000,
  timeout: 10000,
};

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** `L-` + 10 символов base32 (50 бит случайности). */
export function newPublicRef(): string {
  const bytes = randomBytes(10);
  let s = '';
  for (const b of bytes) s += BASE32[b & 31];
  return `L-${s}`;
}

/** id строки (у таблиц `pub_*` нет DEFAULT для id). */
export const newRowId = (prefix: string): string =>
  `${prefix}${randomBytes(12).toString('hex')}`;

/**
 * id серверного события успеха — детерминированно из id заявки: повтор
 * отправки возвращает тот же `eventId`, хотя роль `publisher_public`
 * событий не читает. Форма — UUID (v4-разметка версии и варианта).
 */
export function successEventIdOf(leadId: string): string {
  const h = createHash('sha256')
    .update(`lead_submit_success\n${leadId}`, 'utf8')
    .digest('hex');
  const v = `4${h.slice(13, 16)}`;
  const variant =
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}-${h.slice(20, 32)}`;
}

/** JSON с отсортированными ключами (канонический вид тела для HMAC). */
export function canonicalBodyJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalBodyJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalBodyJson(o[k])}`)
    .join(',')}}`;
}

/**
 * Что считается «тем же телом» повтора: нормализованная заявка без
 * `elapsedMs` (время заполнения растёт при повторе той же попытки) и без
 * ключа продукта (он — в HMAC отдельно).
 */
export function requestCanonical(v: LeadInput): string {
  const { elapsedMs: _e, key: _k, ...rest } = v;
  return canonicalBodyJson(rest);
}

/** След версии уведомления о данных в шифре заявки (S3-4). */
export interface NoticeTrace {
  /** Версия, которую прислала форма (`dataNoticeVersion`). */
  dataNoticeVersion: string;
  /** Версия продукта на момент приёма (`data_notice_version`) или null. */
  dataNoticeExpected: string | null;
}

/** Мягкое поле атрибуции: похожее на контакт — отбрасывается (триггер его не пустит). */
function attributionField(v: string | null): string | null {
  if (v === null) return null;
  return cleanUtmValue(v).redacted ? null : v;
}

export interface IntakeRequest {
  origin: string | undefined;
  ip: string;
}

export interface IntakeResult {
  status: 200 | 201;
  body: LeadAccepted;
}

/** Точки приёма (для теста сбоя до COMMIT, AT-CORE-03). */
export type IntakeStep = 'lead' | 'contact' | 'session' | 'event' | 'outbox';

interface Keys {
  contact: DerivedKeys;
  match: DerivedKeys;
  rate: DerivedKeys;
}

@Injectable()
export class LeadIntakeService {
  private readonly logger = new Logger('PublisherLeadIntake');

  constructor(
    private readonly db: PublisherPublicDb,
    private readonly products: PublicProductResolver,
  ) {}

  /** Хук шага (тест сбоя до COMMIT); в проде ничего не делает. */
  protected async afterStep(_step: IntakeStep): Promise<void> {}

  async submit(
    raw: unknown,
    client: IntakeRequest,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<IntakeResult> {
    assertIntakeConfigured(this.db);
    const b = (raw ?? {}) as Record<string, unknown>;
    const product = await this.products.require(publicKeyOf(b.key));
    assertOrigin(product, client.origin, 'POST');
    if (!product.formOpen) {
      throw publicError('PUB_FORM_CLOSED', {
        altContact: product.altContact ?? null,
        reason: 'closed',
      });
    }
    const v = validateLeadBody(raw);
    if (!v.ok) throw publicError('PUB_VALIDATION', { fields: v.fields });
    const keys = this.keys(env);
    const canonical = requestCanonical(v.value);
    const requestHash = leadRequestHmac(product.id, canonical, keys.match);
    const knownHashes = leadRequestHmacs(product.id, canonical, keys.match);
    try {
      return await this.db.$transaction(
        (tx) =>
          this.intake(tx as unknown as RawTx, product, v.value, {
            trap: v.trap,
            suspectedSpam: v.suspectedSpam,
            requestHash,
            knownHashes,
            keys,
            ip: client.ip,
          }),
        PUBLIC_TX_OPTIONS,
      );
    } catch (e) {
      throw this.mapError(e, product);
    }
  }

  private keys(env: NodeJS.ProcessEnv): Keys {
    const contact = publisherKeys('leadContact', env);
    const match = publisherKeys('contactMatch', env);
    const rate = publisherKeys('rateIp', env);
    if (!contact || !match || !rate) {
      // Без ключа заявка НЕ пишется открытым текстом (§6.5).
      throw publicError('PUB_CONTACT_KEY_MISSING');
    }
    return { contact, match, rate };
  }

  private async intake(
    tx: RawTx,
    product: PublicProduct,
    v: LeadInput,
    o: {
      trap: boolean;
      suspectedSpam: boolean;
      requestHash: string;
      knownHashes: string[];
      keys: Keys;
      ip: string;
    },
  ): Promise<IntakeResult> {
    // Стенд E2E: время сервера БД строк приёма — часы стенда (прод: ничего).
    await applyStandDbClock(tx);
    // 1. Повтор той же отправки — до лимитера.
    await lockKey(tx, `lead-submission:${product.id}:${v.submissionKey}`);
    const prev = await tx.$queryRaw<
      Array<{
        id: string;
        requestHash: string;
        publicRef: string;
        receivedAt: Date;
      }>
    >`
      SELECT "id", "requestHash", "publicRef", "receivedAt"
        FROM "sites"."pub_leads"
       WHERE "productId" = ${product.id} AND "submissionKey" = ${v.submissionKey}`;
    if (prev[0]) {
      if (!o.knownHashes.includes(prev[0].requestHash)) {
        throw publicError('PUB_IDEMPOTENCY_REUSED');
      }
      return {
        status: 200,
        body: {
          leadRef: prev[0].publicRef,
          receivedAt: prev[0].receivedAt.toISOString(),
          eventId: successEventIdOf(prev[0].id),
        },
      };
    }
    // 2. Скользящее окно лимита формы.
    const limit = await slidingWindowHit(
      tx,
      rateKey(product.id, RATE_SCOPES.form, ipKeyHmac(o.ip, o.keys.rate)),
      product.formLimitCount,
      product.formLimitWindowSec,
      newRowId('rh_'),
    );
    if (!limit.ok) {
      throw publicError('PUB_RATE_LIMITED', {
        retryAfterSec: limit.retryAfterSec,
        altContact: product.altContact ?? null,
      });
    }
    // 3. Ловушка: ответ как при успехе, без записи заявки — но с
    // обезличенным следом (аудит P-D S3-5): строка счётчика без тела и IP
    // и строка журнала только с id продукта. Ложное срабатывание
    // (автозаполнение скрытого поля) так видно в диагностике паспорта.
    if (o.trap) {
      await tx.$executeRaw`
        INSERT INTO "sites"."pub_rate_hits" ("id", "key")
        VALUES (${newRowId('rh_')}, ${trapKey(product.id)})`;
      this.logger.warn(
        `форма: сработала ловушка hp — заявка не записана (продукт ${product.id})`,
      );
      return {
        status: 201,
        body: {
          leadRef: newPublicRef(),
          receivedAt: new Date().toISOString(),
          eventId: randomUUID(),
        },
      };
    }
    // 4. Минимальная запись.
    const { testFlag, testReason } = testFlagOf(product);
    const leadId = newRowId('pl_');
    // `sessionRef`, похожий на контакт, не хранится (аудит P-D S3-2).
    const sessionRef =
      product.analyticsStorage === 'session'
        ? attributionField(v.sessionRef)
        : null;
    const contentSlug = attributionField(v.contentSlug);
    const placementCode = attributionField(v.placementCode);
    const reviewDueAt = addKyivCalendarDays(new Date(), INTAKE_REVIEW_DAYS);
    const inserted = await tx.$queryRaw<
      Array<{ id: string; publicRef: string; receivedAt: Date }>
    >`
      INSERT INTO "sites"."pub_leads"
        ("id", "accountId", "productId", "submissionKey", "requestHash", "publicRef",
         "testFlag", "testReason", "suspectedSpam", "contactMethod", "budgetRange",
         "selfReportedChannel", "contentSlugRaw", "placementCodeRaw", "sessionRef",
         "consentState", "reviewDueAt")
      VALUES (${leadId}, ${product.accountId}, ${product.id}, ${v.submissionKey},
              ${o.requestHash}, ${newPublicRef()}, ${testFlag}, ${testReason},
              ${o.suspectedSpam}, ${v.contactMethod}, ${v.budgetRange},
              ${v.selfReportedChannel}, ${contentSlug}, ${placementCode}, ${sessionRef},
              ${v.consentState}, ${reviewDueAt})
      ON CONFLICT DO NOTHING
      RETURNING "id", "publicRef", "receivedAt"`;
    const lead = inserted[0];
    // Совпадение publicRef (2^-50) или гонка мимо блокировки — повтор клиента.
    if (!lead) throw publicError('PUB_BUSY');
    await this.afterStep('lead');

    // Версия уведомления о данных (аудит P-D S3-4): что видел заявитель и
    // какая действовала у продукта при приёме — в шифре заявки (колонки в
    // `pub_leads` нет, схема заморожена — запрос 17.4); несовпадение —
    // мягкая пометка при раскрытии, заявка не теряется (кэш страницы
    // мог держать прежний текст).
    const payload: ContactPayload & NoticeTrace = {
      name: v.name,
      contactMethod: v.contactMethod,
      contact: v.contact,
      business: v.business,
      task: v.task,
      selfReported: v.selfReportedNote,
      dataNoticeVersion: v.dataNoticeVersion,
      dataNoticeExpected: product.dataNotice?.version ?? null,
    };
    const sealed = sealContact(payload, lead.id, o.keys.contact);
    await tx.$executeRaw`
      INSERT INTO "sites"."pub_lead_contacts"
        ("id", "accountId", "productId", "leadId", "contactEnc", "matchHash", "keyVersion")
      VALUES (${newRowId('lc_')}, ${product.accountId}, ${product.id}, ${lead.id},
              ${sealed.enc},
              ${contactMatchHash(product.id, v.contactMethod, v.contact, o.keys.match)},
              ${sealed.keyVersion})`;
    await this.afterStep('contact');

    const utm = cleanUtm(v.utm);
    if (sessionRef) {
      await tx.$executeRaw`
        INSERT INTO "sites"."pub_sessions"
          ("id", "accountId", "productId", "sessionRef", "landingPath", "contentSlugRaw",
           "placementCodeRaw", "utm", "consentState", "testFlag")
        VALUES (${newRowId('ps_')}, ${product.accountId}, ${product.id}, ${sessionRef},
                ${'/'}, ${contentSlug}, ${placementCode},
                ${JSON.stringify(utm.utm ?? {})}::jsonb, ${v.consentState}, ${testFlag})
        ON CONFLICT DO NOTHING`;
      await this.afterStep('session');
    }

    await tx.$executeRaw`
      INSERT INTO "sites"."pub_events"
        ("id", "accountId", "productId", "eventId", "name", "contentSlugRaw",
         "placementCodeRaw", "sessionRef", "utm", "utmRedacted", "leadId", "testFlag")
      VALUES (${newRowId('pe_')}, ${product.accountId}, ${product.id},
              ${successEventIdOf(lead.id)}, ${'lead_submit_success'}, ${contentSlug},
              ${placementCode}, ${sessionRef},
              ${utm.utm ? JSON.stringify(utm.utm) : null}::jsonb, ${utm.redacted},
              ${lead.id}, ${testFlag})
      ON CONFLICT DO NOTHING`;
    await this.afterStep('event');

    await tx.$executeRaw`
      INSERT INTO "sites"."pub_lead_outbox" ("id", "accountId", "productId", "leadId", "kind")
      VALUES (${newRowId('lo_')}, ${product.accountId}, ${product.id}, ${lead.id},
              ${'lead_received'})
      ON CONFLICT DO NOTHING`;
    await this.afterStep('outbox');

    return {
      status: 201,
      body: {
        leadRef: lead.publicRef,
        receivedAt: lead.receivedAt.toISOString(),
        eventId: successEventIdOf(lead.id),
      },
    };
  }

  /**
   * Ошибка базы → честный ответ. Отказ «продукт не принимает заявки»
   * (форма закрылась между чтением конфига и вставкой) — 503 с
   * альтернативным контактом; таймаут/блокировка — 503 `PUB_BUSY`
   * (повторить с тем же `submissionKey`); прочее — как есть (500). Текст
   * ошибки базы в ответ не идёт, в лог — только код.
   */
  private mapError(e: unknown, product: PublicProduct): unknown {
    if (isPublicError(e)) return e;
    const code = dbCodeOf(e);
    const msg = messagesOf(e);
    if (code === '23514' && /не принимает/.test(msg)) {
      return publicError('PUB_FORM_CLOSED', {
        altContact: product.altContact ?? null,
        reason: 'closed',
      });
    }
    if (
      code === 'P2028' ||
      code === 'P2034' ||
      code === '40001' ||
      code === '40P01' ||
      code === '55P03'
    ) {
      return publicError('PUB_BUSY');
    }
    this.logger.error(`приём заявки: ошибка базы ${code ?? 'unknown'}`);
    return e;
  }
}

/** SQLSTATE/код Prisma под обёртками адаптера. */
export function dbCodeOf(e: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (x: unknown, depth: number): string | undefined => {
    if (!x || typeof x !== 'object' || seen.has(x) || depth > 6)
      return undefined;
    seen.add(x);
    const o = x as Record<string, unknown>;
    for (const k of ['originalCode', 'code']) {
      const v = o[k];
      if (typeof v === 'string' && /^([0-9A-Z]{5}|P\d{4})$/.test(v)) {
        if (/^P\d{4}$/.test(v) && v !== 'P2028' && v !== 'P2034') continue;
        return v;
      }
    }
    for (const k of ['cause', 'meta', 'driverAdapterError', 'error']) {
      const r = walk(o[k], depth + 1);
      if (r) return r;
    }
    return undefined;
  };
  return walk(e, 0);
}

export function messagesOf(e: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const walk = (x: unknown, depth: number): void => {
    if (!x || typeof x !== 'object' || seen.has(x) || depth > 6) return;
    seen.add(x);
    const o = x as Record<string, unknown>;
    for (const k of ['message', 'originalMessage']) {
      if (typeof o[k] === 'string') parts.push(o[k] as string);
    }
    for (const k of ['cause', 'meta', 'driverAdapterError'])
      walk(o[k], depth + 1);
  };
  walk(e, 0);
  return parts.join(' | ');
}
