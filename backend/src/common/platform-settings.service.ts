/**
 * PlatformSettingsService — общий key-value для настроек, которые
 * оператор меняет из админки БЕЗ редеплоя (см. `PlatformSetting` в
 * schema.prisma). Первый и пока единственный потребитель —
 * «Озвучка по умолчанию» (`../modules/tts/default-tts-provider.ts`).
 *
 * Короткий in-memory кеш (`CACHE_TTL_MS`) — `get()` вызывается на
 * каждый синтез (`tts-provider-registry.service.ts`), а это горячий
 * путь постобработки; без кеша каждый ролик получал бы лишний
 * SELECT ради значения, которое меняется на памяти месяца в лучшем
 * случае раз в несколько дней. Кеш — per-instance (обычная переменная
 * процесса), не в БД: на Vercel это означает, что смена в админке
 * долетает до КОНКРЕТНОГО тёплого инстанса не мгновенно, а в течение
 * `CACHE_TTL_MS` — приемлемая задержка для настройки такого рода
 * (сравните с текущим поведением ДО этого сервиса: `TTS_PROVIDER`
 * читался из `process.env` один раз при холодном старте и не менялся
 * вовсе без передеплоя).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

@Injectable()
export class PlatformSettingsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /** Текущее значение, или `null`, если ключ не задавался ни разу. */
  async get(key: string): Promise<string | null> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await this.prisma.platformSetting.findUnique({
      where: { key },
    });
    const value = row?.value ?? null;
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /** `updatedBy` — Telegram/internal User.id оператора, для админского аудита. */
  async set(key: string, value: string, updatedBy?: string): Promise<void> {
    await this.prisma.platformSetting.upsert({
      where: { key },
      create: { key, value, updatedBy },
      update: { value, updatedBy },
    });
    // Обновляем кеш сразу же — тот же процесс, который только что
    // записал значение, не должен полминуты читать своё же старое.
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
