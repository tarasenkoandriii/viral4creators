// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/forbidden-promises.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Стоп-фразы консультанта ГЕНЕРАТОРА (ТЗ лендинга §5.5) — лендинг
 * (`modules/assistant`) и гид мастера (`modules/wizard-guide`): фразы,
 * которых консультанту в принципе не следует говорить. Признак того, что
 * модель нарушила §5.1 «не выдумывать возможностей», а не доказательство
 * конкретной лжи; ответ не блокируется — только флаг для ревью (§10).
 *
 * Здесь, а не в `modules/assistant`, с аудита Ш5 (хвост A14): гид мастера
 * импортировал пост-фильтр из чужого модуля. У помощника клиентских
 * сайтов список свой (`assist-knowledge-core/answer/sanitize.ts`
 * `FORBIDDEN_PROMISES` в sites-backend) — поэтому имя списка другое, а
 * механика (`containsAnyPhrase`) общая. Чистый модуль (см. шапку
 * `protocol.ts`).
 */
import { containsAnyPhrase } from './post-filter';

/** Короткий ручной список, в нижнем регистре. */
export const GENERATOR_FORBIDDEN_PROMISES: readonly string[] = [
  'безлимит',
  'бесплатно навсегда',
  'гарантируем просмотры',
  'unlimited',
  'guaranteed views',
  'free forever',
];

/** true — ответ стоит показать оператору на ревью (§10), не блокирует отправку. */
export function containsForbiddenPromise(
  text: string,
  phrases: readonly string[] = GENERATOR_FORBIDDEN_PROMISES,
): boolean {
  return containsAnyPhrase(text, phrases);
}
