/**
 * Атрибуция цели — A (ТЗ §5-тер.2, Р-41). ЧИСТАЯ функция. Без согласия
 * (Э3 — только этот режим): всё — в пределах ОДНОГО документа/SPA-сессии.
 *  - direct: встроенная заявка; или цель ≤ 30 мин после клика посетителя по
 *    кнопке помощника (link/scenario) в этом документе;
 *  - assisted: в этом документе был диалог с ≥ 1 ответом модели, не direct;
 *  - unassisted: диалога в документе не было;
 *  - unknown: сервер не может сказать (событие s2s без связи с визитом).
 * Окно атрибуции «ещё открыто» — на экране, не здесь.
 */
import { ANALYTICS_DEFAULTS } from '../../config/assist-defaults';
import type { GoalAttribution, GoalEventSource } from './goal-types';

export const DIRECT_WINDOW_MS = ANALYTICS_DEFAULTS.directWindowMs;
/** Расхождение часов iframe и сервера, которое ещё не делает клик «будущим». */
export const CLICK_CLOCK_SKEW_MS = 60_000;

export interface AttributionInput {
  source: GoalEventSource;
  occurredAt: Date;
  /** Последний клик посетителя по действию помощника в документе (iframe). */
  lastAssistClickAt: Date | null;
  /** В диалоге документа есть ответ модели (answerPath model|faq|cache). */
  conversationHasAnswer: boolean;
  conversationId: string | null;
}

export function decideAttribution(p: AttributionInput): GoalAttribution {
  // Встроенная заявка — всегда помощник своими руками (§5-тер.2 (а)).
  if (p.source === 'builtin') return 'direct';
  // Вебхук/CRM без связи с визитом (связанный режим — Э3-бис): не знаем.
  if (p.source === 's2s' || p.source === 'crm') {
    return p.conversationId ? 'assisted' : 'unknown';
  }
  // Загрузчик шлёт сам, только когда iframe этого документа не жив.
  if (p.source === 'loader') return 'unassisted';
  if (p.lastAssistClickAt) {
    const dt = p.occurredAt.getTime() - p.lastAssistClickAt.getTime();
    if (dt >= -CLICK_CLOCK_SKEW_MS && dt <= DIRECT_WINDOW_MS) return 'direct';
  }
  return p.conversationId && p.conversationHasAnswer
    ? 'assisted'
    : 'unassisted';
}
