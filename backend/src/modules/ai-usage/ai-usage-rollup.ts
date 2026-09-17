/**
 * Свёртка журнала расходов на ИИ — чистая часть (doc/TODO.md §I-Б.5,
 * часть находки Б-1.7 второго аудита; этап 118).
 *
 * ## Что чинится
 *
 * `ai_usage` — строка на КАЖДЫЙ вызов платного провайдера, и ничто её
 * не чистит: таблица растёт примерно на 4 ГБ в год и будет расти,
 * пока живёт продукт. Просто удалять старое нельзя — на этих же
 * строках держатся все отчёты «за всё время»: общий расход, разбивка
 * по провайдерам и операциям, топ пользователей, расход конкретного
 * человека в его карточке. Удаление превратило бы их в «расход за
 * последние 90 дней», причём молча.
 *
 * Поэтому не удаление, а СВЁРТКА: месяц целиком схлопывается в
 * агрегаты по тем измерениям, в которых его потом читают, и только
 * после этого сырые строки того месяца уходят.
 *
 * ## Почему именно эти измерения
 *
 * Набор ключа — не «на всякий случай пошире», а ровно то, по чему
 * группируют читатели (`ai-usage.service.ts`): провайдер, операция,
 * модель, пользователь, признак анонимности и признак «ставки в
 * прайсе не нашлось». Лишнее измерение здесь — это лишние строки
 * навсегда; недостающее — безвозвратно потерянный разрез, потому что
 * сырых строк после свёртки уже нет.
 *
 * `sessionId` и `pricingVersion` в ключ НЕ входят сознательно. Первый
 * — идентификатор, по которому старые отчёты не строятся вовсе (а
 * сессии и сами удаляются по TTL), и он бы разнёс свёртку на сотни
 * тысяч строк, то есть не решил бы задачу. Второй нужен, чтобы
 * объяснить цену КОНКРЕТНОГО вызова, а объяснять вызов, которого уже
 * нет, нечем; версия прайса остаётся в сырых строках свежих месяцев,
 * где вопрос и возникает.
 *
 * ## Почему `costMicroUsd` — BigInt
 *
 * В сырой строке это `Int`: один вызов дороже 2 147 долларов —
 * фантастика. В сумме за месяц по одной модели — обычное дело уже
 * сегодня, а через год подавно. Переполнение `Int` здесь было бы
 * молчаливым и необратимым: сырых строк, по которым можно
 * пересчитать, к тому моменту не останется.
 */

/** Ключ месяца в формате `YYYY-MM`, всегда по UTC — тот же принцип,
 * что у суточных счётчиков (`SerpApiUsage`, `ClientSiteTutorialUsage`):
 * строка без таймзонных сюрпризов `DateTime`. */
export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Первый день месяца (UTC) — граница для выборки сырых строк. */
export function monthStart(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

/** Первый день СЛЕДУЮЩЕГО месяца — верхняя граница, строго. */
export function monthEnd(month: string): Date {
  const start = monthStart(month);
  return new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
}

/**
 * Сколько дней сырых строк остаётся нетронутыми. 90 — из формулировки
 * самой задачи (§I-Б.5), и число не произвольное: отчёты админки
 * строят окна 1/7/30 дней по сырым строкам, так что запас втрое
 * перекрывает самое длинное из них. Всё, что старше, уже читается
 * только «за всё время», то есть из свёртки.
 */
export const RAW_RETENTION_DAYS = 90;

/**
 * Какие месяцы можно сворачивать прямо сейчас.
 *
 * Правило одно и оно строгое: месяц сворачивается, только когда он
 * ЗАКОНЧИЛСЯ и его конец старше срока хранения. Иначе свёртка съела
 * бы строки, по которым ещё считаются окна 1/7/30 дней, и отчёт за
 * вчера стал бы неполным — тихо.
 *
 * Возвращает по возрастанию: старое сворачивается первым, чтобы
 * прерванный прогон продолжался с того же места, а не начинал заново.
 */
export function monthsReadyToRoll(
  presentMonths: string[],
  now: Date,
  retentionDays = RAW_RETENTION_DAYS,
): string[] {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
  return [...new Set(presentMonths)]
    .filter((month) => /^\d{4}-\d{2}$/.test(month))
    .filter((month) => monthEnd(month).getTime() <= cutoff.getTime())
    .sort();
}

/** Одна строка свёртки — ровно то, что ложится в таблицу. */
export interface RollupBucket {
  month: string;
  userId: string | null;
  anonymous: boolean;
  provider: string;
  operation: string;
  model: string;
  unpriced: boolean;
  calls: number;
  costMicroUsd: bigint;
}

/**
 * Строка группировки, как её отдаёт Postgres (`GROUP BY` шести
 * измерений). Группирует база, а не Node: месяц журнала — это миллионы
 * строк, и тащить их в функцию ради сложения было бы тем же дефектом,
 * который уже чинили в отчёте (А-1.1, 25 МБ в куче ради одного числа),
 * только на порядок крупнее. Здесь остаётся ровно то, что базе
 * доверить нельзя: перевод суммы в `BigInt` и штамп месяца.
 */
export interface GroupedUsageRow {
  userId: string | null;
  anonymous: boolean;
  provider: string;
  operation: string;
  model: string;
  unpriced: boolean;
  _sum: { costMicroUsd: number | bigint | null };
  _count: { _all: number };
}

/**
 * Строки `GROUP BY` → строки свёртки.
 *
 * Отдельной функцией — по той же причине, по которой отдельным файлом
 * вынесена арифметика раундов визарда: это единственное место, где
 * можно ошибиться так, что ошибку уже не исправить (сырых строк после
 * свёртки не будет), а чистую функцию можно прогнать тестом без базы.
 */
export function bucketsFromGrouped(
  month: string,
  rows: GroupedUsageRow[],
): RollupBucket[] {
  return rows.map((row) => ({
    month,
    userId: row.userId,
    anonymous: row.anonymous,
    provider: row.provider,
    operation: row.operation,
    model: row.model,
    unpriced: row.unpriced,
    calls: row._count._all,
    // `sum(int4)` Postgres возвращает как `bigint`, но через клиента
    // может приехать и числом — приводим одинаково, иначе сумма месяца
    // молча упёрлась бы в 32 бита (и пересчитать было бы не из чего).
    costMicroUsd: BigInt(row._sum.costMicroUsd ?? 0),
  }));
}

/** Сумма и число вызовов — общая форма всех «за всё время» отчётов. */
export interface Totals {
  costMicroUsd: number;
  calls: number;
}

/**
 * Складывает «сырую» часть отчёта со «свёрнутой».
 *
 * Вся суть этого этапа с точки зрения читателя: отчёт «за всё время»
 * теперь собирается из двух источников, и забыть второй — значит
 * показать заниженные деньги. Функция одна на всех, чтобы это забыть
 * было негде.
 */
export function mergeTotals(raw: Totals, rolled: Totals): Totals {
  return {
    costMicroUsd: raw.costMicroUsd + rolled.costMicroUsd,
    calls: raw.calls + rolled.calls,
  };
}

/** Разрез отчёта: ключ (провайдер/операция/модель/пользователь) → суммы. */
export type Buckets = Map<string, Totals>;

export function mergeBuckets(raw: Buckets, rolled: Buckets): Buckets {
  const out: Buckets = new Map(raw);
  for (const [key, totals] of rolled) {
    const existing = out.get(key);
    out.set(key, existing ? mergeTotals(existing, totals) : { ...totals });
  }
  return out;
}

/**
 * `BigInt` → `number` для отдачи наружу. Суммы в микродолларах: предел
 * точности `number` (9·10¹⁵) — это девять миллиардов долларов, так что
 * потеря точности здесь недостижима, а `JSON.stringify` от `BigInt`
 * бросает исключение, то есть отдавать его в API нельзя.
 */
export function microToNumber(
  value: bigint | number | null | undefined,
): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}
