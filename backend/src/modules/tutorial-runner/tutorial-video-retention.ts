/**
 * tutorial-video-retention.ts — правило «кого из уже снятых роликов
 * обучалки оставить, а кого подмести».
 *
 * Чистая функция, отдельным файлом и без Prisma/Blob — по тем же
 * основаниям, что и `tutorial-video-assembly.ts` рядом: правило
 * содержательное (легко ошибиться и стереть то, что показывается
 * посетителю), а проверять его на моках базы значит проверять моки.
 *
 * Полное обоснование ролей — в доккомментарии `sweepOldAssets`
 * (`tutorial-scenario-runner.service.ts`), который этой функцией и
 * пользуется. Здесь — только правило.
 */

import { assetTheme } from './tutorial-theme-rotation';

export interface SweepableAsset {
  id: string;
  subjectKey: string;
  locale: string;
  reviewed: boolean;
  /**
   * Ссылка на готовый mp4. Роли «проигрываемый» и «одобренный»
   * считаются по НЕЙ, а не по `assemblyStatus`, — намеренно, и это
   * правка повторного сквозного аудита A+B+C.
   *
   * Все потребители ролика читают ровно эту пару и НЕ смотрят на
   * статус: консультант выбирает `{reviewed: true, blobUrl: {not:
   * null}}` (`assistant.service.ts`), админская кнопка «Одобрить»
   * заблокирована только по `!blobUrl`, `setReviewed` статус не
   * проверяет. Подметальщик, считавший по статусу, расходился с ними
   * на строке `failed` с живым `blobUrl` — и удалял то, что прямо
   * сейчас показывается посетителю. Правило обязано читать то же
   * самое, что читает потребитель.
   */
  blobUrl: string | null;
  /**
   * Нужен только четвёртой роли — «свежие провалы» (см. ниже). Нет
   * поля — строка в этой роли не участвует.
   */
  assemblyStatus?: string;
  /**
   * Тема ролика (заход 3 «Актуального демо», 06.10.2026): светлый и
   * тёмный — РАЗНЫЕ ролики одной пары, и каждая роль держится в своей
   * теме. Без темы — светлая: до тем всё снималось светлым.
   */
  theme?: string | null;
}

/**
 * Делит строки по парам (шаг, локаль, тема) и возвращает те, что
 * можно удалить.
 *
 * Вход обязан быть отсортирован так, чтобы внутри пары строки шли от
 * СВЕЖЕЙ к старой (`createdAt desc`); порядок самих пар не важен.
 * Сортировка — на стороне базы, а не здесь: здесь нет `createdAt`
 * намеренно, чтобы не появилось второе место, где решается «какая
 * свежее», и эти два места не разошлись.
 *
 * Оставляем на пару по строке на каждую роль:
 *  - первую любого статуса (последняя попытка — её видит оператор);
 *  - первую с `blobUrl` (проигрываемый файл есть всегда);
 *  - первую `reviewed` с `blobUrl` (её видит посетитель);
 *  - до `failedKeep` провалов (`failed` без файла), что свежее
 *    последнего проигрываемого ролика пары;
 *  - предыдущую `reviewed` с `blobUrl` — только у пар из
 *    `approvalGracePairs`: новый одобрен меньше суток назад, а кеши
 *    по дороге к посетителю ещё отдают ссылку на прежний.
 *
 * Четвёртая роль — находка аудита 01.10.2026. Потолок попыток сборки
 * (`MAX_ASSEMBLY_ATTEMPTS`) считает провалы того же содержимого ПО
 * СТРОКАМ, а подметальщик на каждом тике опроса оставлял от них одну
 * (самую свежую) — счёт не доходил до потолка никогда, и падающая
 * задача уходила и оплачивалась каждый час. Провалы СТАРШЕ
 * проигрываемого ролика не нужны: после них сборка удалась.
 *
 * Всё остальное — в возврат, в том же порядке, в каком пришло.
 */
export function selectSweepableAssets<T extends SweepableAsset>(
  rows: readonly T[],
  failedKeep = 0,
  /**
   * Пары (`sweepPairKey`), у которых САМЫЙ СВЕЖИЙ одобренный ролик
   * одобрен меньше суток назад, — см. `pairsInApprovalGrace`. У них
   * держится ещё и предыдущий одобренный (пятая роль ниже).
   */
  approvalGracePairs: ReadonlySet<string> = new Set(),
): T[] {
  const failedKept = new Map<string, number>();
  const seenPair = new Set<string>();
  const seenPlayable = new Set<string>();
  const seenReviewed = new Set<string>();
  const seenPreviousReviewed = new Set<string>();
  const doomed: T[] = [];

  for (const row of rows) {
    const pair = sweepPairKey(row);
    // Каждая роль занимается ОТДЕЛЬНО, и строка выживает, если заняла
    // хотя бы одну. Через один счётчик «оставили N» это не
    // выражается: три роли могут прийтись и на одну строку, и на три
    // разные, и «оставить первые три» удалило бы одобренный ролик,
    // если перед ним лежат три неодобренных (ровно то, что бывает
    // после трёх ночей без одобрения).
    let keep = false;
    if (!seenPair.has(pair)) {
      seenPair.add(pair);
      keep = true;
    }
    if (row.blobUrl && !seenPlayable.has(pair)) {
      seenPlayable.add(pair);
      keep = true;
    }
    // `reviewed` учитывается только там, где есть файл: одобрение без
    // файла показать нечем (§4.6 ТЗ), и бессрочной прописки такая
    // строка не заслуживает.
    if (row.reviewed && row.blobUrl && !seenReviewed.has(pair)) {
      seenReviewed.add(pair);
      keep = true;
    } else if (
      // Пятая роль (аудит кронов 06.10.2026): ПРЕДЫДУЩИЙ одобренный
      // ролик живёт ещё сутки после одобрения нового. Посетителю ссылку
      // отдают через кеш ответа (300 с) и ISR лендинга (300 с), то есть
      // до десяти минут после одобрения нового он видит ссылку на
      // старый mp4 — а подметальщик ходит каждые две минуты и сносил
      // его сразу: битый плеер на лендинге. Сутки — с запасом над
      // любым кешем по дороге; постер уходит вместе со строкой.
      row.reviewed &&
      row.blobUrl &&
      approvalGracePairs.has(pair) &&
      !seenPreviousReviewed.has(pair)
    ) {
      seenPreviousReviewed.add(pair);
      keep = true;
    }
    if (
      row.assemblyStatus === 'failed' &&
      !row.blobUrl &&
      !seenPlayable.has(pair) &&
      (failedKept.get(pair) ?? 0) < failedKeep
    ) {
      failedKept.set(pair, (failedKept.get(pair) ?? 0) + 1);
      keep = true;
    }
    if (!keep) doomed.push(row);
  }

  return doomed;
}

/**
 * Ключ пары (шаг, локаль, тема) — один на все роли подметальщика.
 *
 * Тема в ключе с захода 3 «Актуального демо» (06.10.2026). Без неё
 * свежий тёмный ролик занимал роли «последняя попытка», «проигрываемый»
 * и «одобренный» за всю пару, и подметальщик сносил одобренный светлый —
 * то есть чередование тем стирало бы ролики друг друга каждый тик.
 */
export function sweepPairKey(row: {
  subjectKey: string;
  locale: string;
  theme?: string | null;
}): string {
  return `${row.subjectKey}\u0000${row.locale}\u0000${assetTheme(row.theme)}`;
}

/**
 * Сколько держать предыдущий одобренный ролик после одобрения нового
 * (аудит кронов 06.10.2026, см. пятую роль `selectSweepableAssets`).
 */
export const APPROVAL_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Настройка-карта «id ролика → когда его одобрили».
 *
 * Отдельной колонки «одобрен когда» у `TutorialVideoAsset` нет, а
 * ответ нужен ровно на одни сутки после одобрения — поэтому карта, а не
 * схема: пишет её `TutorialVideoAdminService.setReviewed`, читает
 * подметальщик, и старше `APPROVAL_STAMPS_KEEP_MS` записи из неё
 * выпадают при следующей записи.
 */
export const APPROVAL_STAMPS_SETTING_KEY = 'tutorial.videoApprovedAt';
const APPROVAL_STAMPS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Терпимый разбор карты: мусор — пустая карта, а не исключение. */
export function parseApprovalStamps(raw: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return out;
  }
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue;
    const at = Date.parse(value);
    if (Number.isFinite(at)) out.set(id, at);
  }
  return out;
}

/** Карта с новой отметкой и без отметок старше недели — строкой для настройки. */
export function recordApprovalStamp(
  raw: string | null,
  assetId: string,
  now: number,
): string {
  const stamps = parseApprovalStamps(raw);
  stamps.set(assetId, now);
  const out: Record<string, string> = {};
  for (const [id, at] of stamps) {
    if (now - at <= APPROVAL_STAMPS_KEEP_MS) {
      out[id] = new Date(at).toISOString();
    }
  }
  return JSON.stringify(out);
}

/**
 * Пары, у которых самый свежий одобренный проигрываемый ролик одобрен
 * меньше `graceMs` назад. Вход — в том же порядке, что у
 * `selectSweepableAssets` (внутри пары от свежей к старой).
 *
 * Отметки нет (одобрен до этой правки, или запись карты не удалась) —
 * пары в ответе нет, то есть поведение прежнее: держится только самый
 * свежий одобренный.
 */
export function pairsInApprovalGrace(
  rows: readonly SweepableAsset[],
  stamps: ReadonlyMap<string, number>,
  now: number,
  graceMs: number = APPROVAL_GRACE_MS,
): Set<string> {
  const decided = new Set<string>();
  const inGrace = new Set<string>();
  for (const row of rows) {
    if (!row.reviewed || !row.blobUrl) continue;
    const pair = sweepPairKey(row);
    if (decided.has(pair)) continue;
    decided.add(pair);
    const at = stamps.get(row.id);
    if (at !== undefined && now - at < graceMs) inGrace.add(pair);
  }
  return inGrace;
}
