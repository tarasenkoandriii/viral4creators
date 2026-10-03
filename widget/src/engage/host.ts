/**
 * Стык загрузчика и ленивого чанка `engage.js` (Э3, интеграция): ТОЛЬКО
 * типы — в сборку загрузчика отсюда не попадает ни байта.
 *
 * Почему чанк: триггеры, пузырь и детекторы целей не помещались в бюджет
 * загрузчика 12 КБ gzip (приёмка ТЗ §4.12 — бюджет не поднимается).
 * Загрузчик держит только лёгкие слушатели: клик/отправку формы, путь
 * документа и `V4CAssist('goal')` он складывает в очередь `EngEvent`, пока
 * чанк не загружен, — цели, случившиеся до загрузки (url «спасибо», клик по
 * tel:), не теряются: чанк разбирает очередь первым делом.
 */
import type { natives } from '../loader/natives';
import type { WidgetUi } from '../loader/ui';
import type { PublicConfig, UiLang } from '../shared/config';
import type { ParentMessage } from '../shared/protocol';

export type GoalMsg = Extract<ParentMessage, { type: 'goal' }>;

/** Событие страницы, пойманное загрузчиком (путь — на момент события). */
export type EngEvent =
  /** клик: элемент, href ближайшей ссылки, путь */
  | ['c', Element, string, string]
  /** отправка формы, НЕ отменённая сайтом: форма, submitter, путь */
  | ['s', Element, Element | null, string]
  /** `V4CAssist('goal', key, {…})` — аргументы вызова */
  | ['g', unknown[]]
  /** путь документа: старт и каждый SPA-переход */
  | ['r', string];

/** Что загрузчик отдаёт чанку (сам объект Loader). */
export interface EngageHost {
  readonly N: typeof natives;
  readonly cfg: PublicConfig;
  readonly ui: WidgetUi | null;
  readonly lang: UiLang;
  readonly t0: number;
  /** Путь предыдущей страницы того же origin (referrer) — для `fromPathMask`. */
  readonly prevPath: string;
  /** navigator.webdriver → без аналитики (§5-тер.1). */
  readonly analytics: boolean;
  readonly hidden: boolean;
  readonly destroyed: boolean;
  /** Визит: показано сигналов / посетитель закрыл (хранится в значении `ui`). */
  shown: number;
  stop: boolean;
  /** Время последнего SPA-перехода (триггер url_match). */
  routeAt: number;
  allowed(): boolean;
  isInline(): boolean;
  writeUi(): void;
  count(kind: string, key?: string | null): void;
  /** Цель → живой iframe (direct/assisted) или маяк (unassisted) + `on('goal')`. */
  sendGoal(m: GoalMsg): void;
  open(): void;
  post(m: ParentMessage): void;
  later(fn: () => void, ms: number): void;
  readonly cleanups: Array<() => void>;
  // ── Э3-бис: стык с чанком ana.js (связанный режим по согласию) ──
  /** Origin виджета (API `/widget/v1/*`) и ключ сайта. */
  readonly origin: string;
  readonly pk: string;
  /** Путь ленивого чанка с учётом выпуска сайта. */
  chunk(p: string): string;
  /** Тот же вход, что `V4CAssist(...)` (hide/show/on). */
  call(args: unknown[]): void;
}

/** Э3-бис: чанк ana.js — вызовы consent/group/ref страницы. */
export interface AnaApi {
  call(args: unknown[]): void;
}
export type AnaStart = (h: EngageHost, queue: unknown[][]) => AnaApi;

/** Что чанк возвращает загрузчику. */
export interface EngageApi {
  ev(e: EngEvent): void;
  unbubble(): void;
}

export type EngageStart = (h: EngageHost) => EngageApi;
