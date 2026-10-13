/**
 * AI Publisher — допуск публичных маршрутов приёма (P-D, проектный
 * документ §3.2, §11.4): ключ `pp_…` → продукт через представление
 * `pub_public_products` (роль `publisher_public`), Origin ∈ `allowedOrigins`
 * режима продукта, честные ошибки в общем конверте.
 *
 * Публичный код не берёт `core/errors` (правило графа
 * `publisher-public-zone`), поэтому своё исключение и фильтр — здесь, на
 * тех же кодах и текстах `contracts/errors.ts`. Их же может взять чтение
 * контента P-B1 (`public/content-public.*`).
 *
 * Origin не защищает от небраузерных клиентов (§3.3) — от них лимиты и
 * минимальная запись; запрос без Origin допускается только для GET
 * (серверная сборка сайта).
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { PublisherPublicDb } from '../../../prisma/publisher-public-db.service';
import {
  PUB_ERROR_MESSAGES,
  PUB_ERROR_STATUS,
  pubLangOf,
  type PubErrorCode,
} from '../contracts/errors';
import type {
  ConsentState,
  ProductKind,
  ProductMode,
} from '../contracts/states';

export const PUBLIC_KEY_RE = /^pp_[A-Za-z0-9]{24}$/;

/** Ошибка публичного маршрута Publisher (код и статус — `contracts/errors`). */
export class PublicError extends HttpException {
  constructor(
    readonly code: PubErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(
      { error: code, code, message: PUB_ERROR_MESSAGES[code].uk, details },
      PUB_ERROR_STATUS[code],
    );
    this.name = 'PublicError';
  }
}

export const publicError = (
  code: PubErrorCode,
  details: Record<string, unknown> = {},
): PublicError => new PublicError(code, details);

export function isPublicError(
  e: unknown,
  code?: PubErrorCode,
): e is PublicError {
  return e instanceof PublicError && (code === undefined || e.code === code);
}

/**
 * Фильтр публичных ошибок: общий конверт `{success:false, error:{code,
 * message, details?}, meta}`, текст по `Accept-Language`, `Retry-After`
 * для 429, `Cache-Control: no-store` (ошибка не кэшируется CDN). В лог —
 * метод, путь, код и requestId (тела и контактов нет).
 */
@Catch(PublicError)
export class PublicErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('PublisherPublic');

  catch(e: PublicError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = randomUUID();
    const status = e.getStatus();
    const lang = pubLangOf(
      req.headers?.['accept-language'] as string | undefined,
    );
    const path = req.path ?? (req.url ?? '').split('?')[0];
    const line = `${req.method} ${path} → ${status} ${e.code} [${requestId}]`;
    if (status >= 500) this.logger.error(line);
    else this.logger.warn(line);
    res.setHeader('Cache-Control', 'no-store');
    if (e.code === 'PUB_RATE_LIMITED') {
      const after = Number(e.details.retryAfterSec);
      if (Number.isFinite(after) && after > 0) {
        res.setHeader('Retry-After', String(Math.ceil(after)));
      }
    }
    const hasDetails = Object.keys(e.details).length > 0;
    res.status(status).json({
      success: false,
      error: {
        code: e.code,
        message: PUB_ERROR_MESSAGES[e.code][lang],
        ...(hasDetails ? { details: e.details } : {}),
      },
      meta: { timestamp: new Date().toISOString(), requestId, path },
    });
  }
}

/** Строка `pub_public_products` (§6.5). */
export interface PublicProduct {
  id: string;
  accountId: string;
  publicKey: string;
  kind: ProductKind;
  mode: ProductMode;
  formOpen: boolean;
  allowedOrigins: string[];
  indexableHosts: string[];
  altContact: unknown;
  formLimitCount: number;
  formLimitWindowSec: number;
  analyticsStorage: 'none' | 'session';
  consentState: ConsentState;
  dataNotice: {
    version: string | null;
    text: string | null;
    approved: boolean;
  } | null;
  faq: unknown[];
  offer: {
    title: string | null;
    text: string | null;
    priceNote: string | null;
  } | null;
  /** Правило `contact_sla` или null (Р-PUB-Z2-9). */
  contactSla: { rule: string } | null;
}

/** Тестовая ли запись приёма и почему (триггер `pub_leads_guard`). */
export function testFlagOf(p: Pick<PublicProduct, 'kind' | 'mode'>): {
  testFlag: boolean;
  testReason: 'test_product' | 'test_mode' | null;
} {
  if (p.kind !== 'working')
    return { testFlag: true, testReason: 'test_product' };
  if (p.mode !== 'live') return { testFlag: true, testReason: 'test_mode' };
  return { testFlag: false, testReason: null };
}

/** Origin запроса (нормализованный) или undefined. */
export function originOf(req: Pick<Request, 'headers'>): string | undefined {
  const raw = req.headers?.origin;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string' || v.trim() === '' || v === 'null')
    return undefined;
  return v.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Допуск по Origin (§11.4): с Origin — только из `allowedOrigins` режима
 * продукта; без Origin — только чтение (GET). Иначе 403 `PUB_ORIGIN_DENIED`.
 */
export function assertOrigin(
  product: Pick<PublicProduct, 'allowedOrigins'>,
  origin: string | undefined,
  method: 'GET' | 'POST',
): void {
  if (origin === undefined) {
    if (method === 'GET') return;
    throw publicError('PUB_ORIGIN_DENIED');
  }
  const allowed = product.allowedOrigins.map((o) => o.toLowerCase());
  if (!allowed.includes(origin)) throw publicError('PUB_ORIGIN_DENIED');
}

/** Ключ продукта из тела/запроса: формат или 400 `PUB_VALIDATION`. */
export function publicKeyOf(v: unknown): string {
  if (typeof v !== 'string' || !PUBLIC_KEY_RE.test(v.trim())) {
    throw publicError('PUB_VALIDATION', {
      fields: [{ field: 'key', code: v === undefined ? 'required' : 'format' }],
    });
  }
  return v.trim();
}

/** Публичный клиент сконфигурирован; иначе приём закрыт честным 503. */
export function assertIntakeConfigured(db: PublisherPublicDb): void {
  if (!db.configured) {
    throw publicError('PUB_FORM_CLOSED', {
      altContact: null,
      reason: 'intake_unavailable',
    });
  }
}

type ProductRow = Omit<
  PublicProduct,
  'formLimitCount' | 'formLimitWindowSec'
> & {
  formLimitCount: number | bigint;
  formLimitWindowSec: number | bigint;
};

@Injectable()
export class PublicProductResolver {
  constructor(private readonly db: PublisherPublicDb) {}

  /** Продукт по публичному ключу (представление; архивных и eval нет). */
  async byKey(key: string): Promise<PublicProduct | null> {
    const rows = await this.db.$queryRaw<ProductRow[]>`
      SELECT "id", "accountId", "publicKey", "kind", "mode", "formOpen",
             "allowedOrigins", "indexableHosts", "altContact",
             "formLimitCount", "formLimitWindowSec", "analyticsStorage",
             "consentState", "dataNotice", "faq", "offer", "contactSla"
        FROM "sites"."pub_public_products"
       WHERE "publicKey" = ${key}`;
    const r = rows[0];
    if (!r) return null;
    return {
      ...r,
      allowedOrigins: r.allowedOrigins ?? [],
      indexableHosts: r.indexableHosts ?? [],
      formLimitCount: Number(r.formLimitCount),
      formLimitWindowSec: Number(r.formLimitWindowSec),
      faq: Array.isArray(r.faq) ? r.faq : [],
      contactSla:
        r.contactSla && typeof r.contactSla.rule === 'string'
          ? { rule: r.contactSla.rule }
          : null,
    };
  }

  /** То же, но неизвестный ключ — 404 `PUB_NOT_FOUND`. */
  async require(key: string): Promise<PublicProduct> {
    const p = await this.byKey(key);
    if (!p) throw publicError('PUB_NOT_FOUND');
    return p;
  }
}
