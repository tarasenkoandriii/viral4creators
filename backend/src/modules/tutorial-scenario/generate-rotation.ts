/**
 * generate-rotation.ts — в каком порядке ночной генератор обходит пары
 * (тема × локаль) (пункт A1 обучалок, doc/TODO.md «Расширение до пяти
 * локалей», ТЗ docs-tz/TZ-Tutorial-Video-Voiced.md «Локали: решение
 * «все пять»»).
 *
 * ## Зачем
 *
 * Бюджет генератора — `GENERATE_DEADLINE_MS` (4 мин), пара стоит
 * ≈8.5 с, то есть за ночь успевается ≈28 пар. При пяти локалях пар 75
 * (десять шагов мастера и пять тем поздравления на язык). Прежний
 * обход шёл по списку локалей в одном и том же порядке каждую ночь:
 * первые две локали переписывались каждую ночь, последние три — НИКОГДА,
 * а журнал при этом честно писал «отложено до следующего прогона».
 * Та же болезнь, что была у исполнителя с `createdAt asc`, и лечится
 * тем же приёмом: сперва те, кого дольше всех не брали в работу.
 *
 * ## Почему отметки в настройке, а не в строке сценария
 *
 * У исполнителя дата лежит в самой строке (`TutorialScenario.lastRunAt`).
 * У генерации такого поля нет, и заводить его — миграция ради одной
 * даты. Взять чужое нельзя: `lastRunAt` принадлежит исполнителю (по нему
 * сортирует он), `createdAt` не меняется после первой записи, а
 * `updatedAt` у модели нет. К тому же у пары, которую ни разу не
 * генерировали, строки нет вовсе, а ставить её в очередь нужно
 * первой. Поэтому отметки — одна JSON-карта в `PlatformSetting`
 * (`{"ru:1": "2026-09-30T02:00:00.000Z", ...}`): одна запись за прогон,
 * схема не трогается, а пропавшая или испорченная настройка
 * вырождается в прежний порядок, а не в отказ.
 */

export const GENERATE_ROTATION_SETTING_KEY = 'tutorial.scenarioGenerateStamps';

/** Ключ пары в карте. Локаль первой — так карту легче читать глазами. */
export function rotationKey(locale: string, subjectKey: string): string {
  return `${locale}:${subjectKey}`;
}

/**
 * Разбирает карту отметок. Терпимо, как `parseTutorialLocales`: битая
 * запись выбрасывается, остальные живут. Строгий разбор здесь хуже
 * отсутствия — одна испорченная дата не должна возвращать генератор к
 * фиксированному порядку, при котором хвостовые локали не доходят
 * никогда.
 */
export function parseGenerateStamps(raw: string | null): Map<string, number> {
  const stamps = new Map<string, number>();
  if (!raw) return stamps;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return stamps;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return stamps;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue;
    const at = Date.parse(value);
    if (Number.isFinite(at)) stamps.set(key, at);
  }
  return stamps;
}

/**
 * Порядок обхода: сперва пары без отметки (ни разу не брались —
 * новая локаль, новая тема), потом по давности отметки. Сортировка
 * стабильна, поэтому при равенстве действует исходный порядок — локали
 * как в настройке, внутри локали мастер раньше поздравления. Это ровно
 * прежнее поведение в первую ночь после выката, когда карты ещё нет.
 */
export function orderByStaleness<T extends { locale: string; key: string }>(
  pairs: readonly T[],
  stamps: ReadonlyMap<string, number>,
): T[] {
  const rank = (p: T) =>
    stamps.get(rotationKey(p.locale, p.key)) ?? Number.NEGATIVE_INFINITY;
  return pairs
    .map((pair, index) => ({ pair, index }))
    .sort((a, b) => rank(a.pair) - rank(b.pair) || a.index - b.index)
    .map(({ pair }) => pair);
}

/**
 * Сериализует карту, оставляя только пары текущего круга. Иначе
 * убранная из настройки локаль копилась бы в карте навсегда, а при
 * возвращении пришла бы со старой отметкой — это как раз правильно
 * (давно не генерировали — первой в очередь), но и отсутствие отметки
 * даёт тот же результат, так что хранить мусор незачем.
 */
export function serializeGenerateStamps(
  stamps: ReadonlyMap<string, number>,
  pairs: ReadonlyArray<{ locale: string; key: string }>,
): string {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const k = rotationKey(p.locale, p.key);
    const at = stamps.get(k);
    if (at !== undefined) out[k] = new Date(at).toISOString();
  }
  return JSON.stringify(out);
}
