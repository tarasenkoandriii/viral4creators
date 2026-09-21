/**
 * ИИ-скетч (doc/AI-SKETCH-SPEC.md) — зеркало серверных типов маршрутов
 * `/sketches`. Отдельный файл, а не секция в `types/index.ts`: скетч —
 * сквозная функция по шести разным слотам (персонаж сессии, товар, сцена,
 * персонаж и сцена бренда, товар проекта), и держать его типы рядом с
 * типами мастера значило бы тянуть их импортом в брендбук и проекты.
 *
 * Держать в синхроне с бэкендом вручную — тем же приёмом, что
 * `types/project.ts` и `billing`-типы в `types/index.ts`.
 */

/**
 * Какой именно слот подменяется (§2.1). `id` — владелец слота (сессия,
 * манифест, товар), `subId` — сам слот внутри владельца, если их там
 * несколько (персонаж, сцена). У товара сессии и товара проекта слот
 * ровно один, поэтому `subId` там не нужен.
 */
export type SketchTargetType =
  | 'session-character'
  | 'session-product'
  | 'session-scene'
  | 'brand-character'
  | 'brand-scene'
  | 'project-item'
  /** GREETING_VIDEO — референс-изображение Grok reference-to-video. */
  | 'session-greeting-reference';

export interface SketchTarget {
  type: SketchTargetType;
  id: string;
  subId?: string | null;
}

/** Нефотореалистичные стили из §5.3. «Карандаш» — по умолчанию. */
export type SketchStyle = 'pencil' | 'lineart' | 'flat' | 'watercolor';

/**
 * `from-image` — оригинал уходит в модель один раз на генерацию;
 * `from-text` — не уходит вовсе (максимальная защита для фото людей,
 * §3.2). Для текстовой замены персонажа доступен только `from-text`.
 */
export type SketchMode = 'from-image' | 'from-text';

export interface SketchOptions {
  /** Логотипы и надписи — только у товаров и сцен (§3.2, п. 3). */
  removeLogos?: boolean;
  keepColors?: boolean;
  /**
   * Как слот пойдёт в Veo/Grok (§5.5): скетч задаёт форму и позу, а
   * ролик остаётся фотореалистичным — или стилизуется под скетч.
   */
  sketchRendering?: 'realistic' | 'stylized';
}

export interface SketchView {
  id: string;
  /**
   * `candidate` — сгенерирован, но не применён (живёт до TTL);
   * `applied` — активный вариант слота; `superseded` — оригинал
   * заменили новой загрузкой; `refused` — модель отказала по
   * безопасности (попытка оплачена, §3.2, п. 6).
   */
  status:
    | 'candidate'
    | 'applied'
    | 'superseded'
    | 'expired'
    | 'refused'
    | 'failed';
  mode: SketchMode;
  style: SketchStyle;
  options: SketchOptions;
  url: string | null;
  createdAt: string;
  appliedAt: string | null;
  /** Пакетный скетч — применён автоматически, без превью (§4.6). */
  auto: boolean;
}

/** Обе границы сразу (§8.2): суточная и месячная считаются отдельно. */
export interface SketchQuota {
  dayUsed: number;
  dayLimit: number;
  monthUsed: number;
  monthLimit: number;
}

/** Что реально уходит дальше из слота — после apply/revert/delete. */
export interface SketchSlotView {
  target: SketchTarget;
  variant: 'original' | 'sketch';
  url: string | null;
  sketchId: string | null;
  /** Оригинал удалён необратимо: «Вернуть оригинал» больше недоступно. */
  originalDeleted: boolean;
}

export interface SketchListView {
  items: SketchView[];
  active: SketchView | null;
  quota: SketchQuota;
}

/**
 * Денормализованная ссылка на применённый скетч внутри слота сессии
 * (зеркало `SketchRef` бэкенда). Лежит прямо в JSON сессии, чтобы
 * генерации не приходилось ходить в таблицу скетчей ради одной ссылки.
 */
export interface SketchRef {
  sketchId: string;
  url: string;
  pathname: string;
  mimeType: string;
  style: SketchStyle;
  sketchRendering: 'realistic' | 'stylized';
  appliedAt: string;
}
