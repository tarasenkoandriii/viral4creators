/**
 * AI Publisher — «эффект стирания» заявки (P-D §15.3, аудит P-E S1-4;
 * Р-PUB-Z2-3): одно правило для штатного стирания `LeadsService.erase` и
 * для восстановления P-E (`RestoreService.transfer`), чтобы изменение
 * стирания не расходилось с восстановлением.
 *
 * Эффект стирания заявки:
 *  - контакт (`pub_lead_contacts`) удаляется;
 *  - заметки решений (`pub_lead_decisions.noteEnc`) — `null`;
 *  - `erasedAt` ставится, `requestHash` — обезличенный `erasedRequestHash(id)`
 *    (в том же UPDATE; триггер `pub_leads_guard` иначе смену не пропустит);
 *  - заметка проспекта (`pub_prospects.noteEnc`) — `null`, если после
 *    стирания у проспекта не осталось заявок с неудалённым контактом.
 *
 * Чистый модуль (без базы и Nest).
 */
import { createHash } from 'crypto';

/**
 * Обезличенный `requestHash` удалённой заявки (аудит P-D S3-9): sha256 от id,
 * без данных тела; с HMAC прежнего тела не совпадает (повтор той же отправки
 * после удаления — 409, а не прежний ответ).
 */
export function erasedRequestHash(leadId: string): string {
  return createHash('sha256').update(`erased\n${leadId}`).digest('hex');
}

/** Колонки заявки, которые меняет стирание (в одном UPDATE). */
export function erasedLeadColumns(
  leadId: string,
  erasedAt: Date,
): { erasedAt: Date; requestHash: string } {
  return { erasedAt, requestHash: erasedRequestHash(leadId) };
}

/** Заявка области стирания: продукт (P-D) или копия (P-E). */
export interface EraseLeadRef {
  id: string;
  prospectId: string | null;
  /** Уже удалена ДО текущего стирания. */
  erased: boolean;
}

export interface LeadEraseEffect {
  /** Заявки, у которых удаляется контакт и обнуляются заметки решений. */
  leads: ReadonlySet<string>;
  /** Проспекты, чья заметка стирается (живых заявок не осталось). */
  prospectNotes: ReadonlySet<string>;
}

/**
 * Эффект стирания `erasing` в области `leads` (все заявки затронутых
 * проспектов — иначе правило заметки проспекта недоопределено). Заявка из
 * `erasing`, которой нет в `leads`, тоже стирается (без проспекта).
 */
export function leadEraseEffect(
  leads: readonly EraseLeadRef[],
  erasing: ReadonlySet<string>,
): LeadEraseEffect {
  const byProspect = new Map<string, EraseLeadRef[]>();
  for (const l of leads) {
    if (!l.prospectId) continue;
    const list = byProspect.get(l.prospectId) ?? [];
    list.push(l);
    byProspect.set(l.prospectId, list);
  }
  const prospectNotes = new Set<string>();
  for (const [pid, ls] of byProspect) {
    if (!ls.some((l) => erasing.has(l.id))) continue;
    if (ls.every((l) => l.erased || erasing.has(l.id))) prospectNotes.add(pid);
  }
  return { leads: new Set(erasing), prospectNotes };
}
