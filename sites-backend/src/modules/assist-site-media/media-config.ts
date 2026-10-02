/**
 * Числа Э6 «видео-ответы и показать на экране» (ТЗ помощника §4.9, §4.11,
 * §4.12) — чистые, без env (env — config/media-env.ts).
 */
export const MEDIA_DEFAULTS = {
  /** Роликов сайта в промпт (V1…Vn) — модели хватает названий. */
  promptVideos: 8,
  /** Элементов карты страницы в промпт (E1…En). */
  promptElements: 30,
  /** Срок подписанной ссылки на ролик (§4.11 «подписанная ссылка с TTL»). */
  videoLinkTtlSec: 10 * 60,
  /** Ссылок на ролик посетителю в минуту (и втрое — на IP+сайт). */
  videoLinksPerVisitorPerMinute: 10,
  videoLinksPerIpPerMinute: 30,
  /** Сигналов «элемент не найден» посетителю в минуту (и на IP+сайт). */
  highlightMissPerVisitorPerMinute: 10,
  highlightMissPerIpPerMinute: 30,
  /**
   * Роликов в одной синхронизации сайта от генератора — потолок ЧИСЛА.
   * Тело внутреннего API ≤ 8 КБ (INTERNAL_SITES_BODY_LIMIT, app.setup.ts),
   * а ролик с длинным кириллическим названием (120 символов — 240 байт
   * UTF-8) и адресом Blob — до ~600 байт: 15 таких (~9 КБ) в тело НЕ
   * влезают. Поэтому генератор режет набор ещё и бюджетом байт
   * (`SYNC_BODY_BUDGET` в backend `client-site-media.service.ts`), отсекая
   * самые старые; шлёт последние по времени.
   */
  syncVideosMax: 15,
  /** Подпись ролика (название черновика обучалки). */
  titleMax: 120,
} as const;

/** Ссылка на ролик в промпте и в действии модели: `V1`…`V8`. */
export const VIDEO_REF_RE = /^V([1-9]\d?)$/;
/** Элемент карты в промпте и в действии модели: `E1`…`E30`. */
export const ELEMENT_REF_RE = /^E([1-9]\d?)$/;
