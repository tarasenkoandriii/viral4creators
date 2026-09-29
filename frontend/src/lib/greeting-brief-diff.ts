/**
 * Что именно поменял человек в брифе — этап C ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.6.
 *
 * После старта сессии бриф уходит в `PATCH /sessions/:id/greeting-brief`
 * ТОЛЬКО изменёнными полями. Раньше форма отправляла всё целиком, и это
 * давало две ошибки (найдены ревью этапа C):
 *
 * - провайдер и качество шли в каждом запросе, и тарифная проверка
 *   запускалась даже на исправление опечатки: у того, чей тариф понизился
 *   после выбора аватара, правка текста падала с 403;
 * - язык, не выбранный в брифе, форма подставляла из интерфейса, и
 *   сессия, начатая на другом языке интерфейса, теряла собранный
 *   сценарий от любого сохранения.
 *
 * Чистая функция — ради теста без браузера (`scripts/greeting-brief-diff.test.ts`).
 */

export type BriefFields = Record<string, string | null>;

export function changedBriefFields<T extends BriefFields>(
  baseline: T,
  current: T
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(current) as Array<keyof T>) {
    if ((baseline[key] ?? null) !== (current[key] ?? null)) {
      out[key] = current[key];
    }
  }
  return out;
}

/**
 * Тело `PATCH /sessions/:id/greeting-brief`: изменённые поля — и ВСЕГДА
 * ответ о настроении, если повод «Особый».
 *
 * Почему не только изменённые: раньше сервер хранил только победивший
 * сигнал регистра, и после подъёма словами или классификатором ответа
 * человека в брифе не было — правка без `occasionRegister` получала 400
 * OTHER_MOOD_REQUIRED на исправлении опечатки в имени получателя. Теперь
 * сервер помнит ответ сам (`userOccasionRegister`, `resolveNext` в
 * `greeting-brief.service.ts`), но у брифов, поднятых до этой колонки,
 * ответ уже потерян, и человек дал его заново только на экране. Ответ
 * там есть всегда (без него кнопка погашена), так что прислать его
 * ничего не стоит, а мягче регистр от этого не станет: сервер берёт
 * строжайший из сигналов.
 */
export function sessionBriefPatch<T extends BriefFields>(
  baseline: T,
  current: T
): Partial<T> {
  const out = changedBriefFields(baseline, current);
  if (current.occasion === 'OTHER' && 'occasionRegister' in current) {
    return { ...out, occasionRegister: current.occasionRegister };
  }
  return out;
}

/**
 * «Начать» = сохранить бриф, и только если сохранение удалось — начать
 * сессию. `save` сам показывает свою ошибку и возвращает `false`; раньше
 * `start` не знал о провале и начинал сессию со СТАРОГО брифа после 400.
 */
export async function startAfterSave(
  save: () => Promise<boolean>,
  startSession: () => Promise<void>
): Promise<boolean> {
  if (!(await save())) return false;
  await startSession();
  return true;
}
