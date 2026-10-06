/**
 * Подсказки распознаванию голоса посетителя «Сайта» — `context.terms`
 * Soniox (Э6-бис-хвост (3)): имена и фразы ОПУБЛИКОВАННЫХ мемо сайта, имена
 * целей и термины ОПУБЛИКОВАННОЙ голосовой карты. Отбор, потолки и
 * проверка на ПД — `assist-ui-core/stt-terms.ts`.
 *
 * Изоляция:
 *  - роль `assist_public` и ТОЛЬКО представления опубликованного
 *    (`assist_site_memo_published`, `assist_site_voice_map_published`):
 *    черновики, предложения ИИ (`suggested` — в версию не попадает), версии
 *    на проверке и всё «Админки» сюда не доходят — ни кодом (правила графа
 *    site↛admin, `memo-public-views`, `voice-map-public-views`), ни правами
 *    роли (миграции `_assist_chains_memo`, `_assist_visual_editor`);
 *  - термины — только провайдеру распознавания в теле запроса; в ответы
 *    `/widget/v1/*`, загрузчик и логи не уходят (в лог — только число).
 *
 * Кэш — на сайт по ВЕРСИЯМ: подпись = (мемо, версия)… + версия карты.
 * Свежая запись (30 с) отдаётся без базы; дальше — лёгкий запрос версий, и
 * только при новой публикации — чтение содержимого. Отказ базы — прежние
 * термины или пусто: подсказка не должна ломать распознавание.
 */
import { buildSttTerms } from '../../assist-ui-core/stt-terms';
import {
  parseVoiceMapContent,
  VOICE_MAP_LANGS,
} from '../../assist-ui-core/voice-map';
import { MEMO_LANGS } from '../../assist-ui-core/memo';
import { readPublishedMemos } from '../../assist-site-voice-control/public/memo-store';

const MEMOS = '"sites"."assist_site_memo_published"';
const MAP = '"sites"."assist_site_voice_map_published"';

/** Любой клиент с сырым SQL (AssistPublicDb). */
export interface SttTermsDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export const STT_TERMS_CACHE = {
  /** Без похода в базу — столько после последней сверки версий. */
  freshMs: 30_000,
  maxSites: 5_000,
} as const;

interface Entry {
  at: number;
  sig: string;
  terms: string[];
}

const cache = new Map<string, Entry>();

/** Сбросить кэш (тесты). */
export function clearSiteSttTermsCache(): void {
  cache.clear();
}

/** SQL подписи — ровно его сверяет `stt-terms.db.spec.ts` под ролью. */
export const STT_TERMS_SQL = {
  memoVersions: `SELECT "memoId", "version" FROM ${MEMOS} WHERE "siteId" = $1 ORDER BY "number" ASC LIMIT 200`,
  mapVersion: `SELECT "version" FROM ${MAP} WHERE "siteId" = $1 LIMIT 1`,
  mapContent: `SELECT "version", "content" FROM ${MAP} WHERE "siteId" = $1 LIMIT 1`,
} as const;

async function signature(db: SttTermsDb, siteId: string): Promise<string> {
  const [memos, map] = await Promise.all([
    db.$queryRawUnsafe<Array<{ memoId: string; version: number }>>(
      STT_TERMS_SQL.memoVersions,
      siteId,
    ),
    db.$queryRawUnsafe<Array<{ version: number }>>(
      STT_TERMS_SQL.mapVersion,
      siteId,
    ),
  ]);
  return `m:${memos.map((r) => `${r.memoId}@${r.version}`).join(',')}|v:${map[0]?.version ?? 0}`;
}

async function collect(db: SttTermsDb, siteId: string): Promise<string[]> {
  const [memos, mapRows] = await Promise.all([
    readPublishedMemos(db, siteId),
    db.$queryRawUnsafe<Array<{ version: number; content: unknown }>>(
      STT_TERMS_SQL.mapContent,
      siteId,
    ),
  ]);
  // Версия — данные: разбор строгий (мусор и неизвестное отброшены).
  const map = mapRows[0] ? parseVoiceMapContent(mapRows[0].content) : null;
  const targets = (map?.targets ?? []).filter(
    (t) => t.status === 'active' && !t.denylisted,
  );
  return buildSttTerms([
    // 1. Явные термины карты (владелец написал их ради распознавания).
    map?.terms ?? [],
    // 2. Имена мемо и целей карты — то, что посетитель назовёт.
    memos.flatMap((m) => MEMO_LANGS.map((l) => m.content.names[l])),
    targets.flatMap((t) => VOICE_MAP_LANGS.map((l) => t.names[l])),
    // 3. Фразы вызова мемо (принятые; предложений ИИ в версии нет).
    memos.flatMap((m) =>
      MEMO_LANGS.flatMap((l) => m.content.triggers[l] ?? []),
    ),
  ]);
}

/**
 * Термины распознавания для сайта. Никогда не бросает: без мемо и карты —
 * `[]` (тело Soniox без `context`).
 */
export async function siteSttTerms(
  db: SttTermsDb,
  siteId: string,
  now = Date.now(),
): Promise<string[]> {
  const hit = cache.get(siteId);
  if (hit && now - hit.at < STT_TERMS_CACHE.freshMs) return hit.terms;
  try {
    const sig = await signature(db, siteId);
    if (hit && hit.sig === sig) {
      hit.at = now;
      return hit.terms;
    }
    const terms = await collect(db, siteId);
    cache.delete(siteId);
    cache.set(siteId, { at: now, sig, terms });
    if (cache.size > STT_TERMS_CACHE.maxSites)
      cache.delete(cache.keys().next().value as string);
    return terms;
  } catch {
    return hit?.terms ?? [];
  }
}
