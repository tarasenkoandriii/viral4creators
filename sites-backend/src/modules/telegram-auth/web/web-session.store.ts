/**
 * Хранилище сессий веб-кабинета (`site_web_sessions`). Абстракция — ради
 * тестов гварда и маршрутов без базы: правила (хеш токена, сроки,
 * продление) живут в `WebSessionService`, а хранилище только читает и
 * пишет строки.
 */

import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';

export interface WebSessionRow {
  id: string;
  tokenHash: string;
  telegramId: bigint;
  app: string;
  username: string | null;
  firstName: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ipHash: string | null;
}

export type NewWebSession = Omit<WebSessionRow, 'id' | 'revokedAt'>;

export abstract class WebSessionStore {
  abstract create(data: NewWebSession): Promise<WebSessionRow>;
  abstract findByTokenHash(tokenHash: string): Promise<WebSessionRow | null>;
  /** Продление: только живой (не отозванной) сессии. */
  abstract extend(id: string, expiresAt: Date): Promise<void>;
  abstract revokeByTokenHash(tokenHash: string, at: Date): Promise<number>;
  abstract revokeAllForTelegramId(
    telegramId: bigint,
    at: Date,
  ): Promise<number>;
  abstract deleteExpired(before: Date): Promise<number>;
}

/**
 * Prisma-реализация. `SitesDb` — `@Optional`: модуль авторизации
 * подключают тесты без базы (гвард, вебхуки), а cookie-пути там нет. Если
 * же база не подключена, а сессия понадобилась, — 503, а не «пустить».
 */
@Injectable()
export class PrismaWebSessionStore extends WebSessionStore {
  constructor(@Optional() private readonly db?: SitesDb) {
    super();
  }

  private sessions() {
    if (!this.db) {
      throw new ServiceUnavailableException(
        'Вход в веб-кабинет временно недоступен',
      );
    }
    // Таблица вне тенанта (prisma/tenant.ts, NON_TENANT_MODELS): `guarded`
    // её пропускает как есть, а случайный запрос к таблице кабинета через
    // этот же клиент — бросит.
    return this.db.guarded.siteWebSession;
  }

  create(data: NewWebSession): Promise<WebSessionRow> {
    return this.sessions().create({ data });
  }

  findByTokenHash(tokenHash: string): Promise<WebSessionRow | null> {
    return this.sessions().findUnique({ where: { tokenHash } });
  }

  async extend(id: string, expiresAt: Date): Promise<void> {
    await this.sessions().updateMany({
      where: { id, revokedAt: null },
      data: { expiresAt },
    });
  }

  async revokeByTokenHash(tokenHash: string, at: Date): Promise<number> {
    const r = await this.sessions().updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: at },
    });
    return r.count;
  }

  async revokeAllForTelegramId(telegramId: bigint, at: Date): Promise<number> {
    const r = await this.sessions().updateMany({
      where: { telegramId, revokedAt: null },
      data: { revokedAt: at },
    });
    return r.count;
  }

  async deleteExpired(before: Date): Promise<number> {
    const r = await this.sessions().deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return r.count;
  }
}
