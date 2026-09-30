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
 *    сессия страницы;
 *  - ссылка на копию заявки на публикацию (`publications/<id>/video.mp4`,
 *    `PublicationService.keepOwnCopy`) или совпадающая с `videoUrl` заявки
 *    — сессия заявки (CONTRACT6 п.6: раньше такая ссылка не узнавалась,
 *    и ролик с персоной, выложенный по ссылке публикации, уходил в лот).
 *
 * Fail-closed, как витрина (`showcaseRefusal`): страница ПОЗДРАВЛЕНИЯ
 * нашлась, а её сессии нет (стёрта) — считаем, что персона может быть:
 * не узнать, есть ли на ролике лицо автора, а ошибка в эту сторону
 * продаёт человека без его согласия. Как и у витрины (CONTRACT6 п.7) —
 * только при включённом `PERSONA_ENABLED`: при выключенном ролик с
 * персоной не снять, и стёртая сессия (уборка по сроку) не должна
 * закрывать аукцион всем поздравлениям разом.
 * Ролик, перезалитый на чужой хостинг, так не узнать — это ограничение
 * записано в отчёте этапа; схема портфолио ссылки на сессию не хранит.
 */

import { pathnameFromBlobUrl } from '../../common/blob-paths';
import {
  personaEnabled,
  sessionDataUsesPersona,
} from '../../common/greeting-persona';

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

/** Id заявки из ссылки на её копию `publications/<id>/…`; иначе `null`. */
export function publicationIdFromVideoUrl(
  url: string | null | undefined,
): string | null {
  const path = pathnameFromBlobUrl(url, 'publications/');
  if (!path) return null;
  const id = path.split('/')[1];
  return id && id !== '..' ? id : null;
}

/** Минимум Prisma для проверки (структурно — ради тестов без БД). */
export interface PersonaVideoReader {
  sharedVideoPage: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { sessionId: true; projectType: true };
    }): Promise<Array<{ sessionId: string; projectType?: string | null }>>;
  };
  publicationRequest: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { sessionId: true };
    }): Promise<Array<{ sessionId: string | null }>>;
  };
  session: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { id: true; data: true };
    }): Promise<Array<{ id: string; data: unknown }>>;
  };
}

/**
 * Есть ли среди роликов по этим ссылкам ролик с персоной. Мягко удалённые
 * сессии тоже читаются: удаление сессии не делает лицо на ролике чужим.
 */
export async function videoUsesPersona(
  prisma: PersonaVideoReader,
  urls: Array<string | null | undefined>,
  enabled: boolean = personaEnabled(),
): Promise<boolean> {
  const list = urls.filter((u): u is string => !!u);
  if (!list.length) return false;
  const ids = new Set(
    list.map(sessionIdFromVideoUrl).filter((id): id is string => !!id),
  );
  const pages = await prisma.sharedVideoPage.findMany({
    where: { videoUrl: { in: list } },
    select: { sessionId: true, projectType: true },
  });
  for (const p of pages) ids.add(p.sessionId);
  const publicationIds = list
    .map(publicationIdFromVideoUrl)
    .filter((id): id is string => !!id);
  const publications = await prisma.publicationRequest.findMany({
    where: {
      OR: [
        { videoUrl: { in: list } },
        ...(publicationIds.length ? [{ id: { in: publicationIds } }] : []),
      ],
    },
    select: { sessionId: true },
  });
  for (const r of publications) if (r.sessionId) ids.add(r.sessionId);
  if (!ids.size) return false;
  const sessions = await prisma.session.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, data: true },
  });
  if (sessions.some((s) => sessionDataUsesPersona(s.data))) return true;
  // Страница поздравления без сессии — не проверить, значит «может быть».
  if (!enabled) return false;
  const found = new Set(sessions.map((s) => s.id));
  return pages.some(
    (p) => p.projectType === 'GREETING_VIDEO' && !found.has(p.sessionId),
  );
}
