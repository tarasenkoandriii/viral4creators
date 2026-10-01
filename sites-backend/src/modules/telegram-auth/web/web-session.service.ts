/**
 * Сессии веб-кабинета: выдача, проверка, скользящее продление, отзыв.
 *
 *  - токен — 32 случайных байта (base64url), живёт ТОЛЬКО в HttpOnly-cookie;
 *    в базе — SHA-256 токена (как у приглашений кабинета): утечка таблицы
 *    или бэкапа не даёт войти;
 *  - срок — 7 дней, скользящий: каждый запрос может сдвинуть конец на
 *    «сейчас + 7 дней», но запись в базу — не чаще раза в сутки (иначе
 *    каждый GET кабинета был бы ещё и UPDATE);
 *  - абсолютный потолок — 30 дней от входа: украденная cookie не живёт
 *    вечно, даже если ею пользуются каждый день;
 *  - сессия — это личность Telegram, не членство в кабинете: удаление
 *    участника или блокировка сессий не трогают (права проверяет
 *    site-core на каждом запросе), «выйти везде» — `revokeAll`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import type { TelegramApp } from '../../../brand';
import { WebSessionRow, WebSessionStore } from './web-session.store';

export const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Продление пишется в базу не чаще этого. */
export const WEB_SESSION_RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Потолок жизни сессии от входа, сколько ни продлевай. */
export const WEB_SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

/** 32 байта в base64url — ровно 43 символа без `=`. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const USER_AGENT_MAX = 300;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssueInput {
  telegramId: bigint;
  app: TelegramApp;
  username: string | null;
  firstName: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
}

export interface IssuedSession {
  /** Сырой токен — только в Set-Cookie, ни в тело ответа, ни в лог. */
  token: string;
  expiresAt: Date;
  session: WebSessionRow;
}

export interface ResolvedSession {
  session: WebSessionRow;
  /** Новый конец сессии, если её продлили этим запросом (переставить cookie). */
  renewedUntil: Date | null;
}

@Injectable()
export class WebSessionService {
  private readonly logger = new Logger(WebSessionService.name);

  constructor(
    @Inject(WebSessionStore) private readonly store: WebSessionStore,
  ) {}

  async issue(input: IssueInput, now = new Date()): Promise<IssuedSession> {
    // Просроченные чистятся при входе (входы редки, удаление идемпотентно) —
    // как AdminAuthService.pruneExpiredSessions; отдельный крон не нужен.
    try {
      await this.store.deleteExpired(now);
    } catch (err) {
      this.logger.warn(`чистка просроченных сессий: ${String(err)}`);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + WEB_SESSION_TTL_MS);
    const session = await this.store.create({
      tokenHash: hashSessionToken(token),
      telegramId: input.telegramId,
      app: input.app,
      username: input.username,
      firstName: input.firstName,
      createdAt: now,
      expiresAt,
      userAgent: input.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
      ipHash: input.ipHash ?? null,
    });
    return { token, expiresAt, session };
  }

  /** Живая сессия по токену из cookie или `null` (неизвестна/отозвана/истекла). */
  async resolve(
    token: string | undefined,
    app: TelegramApp,
    now = new Date(),
  ): Promise<ResolvedSession | null> {
    // Мусор в cookie — не повод идти в базу.
    if (!token || !TOKEN_RE.test(token)) return null;
    const session = await this.store.findByTokenHash(hashSessionToken(token));
    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= now.getTime()) return null;
    if (session.app !== app) return null;

    const ceiling = session.createdAt.getTime() + WEB_SESSION_ABSOLUTE_MS;
    const target = Math.min(now.getTime() + WEB_SESSION_TTL_MS, ceiling);
    if (target - session.expiresAt.getTime() < WEB_SESSION_RENEW_INTERVAL_MS) {
      return { session, renewedUntil: null };
    }
    const renewedUntil = new Date(target);
    await this.store.extend(session.id, renewedUntil);
    return {
      session: { ...session, expiresAt: renewedUntil },
      renewedUntil,
    };
  }

  /** Выход из этой сессии; неизвестный токен — не ошибка. */
  async revoke(token: string | undefined, now = new Date()): Promise<boolean> {
    if (!token || !TOKEN_RE.test(token)) return false;
    return (
      (await this.store.revokeByTokenHash(hashSessionToken(token), now)) > 0
    );
  }

  /** «Выйти везде»: все живые веб-сессии этого человека. */
  revokeAll(telegramId: bigint, now = new Date()): Promise<number> {
    return this.store.revokeAllForTelegramId(telegramId, now);
  }
}
