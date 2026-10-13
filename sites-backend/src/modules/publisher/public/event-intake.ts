/**
 * AI Publisher — приём событий `POST /public/publisher/v1/events` (P-D,
 * проектный документ §11.4, §13.5; ТЗ §14; AT-CORE-09, AT-F11-01/02).
 *
 * Тело — `text/plain` ≤ 2 КБ с JSON внутри (трекер шлёт `sendBeacon`:
 * межсайтовый `application/json` браузер без preflight не отправит,
 * аудит P2-24; потолок и 413 — `app.setup.ts`). Клиент шлёт только
 * `content_view` и `cta_click`; `lead_submit_success` создаёт сервер в
 * транзакции приёма заявки (§13.5).
 *
 * Запись сырая и минимальная (одна транзакция под `publisher_public`):
 * лимиты (120 в минуту на IP, 30 в минуту на `sessionRef`) → сессия
 * `INSERT … ON CONFLICT DO NOTHING` (первое событие сессии; только при
 * `analytics_storage='session'`) → событие `INSERT … ON CONFLICT DO
 * NOTHING` (дубликат `eventId` — тоже 202, второй строки нет).
 * `contentId/placementId/channelGroup` ставит обогащение (`lead-enrich`).
 *
 * Очистка: UTM — четыре ключа, значение-контакт → `[redacted]` + флаг
 * `utmRedacted`; путь — без query и фрагмента (там бывают контакты);
 * `referrerHost` — только хост; slug и код размещения, похожие на контакт,
 * отбрасываются. Ни имени, ни контакта, ни текста задачи событие не несёт.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PublisherPublicDb } from '../../../prisma/publisher-public-db.service';
import {
  CLIENT_EVENT_NAMES,
  PUBLIC_LIMITS,
  type ClientEventName,
  type EventAccepted,
} from '../contracts/public-api';
import type { FieldIssue } from '../contracts/errors';
import { CONSENT_STATES, type ConsentState } from '../contracts/states';
import { applyStandDbClock } from '../core/clock';
import { publisherKeys } from '../core/contact-crypto';
import { cleanUtm, cleanUtmValue } from '../core/utm';
import {
  PublicProductResolver,
  assertIntakeConfigured,
  assertOrigin,
  isPublicError,
  publicError,
  publicKeyOf,
  testFlagOf,
} from './public-guard';
import {
  PUBLIC_TX_OPTIONS,
  dbCodeOf,
  messagesOf,
  newRowId,
} from './lead-intake';
import {
  RATE_SCOPES,
  ipKeyHmac,
  rateKey,
  sessionKeyHmac,
  slidingWindowHit,
  type RawTx,
} from './rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z0-9-]{3,80}$/;
const PLACEMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SESSION_REF_RE = /^[A-Za-z0-9_-]{8,100}$/;
const HOST_RE = /^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
const PATH_MAX = 2048;
/** Время клиента дальше 12 ч от сервера — не сохраняется (справочное поле; часы, не сутки). */
const CLIENT_AT_SKEW_MS = 12 * 60 * 60 * 1000;

/** Нормализованное событие (без продукта). */
export interface EventInput {
  key: string;
  eventId: string;
  name: ClientEventName;
  landingPath: string;
  contentSlug: string | null;
  placementCode: string | null;
  referrerHost: string | null;
  sessionRef: string | null;
  utm: ReturnType<typeof cleanUtm>;
  consentState: ConsentState;
  clientAt: Date | null;
}

/**
 * Путь страницы без query и фрагмента; с `@`, кривой или с сегментом,
 * похожим на контакт (телефон, email, ссылка мессенджера; даты и суммы —
 * не контакт, правило `pii-guard`), — `/` (аудит P-D S3-2: AT-CORE-09
 * «в аналитических payload нет телефона» держит сервер, не только трекер).
 */
export function landingPathOf(v: unknown): string {
  if (typeof v !== 'string') return '/';
  const path = v.trim().split(/[?#]/)[0];
  if (!path.startsWith('/') || path.includes('@') || path.length > PATH_MAX) {
    return '/';
  }
  for (const seg of path.split('/')) {
    let text = seg;
    try {
      text = decodeURIComponent(seg);
    } catch {
      return '/';
    }
    if (text && cleanUtmValue(text).redacted) return '/';
  }
  return path;
}

/** Только хост перехода; адрес целиком сводится к хосту. */
export function referrerHostOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  let h = v.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(h)) {
    try {
      h = new URL(h).host;
    } catch {
      return null;
    }
  }
  return HOST_RE.test(h) ? h : null;
}

/** Мягкое поле: формат и «не похоже на контакт», иначе null. */
function soft(v: unknown, re: RegExp): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!re.test(t)) return null;
  return cleanUtmValue(t).redacted ? null : t;
}

/** Разбор тела события (строка JSON или объект). */
export function parseEventBody(
  raw: unknown,
  now = new Date(),
): { ok: true; value: EventInput } | { ok: false; fields: FieldIssue[] } {
  let b: unknown = raw;
  if (typeof raw === 'string') {
    try {
      b = JSON.parse(raw);
    } catch {
      return { ok: false, fields: [{ field: 'body', code: 'json' }] };
    }
  }
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    return { ok: false, fields: [{ field: '$', code: 'type' }] };
  }
  const o = b as Record<string, unknown>;
  const fields: FieldIssue[] = [];
  const key = typeof o.key === 'string' ? o.key.trim() : '';
  if (!/^pp_[A-Za-z0-9]{24}$/.test(key)) {
    fields.push({
      field: 'key',
      code: o.key === undefined ? 'required' : 'format',
    });
  }
  const eventId =
    typeof o.eventId === 'string' ? o.eventId.trim().toLowerCase() : '';
  if (!UUID_RE.test(eventId)) {
    fields.push({
      field: 'eventId',
      code: o.eventId === undefined ? 'required' : 'format',
    });
  }
  if (!(CLIENT_EVENT_NAMES as readonly unknown[]).includes(o.name)) {
    fields.push({
      field: 'name',
      code: o.name === undefined ? 'required' : 'enum',
    });
  }
  if (!(CONSENT_STATES as readonly unknown[]).includes(o.consentState)) {
    fields.push({
      field: 'consentState',
      code: o.consentState === undefined ? 'required' : 'enum',
    });
  }
  if (fields.length) return { ok: false, fields };
  let clientAt: Date | null = null;
  if (typeof o.clientAt === 'string') {
    const t = new Date(o.clientAt);
    if (
      !Number.isNaN(t.getTime()) &&
      Math.abs(t.getTime() - now.getTime()) <= CLIENT_AT_SKEW_MS
    ) {
      clientAt = t;
    }
  }
  return {
    ok: true,
    value: {
      key,
      eventId,
      name: o.name as ClientEventName,
      landingPath: landingPathOf(o.path),
      contentSlug: soft(o.contentSlug, SLUG_RE),
      placementCode: soft(o.placementCode, PLACEMENT_RE),
      referrerHost: referrerHostOf(o.referrerHost),
      // Похожий на контакт `sessionRef` (кривой/злонамеренный клиент) не
      // хранится: штатный трекер шлёт случайные 22 символа base64url.
      sessionRef: soft(o.sessionRef, SESSION_REF_RE),
      utm: cleanUtm(o.utm),
      consentState: o.consentState as ConsentState,
      clientAt,
    },
  };
}

@Injectable()
export class EventIntakeService {
  private readonly logger = new Logger('PublisherEventIntake');

  constructor(
    private readonly db: PublisherPublicDb,
    private readonly products: PublicProductResolver,
  ) {}

  async track(
    raw: unknown,
    client: { origin: string | undefined; ip: string },
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<EventAccepted> {
    assertIntakeConfigured(this.db);
    const parsed = parseEventBody(raw);
    if (!parsed.ok) {
      // Ключ продукта нужен и для 404/403 — но без валидного тела ответ 400.
      throw publicError('PUB_VALIDATION', { fields: parsed.fields });
    }
    const v = parsed.value;
    const product = await this.products.require(publicKeyOf(v.key));
    assertOrigin(product, client.origin, 'POST');
    if (product.mode !== 'test' && product.mode !== 'live') {
      throw publicError('PUB_FORM_CLOSED', {
        altContact: product.altContact ?? null,
        reason: 'closed',
      });
    }
    const keys = publisherKeys('rateIp', env);
    if (!keys) throw publicError('PUB_CONTACT_KEY_MISSING');
    const { testFlag } = testFlagOf(product);
    const sessionRef =
      product.analyticsStorage === 'session' ? v.sessionRef : null;
    try {
      await this.db.$transaction(async (raw) => {
        const tx = raw as unknown as RawTx;
        await applyStandDbClock(tx);
        const ip = await slidingWindowHit(
          tx,
          rateKey(product.id, RATE_SCOPES.eventsIp, ipKeyHmac(client.ip, keys)),
          PUBLIC_LIMITS.eventsPerIpMinute,
          60,
          newRowId('rh_'),
        );
        if (!ip.ok) {
          throw publicError('PUB_RATE_LIMITED', {
            retryAfterSec: ip.retryAfterSec,
            altContact: product.altContact ?? null,
          });
        }
        if (v.sessionRef) {
          const s = await slidingWindowHit(
            tx,
            rateKey(
              product.id,
              RATE_SCOPES.eventsSession,
              sessionKeyHmac(v.sessionRef, keys),
            ),
            PUBLIC_LIMITS.eventsPerSessionMinute,
            60,
            newRowId('rh_'),
          );
          if (!s.ok) {
            throw publicError('PUB_RATE_LIMITED', {
              retryAfterSec: s.retryAfterSec,
              altContact: product.altContact ?? null,
            });
          }
        }
        if (sessionRef) {
          await tx.$executeRaw`
            INSERT INTO "sites"."pub_sessions"
              ("id", "accountId", "productId", "sessionRef", "landingPath", "contentSlugRaw",
               "placementCodeRaw", "utm", "consentState", "testFlag")
            VALUES (${newRowId('ps_')}, ${product.accountId}, ${product.id}, ${sessionRef},
                    ${v.landingPath}, ${v.contentSlug}, ${v.placementCode},
                    ${JSON.stringify(v.utm.utm ?? {})}::jsonb, ${v.consentState}, ${testFlag})
            ON CONFLICT DO NOTHING`;
        }
        await tx.$executeRaw`
          INSERT INTO "sites"."pub_events"
            ("id", "accountId", "productId", "eventId", "name", "clientAt", "contentSlugRaw",
             "placementCodeRaw", "referrerHost", "sessionRef", "utm", "utmRedacted", "testFlag")
          VALUES (${newRowId('pe_')}, ${product.accountId}, ${product.id}, ${v.eventId},
                  ${v.name}, ${v.clientAt}, ${v.contentSlug}, ${v.placementCode},
                  ${v.referrerHost}, ${sessionRef},
                  ${v.utm.utm ? JSON.stringify(v.utm.utm) : null}::jsonb, ${v.utm.redacted},
                  ${testFlag})
          ON CONFLICT DO NOTHING`;
      }, PUBLIC_TX_OPTIONS);
    } catch (e) {
      if (isPublicError(e)) throw e;
      const code = dbCodeOf(e);
      if (code === '23514' && /не принимает/.test(messagesOf(e))) {
        throw publicError('PUB_FORM_CLOSED', {
          altContact: product.altContact ?? null,
          reason: 'closed',
        });
      }
      if (code === 'P2028' || code === '40001' || code === '40P01') {
        throw publicError('PUB_BUSY');
      }
      this.logger.error(`приём события: ошибка базы ${code ?? 'unknown'}`);
      throw e;
    }
    return {};
  }
}
