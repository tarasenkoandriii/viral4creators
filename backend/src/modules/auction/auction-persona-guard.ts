/**
 * Запрет продажи лица и голоса автора на аукционе (этап G ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §4.7, Т-8).
 *
 * Аукцион продаёт связку «видео + бренд-бук» и закрепляет бренд-бук за
 * покупателем (`BrandManifest.isLocked`, `auction-payment.service.ts`).
 * Личный бренд-бук и ролик с персоной такой сделкой уйти не могут: это
 * лицо и голос живого человека, а не стиль серии.
 *
 * Работа портфолио — свободная ссылка на ролик (`PortfolioItem.videoUrl`),
 * связи с сессией в схеме нет. Поэтому ролик узнаётся по тому, что мы о
 * нём знаем сами:
 *  - ссылка на НАШ файл под `sessions/<id>/…` — сессия по пути;
 *  - ссылка, совпадающая с опубликованной страницей автора
 *    (`SharedVideoPage.videoUrl`, в том числе собственная копия файла) —
 *    сессия страницы.
 * Ролик, перезалитый на чужой хостинг, так не узнать — это ограничение
 * записано в отчёте этапа; схема портфолио ссылки на сессию не хранит.
 */

import { pathnameFromBlobUrl } from '../../common/blob-paths';
import { sessionDataUsesPersona } from '../../common/greeting-persona';

export const PERSONAL_MANIFEST_NOT_FOR_SALE =
  'Личный бренд-бук не продаётся на аукционе: в нём ваше лицо и голос.';
export const PERSONA_VIDEO_NOT_FOR_SALE =
  'Ролик с вашей персоной («Я в кадре») не продаётся на аукционе: лицо и голос человека не передаются покупателю.';

/** Id сессии из ссылки на наш файл `sessions/<id>/…`; иначе `null`. */
export function sessionIdFromVideoUrl(
  url: string | null | undefined,
): string | null {
  const path = pathnameFromBlobUrl(url, 'sessions/');
  if (!path) return null;
  const id = path.split('/')[1];
  return id && id !== '..' ? id : null;
}

/** Минимум Prisma для проверки (структурно — ради тестов без БД). */
export interface PersonaVideoReader {
  sharedVideoPage: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { sessionId: true };
    }): Promise<Array<{ sessionId: string }>>;
  };
  session: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { data: true };
    }): Promise<Array<{ data: unknown }>>;
  };
}

/**
 * Есть ли среди роликов по этим ссылкам ролик с персоной. Мягко удалённые
 * сессии тоже читаются: удаление сессии не делает лицо на ролике чужим.
 */
export async function videoUsesPersona(
  prisma: PersonaVideoReader,
  urls: Array<string | null | undefined>,
): Promise<boolean> {
  const list = urls.filter((u): u is string => !!u);
  if (!list.length) return false;
  const ids = new Set(
    list.map(sessionIdFromVideoUrl).filter((id): id is string => !!id),
  );
  const pages = await prisma.sharedVideoPage.findMany({
    where: { videoUrl: { in: list } },
    select: { sessionId: true },
  });
  for (const p of pages) ids.add(p.sessionId);
  if (!ids.size) return false;
  const sessions = await prisma.session.findMany({
    where: { id: { in: [...ids] } },
    select: { data: true },
  });
  return sessions.some((s) => sessionDataUsesPersona(s.data));
}
