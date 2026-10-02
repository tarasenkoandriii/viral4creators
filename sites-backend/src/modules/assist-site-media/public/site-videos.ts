/**
 * Ролики обучалки в ответах виджета — Э6 (ТЗ помощника §4.9 `video`,
 * §4.11). Под ролью `assist_public` (AssistPublicDb, колоночный GRANT
 * миграции …_assist_video_highlight).
 *
 * ТРИ БАРЬЕРА против ролика чужого сайта (по образцу лендинга:
 * `backend/src/modules/assistant/assistant.service.ts` —
 * `availableVideoSubjectKeys` / `resolveVideoActions` с
 * `clientSiteDraftId: null`; барьер лендинга не меняется):
 *  1. `promptVideos` — модель видит ТОЛЬКО ролики этого сайта: `siteId`
 *     сайта запроса, включённые владельцем, не за логином;
 *  2. проверка действия модели (assist-site-chat/answer-checks.ts) —
 *     `V#` только из списка, выданного этим запросом; id ролика берёт
 *     сервер из списка, не из текста модели;
 *  3. `playableVideo` — на клике и на редиректе ролик ищется заново по
 *     (id, siteId посетителя, enabled, requiresLogin = false): отозванный,
 *     выключенный или чужой ролик не открывается, даже если ссылка или
 *     кэш ответа его помнят.
 * Плюс «привязка»: строки пишет только внутренний API генератора после
 * проверки членства хозяина черновика в кабинете сайта (internal-sites).
 */
import { assistPlanAllows, isAssistPlanId } from '../../assist-billing/plans';
import type { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import { isAllowedVideoUrl } from '../../../config/media-env';
import { MEDIA_DEFAULTS } from '../media-config';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface PromptVideo {
  /** `V1`…: так ролик называется в промпте и в действии модели. */
  ref: string;
  id: string;
  title: string;
  locale: string;
  durationSec: number | null;
}

type VideoDb = Pick<AssistPublicDb, 'assistSiteVideo'>;

/** Видео в ответах — возможность тарифа (`ASSIST_PLANS.video`, Business+). */
export function videoAllowedByPlan(planId: string | null): boolean {
  return isAssistPlanId(planId) && assistPlanAllows(planId, 'video');
}

/** Барьер 1: ролики ЭТОГО сайта, которые можно предложить посетителю. */
export async function promptVideos(
  db: VideoDb,
  siteId: string,
): Promise<PromptVideo[]> {
  const rows = await db.assistSiteVideo.findMany({
    where: { siteId, enabled: true, requiresLogin: false },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
    take: MEDIA_DEFAULTS.promptVideos,
    select: { id: true, title: true, locale: true, durationMs: true },
  });
  return rows.map((r, i) => ({
    ref: `V${i + 1}`,
    id: r.id,
    title: r.title,
    locale: r.locale,
    durationSec:
      typeof r.durationMs === 'number' ? Math.round(r.durationMs / 1000) : null,
  }));
}

/** Барьер 3: ролик для ссылки и редиректа — заново из базы по сайту. */
export async function playableVideo(
  db: VideoDb,
  siteId: string,
  videoId: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ id: string; title: string; url: string } | null> {
  if (typeof videoId !== 'string' || !ID.test(videoId)) return null;
  const row = await db.assistSiteVideo.findFirst({
    where: { id: videoId, siteId, enabled: true, requiresLogin: false },
    select: { id: true, title: true, url: true },
  });
  if (!row || !isAllowedVideoUrl(row.url, env)) return null;
  return row;
}
