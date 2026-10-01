/**
 * Аватар пользователя для админки (плашка `UserBadge`).
 *
 * Почему через Bot API, а не из initData: `photo_url` Mini App почти
 * всегда отсутствует, а колонки аватара в `User` нет (схему ради
 * картинки в админке не меняем). `getUserProfilePhotos` отдаёт фото
 * любого, кто хоть раз писал боту или открывал его Mini App, — то есть
 * ровно наших пользователей.
 *
 * Почему байты через наш сервер, а не ссылка: ссылка на файл Telegram
 * содержит токен бота (`/file/bot<TOKEN>/…`). Отдать её браузеру — значит
 * отдать токен. Поэтому скачиваем сами и отдаём картинку.
 *
 * Кеш в памяти процесса: админка на одном экране просит десятки
 * аватаров, а каждый — это три запроса в Telegram. На serverless кеш
 * живёт, пока жив инстанс, — этого хватает: цель не «ноль запросов», а
 * не бить Telegram на каждой перерисовке.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Сутки: аватар меняют редко, а браузер кеширует столько же. */
export const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;
/** Потолок записей — память процесса не резиновая, пользователей больше. */
export const AVATAR_CACHE_MAX = 500;
/** Плашка 20 px на ретине — 40 px; 96 берём с запасом, но не оригинал. */
export const AVATAR_MIN_SIDE = 96;
/** Столько же, сколько у остальных обращений к Telegram в проекте. */
const TIMEOUT_MS = 10_000;

export interface AvatarPhoto {
  bytes: Buffer;
  type: string;
}

interface CacheEntry {
  at: number;
  /** null — «фото нет» тоже запоминаем, иначе пустые плашки бьют Telegram. */
  photo: AvatarPhoto | null;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

/**
 * Самый маленький размер не меньше `AVATAR_MIN_SIDE`, а если все меньше —
 * самый большой. Telegram отдаёт 160/320/640: оригинал тащить ради
 * кружка в 20 px незачем, а совсем мелкий размер на ретине мылит.
 */
export function pickPhotoSize(
  sizes: TelegramPhotoSize[],
): TelegramPhotoSize | null {
  if (!sizes.length) return null;
  const side = (s: TelegramPhotoSize) => Math.min(s.width, s.height);
  const sorted = [...sizes].sort((a, b) => side(a) - side(b));
  return (
    sorted.find((s) => side(s) >= AVATAR_MIN_SIDE) ?? sorted[sorted.length - 1]
  );
}

/** Ошибка, которую стоит повторить позже (сеть, 5xx, 429) — не кешируем. */
class TransientAvatarError extends Error {}

@Injectable()
export class AdminUserAvatarService {
  private readonly logger = new Logger(AdminUserAvatarService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /** Картинка или null (→ 404): нет фото, скрыто, бот не знает, не Telegram. */
  async avatar(userId: string): Promise<AvatarPhoto | null> {
    const cached = this.cache.get(userId);
    if (cached) {
      if (Date.now() - cached.at < AVATAR_TTL_MS) return cached.photo;
      this.cache.delete(userId);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    });
    // Неизвестный id не кешируем: иначе перебор случайных id вытеснил бы
    // из кеша настоящих пользователей.
    if (!user) return null;

    // dev-/fixture-пользователи (`dev-123`, `fixture-1`) — не настоящие
    // Telegram-аккаунты; спрашивать про них Telegram бессмысленно.
    if (!/^\d+$/.test(user.telegramId)) return this.remember(userId, null);

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) return null;

    try {
      return this.remember(
        userId,
        await this.fetchPhoto(token, user.telegramId),
      );
    } catch (error) {
      // Токен живёт в URL запросов — на случай, если он попал в текст
      // ошибки сети, вычищаем его до записи в лог.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `аватар ${userId} не получен: ${message.split(token).join('***')}`,
      );
      return null;
    }
  }

  private remember(userId: string, photo: AvatarPhoto | null) {
    this.cache.delete(userId);
    this.cache.set(userId, { at: Date.now(), photo });
    // Map хранит порядок вставки — первый ключ самый старый.
    while (this.cache.size > AVATAR_CACHE_MAX) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return photo;
  }

  private async fetchPhoto(
    token: string,
    telegramId: string,
  ): Promise<AvatarPhoto | null> {
    const photos = await this.call<{
      photos?: TelegramPhotoSize[][];
    }>(token, 'getUserProfilePhotos', {
      user_id: Number(telegramId),
      limit: 1,
    });
    // null — Telegram ответил отказом по существу (400: бот не знает
    // пользователя). Это такое же «фото нет», как пустой список.
    if (!photos) return null;
    const size = pickPhotoSize(photos.photos?.[0] ?? []);
    if (!size) return null;

    const file = await this.call<{ file_path?: string }>(token, 'getFile', {
      file_id: size.file_id,
    });
    if (!file?.file_path) return null;

    const res = await fetch(
      `https://api.telegram.org/file/bot${token}/${file.file_path}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) throw new TransientAvatarError(`файл: HTTP ${res.status}`);
    const header = res.headers.get('content-type') ?? '';
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      // Telegram отдаёт фото профиля jpeg'ом, но заголовок у файлового
      // сервера бывает `application/octet-stream` — тогда говорим как есть.
      type: header.startsWith('image/') ? header : 'image/jpeg',
    };
  }

  /**
   * Вызов метода Bot API. 4xx (кроме 429) → null: ответ окончательный,
   * его можно кешировать. 429/5xx → TransientAvatarError: не кешируем.
   */
  private async call<T>(
    token: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T | null> {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429 || res.status >= 500) {
      throw new TransientAvatarError(`${method}: HTTP ${res.status}`);
    }
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; result?: T };
    return json.ok ? (json.result ?? null) : null;
  }
}
