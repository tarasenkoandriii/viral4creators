/**
 * Тестовые помощники веб-кабинета: хранилище сессий в памяти и подпись
 * данных Telegram Login Widget — по официальному алгоритму
 * (https://core.telegram.org/widgets/login#checking-authorization), а не
 * готовой константой: константа доказала бы лишь, что код не менялся.
 */

import { createHash, createHmac } from 'crypto';
import {
  NewWebSession,
  WebSessionRow,
  WebSessionStore,
} from '../web-session.store';

export class MemoryWebSessionStore extends WebSessionStore {
  readonly rows: WebSessionRow[] = [];
  private seq = 0;

  async create(data: NewWebSession): Promise<WebSessionRow> {
    if (this.rows.some((r) => r.tokenHash === data.tokenHash)) {
      throw new Error('unique tokenHash');
    }
    const row: WebSessionRow = {
      ...data,
      id: `ws_${++this.seq}`,
      revokedAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async findByTokenHash(tokenHash: string) {
    const r = this.rows.find((x) => x.tokenHash === tokenHash);
    return r ? { ...r } : null;
  }

  async extend(id: string, expiresAt: Date) {
    const r = this.rows.find((x) => x.id === id && x.revokedAt === null);
    if (r) r.expiresAt = expiresAt;
  }

  async revokeByTokenHash(tokenHash: string, at: Date) {
    let n = 0;
    for (const r of this.rows) {
      if (r.tokenHash === tokenHash && r.revokedAt === null) {
        r.revokedAt = at;
        n++;
      }
    }
    return n;
  }

  async revokeAllForTelegramId(telegramId: bigint, at: Date) {
    let n = 0;
    for (const r of this.rows) {
      if (r.telegramId === telegramId && r.revokedAt === null) {
        r.revokedAt = at;
        n++;
      }
    }
    return n;
  }

  async deleteExpired(before: Date) {
    const keep = this.rows.filter((r) => r.expiresAt >= before);
    const n = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return n;
  }
}

export interface WidgetSignOptions {
  botToken: string;
  id?: number;
  /** Секунды эпохи; по умолчанию — «сейчас». */
  authDate?: number;
  username?: string;
  firstName?: string;
}

/** Данные виджета так, как их отдаёт `data-onauth` Telegram. */
export function signWidget(opts: WidgetSignOptions): Record<string, unknown> {
  const fields: Record<string, string | number> = {
    id: opts.id ?? 777,
    first_name: opts.firstName ?? 'Андрій',
    username: opts.username ?? 'tester',
    photo_url: 'https://t.me/i/userpic/320/x.jpg',
    auth_date: opts.authDate ?? Math.floor(Date.now() / 1000),
  };
  const dcs = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(opts.botToken).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return { ...fields, hash };
}
