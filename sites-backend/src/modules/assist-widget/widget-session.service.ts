/**
 * Сессия посетителя и указатель resumeKey (ТЗ §4.13 п.2, §4-бис.3, Р-27) — W2.
 *
 * `session`: гвард origin → лимит выдачи (5/мин на ipHash) → resumeKey из
 * тела или CHIPS-cookie (при расхождении побеждает cookie, она HttpOnly) →
 * найден, не истёк, тот же сайт и тот же parentOrigin (или другой
 * verified-хост ТОГО ЖЕ сайта и того же eTLD+1, §4-бис.3) → тот же
 * visitorId, продление 30 дней; иначе новый посетитель (resumeLost, если
 * ключ был). Новый ключ — 32 байта, в базе SHA-256; в ответе — один раз,
 * плюс `Set-Cookie: <widgetResumeCookieName(pk)>=…; Path=/; Secure; HttpOnly;
 * SameSite=None; Partitioned; Max-Age=30 дней`. Имя — СВОЁ для каждого pk:
 * CHIPS делит секцию на eTLD+1 верхнего сайта, и два сайта клиентов на
 * одном eTLD+1 с общим именем перезаписывали бы указатели друг друга.
 * ipHash = hashIpWithDailySalt(ip, widgetIpSecret() + assist_sites.ipSalt).
 *
 * Сессия предпросмотра указателя не получает и не восстанавливает: это
 * владелец в конфигураторе, а не посетитель — его «диалог» не должен
 * смешиваться с настоящим посетителем того же браузера.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { widgetResumeCookieName } from '../../brand';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import {
  widgetIpSecret,
  widgetOrigin,
  widgetTokenKey,
  widgetTokenKeys,
} from '../../config/widget-env';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { hashIpWithDailySalt } from '../../shared/assist-chat-core';
import type {
  WidgetSiteContext,
  WidgetVisitor,
} from '../assist-site-chat/chat-types';
import { ipLimitKey } from '../assist-sandbox/sandbox-limits';
import type { WidgetSessionRequest, WidgetSessionResponse } from './api-types';
import { WidgetOriginGuard, type OriginDecision } from './origin-guard';
import { WidgetRateLimit } from './rate-limit';
import { sha256Hex, siteOfOrigin, siteHostAccess } from './site-access';
import { inspectVisitorToken, signVisitorToken } from './visitor-token';
import { widgetError } from './widget-errors';

export interface SessionResult {
  body: WidgetSessionResponse;
  /** Значение для Set-Cookie (контроллер ставит заголовок) или null. */
  setResumeCookie: string | null;
}

/** Проверенный запрос с visitor-token — то, что получают остальные маршруты. */
export interface VisitorContext {
  site: WidgetSiteContext;
  visitor: WidgetVisitor;
}

const RESUME_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const MINUTE = 60_000;

/** Значение Set-Cookie указателя сайта `pk` (CHIPS, host-only `__Host-`). */
export function resumeCookie(pk: string, key: string | null): string {
  const maxAge =
    key === null ? 0 : Math.floor(WIDGET_DEFAULTS.resumeTtlMs / 1000);
  return `${widgetResumeCookieName(pk)}=${key ?? ''}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=None; Partitioned`;
}

/** Указатель сайта `pk` из заголовка Cookie (только его имя, только правильной формы). */
export function resumeKeyFromCookie(
  header: string | undefined,
  pk: string,
): string | null {
  if (!header || typeof pk !== 'string' || !pk) return null;
  const name = widgetResumeCookieName(pk);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const v = part.slice(eq + 1).trim();
    return RESUME_KEY_RE.test(v) ? v : null;
  }
  return null;
}

export function deniedError(
  code: Exclude<OriginDecision, { ok: true }>['code'],
) {
  return widgetError(code);
}

@Injectable()
export class WidgetSessionService {
  private readonly logger = new Logger(WidgetSessionService.name);

  constructor(
    private readonly db: AssistPublicDb,
    private readonly guard: WidgetOriginGuard,
    private readonly rate: WidgetRateLimit,
  ) {}

  /** ipHash посетителя: суточная соль + соль сайта (§6.4). */
  ipHash(ip: string, siteSalt: string | null, now: Date): string {
    const secret = widgetIpSecret();
    if (!secret) throw widgetError('WIDGET_DISABLED');
    return hashIpWithDailySalt(
      ipLimitKey(ip),
      `${secret}:${siteSalt ?? ''}`,
      now,
    );
  }

  async start(p: {
    body: WidgetSessionRequest;
    requestOrigin: string | undefined;
    ip: string;
    cookieResumeKey: string | null;
    now?: Date;
  }): Promise<SessionResult> {
    const now = p.now ?? new Date();
    const key = widgetTokenKey();
    if (!key) throw widgetError('WIDGET_DISABLED');

    const { decision, row, preview } = await this.guard.resolveDetailed({
      pk: p.body.pk,
      requestOrigin: p.requestOrigin,
      parentOrigin: p.body.parentOrigin,
      previewSession: p.body.previewSession ?? null,
      now,
    });
    if (!decision.ok || !row) {
      this.logger.log(
        `session denied: ${decision.ok ? 'NO_ROW' : decision.code}`,
      );
      throw deniedError(decision.ok ? 'ORIGIN_DENIED' : decision.code);
    }
    const site = decision.site;
    const ipHash = this.ipHash(p.ip, row.ipSalt, now);
    await this.rate.enforce(
      [
        {
          scope: 'widget-session-ip',
          key: `${site.siteId}:${ipHash}`,
          limit: WIDGET_DEFAULTS.sessionsPerIpPerMinute,
          windowMs: MINUTE,
        },
      ],
      now,
    );

    let visitorId: string | null = null;
    let newKey: string | null = null;
    let cookieKey: string | null = null;
    let resumed = false;
    let resumeLost = false;

    if (!site.preview) {
      // При расхождении побеждает cookie (HttpOnly — её не подменит даже
      // XSS в iframe); тело — для браузеров без CHIPS.
      const bodyKey =
        typeof p.body.resumeKey === 'string' &&
        RESUME_KEY_RE.test(p.body.resumeKey)
          ? p.body.resumeKey
          : null;
      const presented = p.cookieResumeKey ?? bodyKey;
      if (presented) {
        visitorId = await this.tryResume(presented, site, now);
        if (visitorId) {
          resumed = true;
          cookieKey = presented;
        } else {
          resumeLost = true;
        }
      } else if (p.body.resumeKey) {
        // Был мусор вместо ключа — тоже потеря указателя (метрика).
        resumeLost = true;
      }
      if (!visitorId) {
        visitorId = `v_${randomBytes(16).toString('base64url')}`;
        newKey = randomBytes(32).toString('base64url');
        await this.db.assistSiteVisitorResume.createMany({
          data: [
            {
              keyHash: sha256Hex(newKey),
              siteId: site.siteId,
              visitorId,
              parentOrigin: site.parentOrigin,
              lastSeenAt: now,
              expiresAt: new Date(now.getTime() + WIDGET_DEFAULTS.resumeTtlMs),
              createdAt: now,
            },
          ],
        });
        cookieKey = newKey;
      }
    } else {
      visitorId = `p_${randomBytes(16).toString('base64url')}`;
    }

    let expMs = now.getTime() + WIDGET_DEFAULTS.visitorTokenTtlMs;
    if (preview) expMs = Math.min(expMs, preview.sessionExpiresAt.getTime());
    const iat = Math.floor(now.getTime() / 1000);
    const exp = Math.max(iat + 1, Math.floor(expMs / 1000));
    const visitorToken = signVisitorToken(
      {
        v: 1,
        siteId: site.siteId,
        visitorId,
        parentOrigin: site.parentOrigin,
        ipHash,
        preview: site.preview,
        iat,
        exp,
      },
      key,
    );
    this.logger.log(
      `session site=${site.siteId} resumed=${resumed} lost=${resumeLost} preview=${site.preview}`,
    );
    return {
      body: {
        visitorToken,
        expiresAt: new Date(exp * 1000).toISOString(),
        resumeKey: newKey,
        resumed,
        resumeLost,
        preview: site.preview,
      },
      setResumeCookie: cookieKey ? resumeCookie(p.body.pk, cookieKey) : null,
    };
  }

  /**
   * Указатель → visitorId. Тот же сайт; тот же origin родителя ИЛИ другой
   * допущенный хост этого же сайта с тем же eTLD+1 (одна секция хранилища
   * браузера, §4-бис.3). Найден — продление на 30 дней (скользящий срок).
   */
  private async tryResume(
    rawKey: string,
    site: WidgetSiteContext,
    now: Date,
  ): Promise<string | null> {
    const keyHash = sha256Hex(rawKey);
    const row = await this.db.assistSiteVisitorResume.findUnique({
      where: { keyHash },
      select: {
        siteId: true,
        visitorId: true,
        parentOrigin: true,
        expiresAt: true,
      },
    });
    if (!row || row.siteId !== site.siteId) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    if (row.parentOrigin !== site.parentOrigin) {
      const a = siteOfOrigin(row.parentOrigin);
      const b = siteOfOrigin(site.parentOrigin);
      if (!a || a !== b) return null;
      // Текущий origin уже допущен гвардом; прежний должен быть хостом
      // этого же сайта (иначе указатель мог прийти с чужого поддомена).
      const hosts = await siteHostAccess(this.db, site.siteId, now);
      if (!hosts.some((h) => h.origin === row.parentOrigin)) return null;
    }
    const updated = await this.db.assistSiteVisitorResume.updateMany({
      where: { keyHash, siteId: site.siteId, expiresAt: { gt: now } },
      data: {
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + WIDGET_DEFAULTS.resumeTtlMs),
      },
    });
    return updated.count === 1 ? row.visitorId : null;
  }

  /**
   * visitor-token из заголовка → контекст. Каждый раз заново: подпись,
   * срок, Origin запроса, допуск parentOrigin ТЕПЕРЬ (отзыв/72 ч), сайт
   * не выключен оператором. Отказы — SESSION_REQUIRED/SESSION_EXPIRED/ORIGIN_DENIED.
   *
   * «Выключен оператором/владельцем» — НЕ отказ сессии: чат отвечает формой
   * заявки (§4.13 п.6), это решает конвейер W3 (chatAvailability).
   */
  /**
   * pk, под которым посетитель получил сессию (для стирания cookie в
   * forget): тип ключа — из токена, сам ключ — из строки сайта.
   */
  async sessionPk(ctx: VisitorContext): Promise<string | null> {
    const row = await this.db.assistSite.findUnique({
      where: { siteId: ctx.site.siteId },
      select: { publicKey: true, testKey: true },
    });
    if (!row) return null;
    return ctx.site.keyKind === 'test' ? row.testKey : row.publicKey;
  }

  async authenticate(p: {
    token: string | undefined;
    requestOrigin: string | undefined;
    now?: Date;
  }): Promise<VisitorContext> {
    const now = p.now ?? new Date();
    // №60: проверка — текущим и прежними ключами связки ASSIST_SECRETS_KEY.
    const keys = widgetTokenKeys();
    if (!keys) throw widgetError('SESSION_REQUIRED');
    const check = inspectVisitorToken(p.token, keys, now);
    if (check.status === 'invalid') throw widgetError('SESSION_REQUIRED');
    if (check.status === 'expired') throw widgetError('SESSION_EXPIRED');
    const t = check.payload;
    if (p.requestOrigin !== widgetOrigin()) {
      throw widgetError('ORIGIN_DENIED');
    }
    const { decision } = await this.guard.recheck({
      siteId: t.siteId,
      parentOrigin: t.parentOrigin,
      preview: t.preview,
      now,
    });
    if (!decision.ok) {
      // Сайт пропал/ключи отозваны — сессия больше не годится; отзыв хоста —
      // ORIGIN_DENIED (iframe показывает «недоступен», без новой сессии).
      this.logger.log(`auth denied site=${t.siteId}: ${decision.code}`);
      throw widgetError(
        decision.code === 'ORIGIN_DENIED' ? 'ORIGIN_DENIED' : 'SESSION_EXPIRED',
      );
    }
    const sessionMessages = await this.db.assistSiteMessage.count({
      where: {
        siteId: t.siteId,
        role: 'visitor',
        createdAt: { gte: new Date(t.iat * 1000) },
        conversation: { visitorId: t.visitorId },
      },
    });
    return {
      site: decision.site,
      visitor: {
        visitorId: t.visitorId,
        ipHash: t.ipHash,
        tokenIssuedAt: new Date(t.iat * 1000),
        sessionMessages,
      },
    };
  }
}
