/**
 * Голосовая карта для публичного кода «Сайта» (Э6-тер, ТЗ §5-кватер.8–9) —
 * под ролью `assist_public` и ТОЛЬКО через представление миграции
 * `_assist_visual_editor` (`assist_site_voice_map_published`): содержимое
 * опубликованной версии. Черновик, версии на проверке, журнал и сессии
 * редактора роли не видны. Ровно этот SQL сверяет
 * `prisma/assist-public-role.spec.ts`.
 *
 * Имена и синонимы нужны серверу (прямой путь, блок `<voice_map>`), в
 * ответы `/widget/v1/*` и в загрузчик они не уходят (§5-кватер.8 п.1).
 * Кэш — 5 мин по версии (§5-кватер.9 «план в бою использует новую версию
 * ≤ 5 мин»).
 */
import {
  parseVoiceMapContent,
  type VoiceMapContent,
} from '../../assist-ui-core/voice-map';
import type { PlanDb } from './plan-store';

const PUBLISHED = '"sites"."assist_site_voice_map_published"';

export const VOICE_MAP_CACHE_MS = 5 * 60_000;

interface Row {
  version: number;
  content: unknown;
}

const cache = new Map<
  string,
  { at: number; map: { version: number; content: VoiceMapContent } | null }
>();

/** Сбросить кэш (тесты; публикация на другом инстансе — по сроку). */
export function clearVoiceMapCache(): void {
  cache.clear();
}

/** Опубликованная карта сайта или null (нет версии — снимок + модель, В-53). */
export async function readPublishedVoiceMap(
  db: PlanDb,
  siteId: string,
  now = Date.now(),
): Promise<{ version: number; content: VoiceMapContent } | null> {
  const hit = cache.get(siteId);
  if (hit && now - hit.at < VOICE_MAP_CACHE_MS) return hit.map;
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT "version", "content" FROM ${PUBLISHED} WHERE "siteId" = $1 LIMIT 1`,
    siteId,
  );
  const map = rows[0]
    ? {
        version: rows[0].version,
        // Версия — данные: разбор строгий, мусор отбрасывается.
        content: parseVoiceMapContent(rows[0].content),
      }
    : null;
  cache.set(siteId, { at: now, map });
  if (cache.size > 5_000) cache.delete(cache.keys().next().value as string);
  return map;
}
