/**
 * Опубликованная карта «Админки» для плана сотрудника (заход 11, №117; ТЗ
 * §5-кватер.8–9): основной ролью тенанта (план «Админки» вообще не ходит
 * ролью assist_public — у неё к `assist_admin_*` прав нет), ТОЛЬКО версия со
 * статусом `published` и номером из строки карты. Черновик, версии на
 * проверке и сессии редактора план не видит. Кэш — 5 мин по сайту (как у
 * «Сайта»: «план в бою использует новую версию ≤ 5 мин»); публикация на
 * этом инстансе сбрасывает кэш сайта сразу.
 *
 * Изоляция К-9: здесь только таблицы `assist_admin_voice_map*` — синонимы
 * карты «Сайта» сюда не попадают ни при каком содержимом (№62).
 */
import type { SitesDb } from '../../prisma/sites-db.service';
import {
  parseVoiceMapContent,
  type VoiceMapContent,
} from '../assist-ui-core/voice-map';

export const ADMIN_VOICE_MAP_CACHE_MS = 5 * 60_000;

type Db = ReturnType<SitesDb['forAccount']>;

const cache = new Map<
  string,
  { at: number; map: { version: number; content: VoiceMapContent } | null }
>();

/** Сбросить кэш (сайт или весь — тесты). */
export function clearAdminVoiceMapCache(siteId?: string): void {
  if (siteId) cache.delete(siteId);
  else cache.clear();
}

/** Опубликованная карта «Админки» или null (нет версии — снимок + модель). */
export async function readPublishedAdminVoiceMap(
  db: Db,
  siteId: string,
  now = Date.now(),
): Promise<{ version: number; content: VoiceMapContent } | null> {
  const hit = cache.get(siteId);
  if (hit && now - hit.at < ADMIN_VOICE_MAP_CACHE_MS) return hit.map;
  const row = await db.assistAdminVoiceMap.findFirst({
    where: { siteId },
    select: { publishedVersion: true },
  });
  const v = row?.publishedVersion
    ? await db.assistAdminVoiceMapVersion.findFirst({
        where: { siteId, number: row.publishedVersion, status: 'published' },
        select: { number: true, content: true },
      })
    : null;
  // Версия — данные: разбор строгий, мусор отбрасывается.
  const map = v
    ? { version: v.number, content: parseVoiceMapContent(v.content) }
    : null;
  cache.set(siteId, { at: now, map });
  if (cache.size > 5_000) cache.delete(cache.keys().next().value as string);
  return map;
}
