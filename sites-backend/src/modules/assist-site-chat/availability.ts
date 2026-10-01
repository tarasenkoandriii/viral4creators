/**
 * Рубильники и лимиты посетителя (ТЗ §4.13 п.3, п.5, п.6; §4.5 «Посетитель»)
 * — W3. Ответ виджета при выключении — форма заявки, не ошибка.
 *
 * Порядок причин — от «шире» к «уже»: платформа → оператор → владелец →
 * помощник сайта выключен → вид не опубликован → лимит посетителя.
 * `suspicious` (§4.13 п.5) — не отказ: ответы только из FAQ/кэша/шаблона.
 */
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';

export type ChatAvailability =
  | { ok: true; slowdownMs: number; suspicious: boolean }
  | {
      ok: false;
      reason:
        | 'platform_off'
        | 'operator_blocked'
        | 'owner_paused'
        | 'not_enabled'
        | 'not_published'
        | 'visitor_limit';
    };

/** Одинаковых вопросов с разных visitorId одного ipHash — «бот» (§4.13 п.5). */
export const SAME_QUESTION_SUSPICIOUS = 3;

/** Чистое решение по строке сайта, env и счётчикам посетителя. */
export function chatAvailability(p: {
  platformEnabled: boolean;
  site: {
    enabled: boolean;
    chatPaused: boolean;
    operatorBlockedAt: Date | null;
    widgetVersion: number;
  };
  visitor: {
    sessionMessages: number;
    dayMessages: number;
    tokenAgeMs: number;
  };
  /** Одинаковые вопросы с разных visitorId одного ipHash за окно (§4.13 п.5). */
  sameQuestionOtherVisitors: number;
  random?: () => number;
}): ChatAvailability {
  const d = WIDGET_DEFAULTS;
  if (!p.platformEnabled) return { ok: false, reason: 'platform_off' };
  if (p.site.operatorBlockedAt) {
    return { ok: false, reason: 'operator_blocked' };
  }
  if (p.site.chatPaused) return { ok: false, reason: 'owner_paused' };
  if (!p.site.enabled) return { ok: false, reason: 'not_enabled' };
  if (!(p.site.widgetVersion > 0)) {
    return { ok: false, reason: 'not_published' };
  }
  if (
    p.visitor.sessionMessages >= d.visitorMessagesPerSession ||
    p.visitor.dayMessages >= d.visitorMessagesPerDay
  ) {
    return { ok: false, reason: 'visitor_limit' };
  }
  const suspicious =
    (p.visitor.tokenAgeMs >= 0 &&
      p.visitor.tokenAgeMs < d.botTokenAgeMs &&
      p.visitor.sessionMessages === 0) ||
    p.sameQuestionOtherVisitors >= SAME_QUESTION_SUSPICIOUS;
  let slowdownMs = 0;
  if (p.visitor.sessionMessages >= d.slowdownAfterMessages) {
    const r = Math.min(Math.max((p.random ?? Math.random)(), 0), 1);
    slowdownMs = Math.round(
      d.slowdownMinMs + r * (d.slowdownMaxMs - d.slowdownMinMs),
    );
  }
  return { ok: true, slowdownMs, suspicious };
}
