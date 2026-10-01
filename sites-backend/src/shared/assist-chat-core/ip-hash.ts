// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/ip-hash.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Хеш IP посетителя с суточной солью (ТЗ лендинга §8): `sha256(ip:день:секрет)`.
 * Сырой IP не хранится нигде — только этот хеш. Соль дневная: внутри суток
 * поведение одного посетителя сопоставимо, между сутками — нет.
 *
 * Секрет — параметр, а не чтение env здесь: у лендинга он свой
 * (`modules/assistant/ip-hash.ts`), у Помощника к нему добавится соль
 * сайта (ТЗ помощника §6.4). Чистый модуль (см. шапку `protocol.ts`).
 */
import { createHash } from 'crypto';

/** `now` — для тестов; день берётся по UTC. */
export function hashIpWithDailySalt(
  ip: string,
  secret: string,
  now: Date = new Date(),
): string {
  const dailySalt = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return createHash('sha256')
    .update(`${ip}:${dailySalt}:${secret}`)
    .digest('hex');
}
