/**
 * Кэш озвучки ответов «Сайта» (Э5, ТЗ §4.10 «кэш аудио по хешу текста+голоса
 * на 7 дней»; аудит 1.2 К-9/У-16 — только режим «Сайт», область — сайт).
 *
 * Ключ — `site:` + SHA-256(голос, язык, модель, текст): область
 * (siteId) — отдельной колонкой с уникальностью (siteId, key), так что
 * запись одного сайта не отдаётся другому даже при совпадении текста.
 * Режима «Админка» здесь нет: её ответы не кэшируются вовсе (ТЗ §4.10).
 *
 * Под assist_public: SELECT звука по ключу и INSERT без цели конфликта
 * (`ON CONFLICT DO NOTHING` — две параллельные озвучки одного ответа:
 * вторая вставка тихо не пишется). Просроченное удаляет крон
 * assist-retention основной ролью (ChatRetention).
 */
import { createHash, randomUUID } from 'crypto';
import { VOICE_DEFAULTS } from '../voice-config';

const TABLE = '"sites"."assist_site_tts_cache"';

export interface TtsCacheDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export function ttsCacheKey(p: {
  voice: string;
  lang: string;
  model: string;
  text: string;
}): string {
  return (
    'site:' +
    createHash('sha256')
      .update(
        `${p.model}\u0000${p.voice}\u0000${p.lang}\u0000${p.text}`,
        'utf8',
      )
      .digest('base64url')
  );
}

export async function readTtsCache(
  db: TtsCacheDb,
  siteId: string,
  key: string,
  now: Date,
): Promise<{ mime: string; audio: Buffer } | null> {
  const rows = await db.$queryRawUnsafe<
    Array<{ mime: string; audio: Buffer | Uint8Array }>
  >(
    `SELECT "mime", "audio" FROM ${TABLE}
      WHERE "siteId" = $1 AND "key" = $2 AND "expiresAt" > $3`,
    siteId,
    key,
    now,
  );
  const r = rows[0];
  return r ? { mime: r.mime, audio: Buffer.from(r.audio) } : null;
}

export async function writeTtsCache(
  db: TtsCacheDb,
  p: {
    siteId: string;
    key: string;
    voice: string;
    lang: string;
    mime: string;
    audio: Buffer;
    characters: number;
    now: Date;
  },
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO ${TABLE} ("id", "siteId", "key", "voice", "lang", "mime", "audio", "characters", "expiresAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
    randomUUID(),
    p.siteId,
    p.key,
    p.voice,
    p.lang,
    p.mime,
    p.audio,
    p.characters,
    new Date(p.now.getTime() + VOICE_DEFAULTS.ttsCacheTtlMs),
  );
}
