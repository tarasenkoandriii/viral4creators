/**
 * Отбор кандидатов в черновики блога (doc/TODO.md §II.3: "суточный крон
 * ищет новые ролики с высокой динамикой просмотров"). Чистая функция —
 * сама HTTP/БД-обвязка (BlogGenerationService) ей не нужна, поэтому она
 * тестируется отдельно, без Prisma/YouTube API.
 */
import { YoutubeSearchResultView } from '../youtube-search/youtube-search.types';

export interface BlogCandidateFilterOptions {
  /** videoId, уже заведённые как BlogPost (TODO §II.3: ролик не заводится дважды). */
  existingVideoIds: ReadonlySet<string>;
  /** "Высокая динамика просмотров" — порог, не любой найденный ролик. */
  minViewCount: number;
  /** Сколько кандидатов взять максимум (после сортировки по просмотрам). */
  limit: number;
}

/**
 * Убирает уже заведённые ролики и те, что не набрали порог просмотров,
 * затем сортирует по просмотрам по убыванию (то, что "цепляет" сильнее
 * всего прямо сейчас, — TODO §II.3) и берёт верхние `limit`.
 */
export function selectBlogCandidates(
  results: readonly YoutubeSearchResultView[],
  opts: BlogCandidateFilterOptions,
): YoutubeSearchResultView[] {
  return results
    .filter((r) => !opts.existingVideoIds.has(r.videoId))
    .filter((r) => (r.viewCount ?? 0) >= opts.minViewCount)
    .slice() // sort() мутирует — исходный массив вызывающего не трогаем
    .sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))
    .slice(0, Math.max(0, opts.limit));
}
