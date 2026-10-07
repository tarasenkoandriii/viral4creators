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

/** Первичный язык метки (`uk`, `en-US` → `en`) или null. */
function primaryLang(v: string | null | undefined): string | null {
  const m = typeof v === 'string' ? /^([a-z]{2})(?:[-_]|$)/i.exec(v) : null;
  return m ? m[1].toLowerCase() : null;
}

/**
 * Ш5(5): порядок языков роликов для посетителя — язык ОТВЕТА (язык
 * вопроса, `answerLangOf`), затем язык интерфейса виджета (`uiLang`), без
 * повторов и мусора.
 */
export function videoLangPrefs(
  answerLang: string | null | undefined,
  uiLang?: string | null,
): string[] {
  const out: string[] = [];
  for (const l of [answerLang, uiLang]) {
    const p = primaryLang(l);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Барьер 1: ролики ЭТОГО сайта, которые можно предложить посетителю.
 *
 * Ш5(5): многоязычный тенант (генератор снимает до 5 языков на шаг) — в
 * промпт (≤ `promptVideos`) СНАЧАЛА ролики на языках `prefer` (по порядку),
 * затем остальные; внутри группы — стабильно (название, id). Читаются все
 * доступные ролики сайта: строк не больше потолка синхронизации
 * (`syncVideosMax` — набор генератора заменяется целиком), поля короткие, —
 * один запрос, порядок — в памяти; без `prefer` — прежний порядок.
 */
export async function promptVideos(
  db: VideoDb,
  siteId: string,
  prefer: readonly string[] = [],
): Promise<PromptVideo[]> {
  const rows = await db.assistSiteVideo.findMany({
    where: { siteId, enabled: true, requiresLogin: false },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
    take: MEDIA_DEFAULTS.syncVideosMax,
    select: { id: true, title: true, locale: true, durationMs: true },
  });
  const langs = prefer
    .map((l) => primaryLang(l))
    .filter((l): l is string => !!l);
  const rank = (locale: string) => {
    const i = langs.indexOf(primaryLang(locale) ?? '');
    return i < 0 ? langs.length : i;
  };
  // Array.prototype.sort стабильна (ES2019): внутри языка — порядок базы.
  const ordered = langs.length
    ? [...rows].sort((a, b) => rank(a.locale) - rank(b.locale))
    : rows;
  return ordered.slice(0, MEDIA_DEFAULTS.promptVideos).map((r, i) => ({
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
