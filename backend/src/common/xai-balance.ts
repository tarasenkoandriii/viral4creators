/**
 * Остаток на счёте xAI — разбор ответа и диагностика отказов.
 *
 * ## Почему это вообще отдельный модуль
 *
 * Попытка прочитать баланс xAI в предыдущем проекте владельца не
 * удалась, причём пробовали именно Management API. Разбор документации
 * (23.09.2026) показывает сразу две ловушки, и обе дают отказ, по
 * которому не видно, что именно не так:
 *
 *  1. **Другой хост.** Management API живёт на
 *     `https://management-api.x.ai`, а не на `https://api.x.ai`,
 *     которым ходит генерация. Запрос по знакомому хосту с
 *     management-ключом вернёт 401/404 — и выглядит это как «ключ не
 *     подходит», хотя ключ верный, а адрес нет.
 *  2. **Отдельный ключ и team_id.** Нужен management-ключ из консоли
 *     (Settings → Management keys, аккаунту требуется право Management
 *     Keys Read+Write), а `team_id` в документации не отдаётся никаким
 *     эндпоинтом — его берут из консоли. То есть переменных нужно ДВЕ,
 *     и отсутствие любой из них — не ошибка сети, а «не настроено».
 *
 * Есть и третья, уже не техническая: `prepaid/balance` — это остаток
 * ПРЕДОПЛАЧЕННЫХ кредитов. У аккаунта на постоплате (счёт/карта) такого
 * остатка нет вовсе, и пустой ответ там — правда, а не сбой. Рядом в
 * том же API живут `postpaid/spending-limits` и `usage`.
 *
 * Поэтому модуль чистый и проверяемый: сетевой вызов снаружи, здесь —
 * разбор ответа и перевод кодов ошибок в человеческие причины.
 */

/** Что показывает строка провайдера на экране «Балансы». */
export type BalanceState =
  /** Остаток прочитан. */
  | 'ok'
  /** Не заданы ключи/идентификаторы — спрашивать нечем. */
  | 'not-configured'
  /** Провайдер остатка не отдаёт (или отдаёт не в этом виде). */
  | 'unsupported'
  /** Спросили, но не получилось. `detail` объясняет, что делать. */
  | 'error';

export interface ProviderBalance {
  provider: string;
  state: BalanceState;
  /**
   * Сумма в микродолларах — тот же масштаб, что у расходов
   * (`AiUsage.costMicroUsd`), чтобы два экрана можно было сравнивать
   * не пересчитывая.
   */
  amountMicroUsd?: number;
  /**
   * Сырое значение `total.val`, как его прислал провайдер.
   *
   * Остаётся на экране рядом с разобранной суммой НАМЕРЕННО, хотя
   * единица и знак уже выяснены. Это журнальное сальдо в центах с
   * обратным знаком: показанные «$18.27» и пришедшие «−1827» — одно и
   * то же число, и человеку, который сверяет экран с консолью xAI,
   * надо видеть оба, иначе расхождение выглядит как поломка разбора.
   */
  raw?: string;
  /** Разбивка журнала: сколько пополнено и сколько списано. */
  changes?: XaiChangesSummary;
  /** Человеческое пояснение: что не так и что с этим делать. */
  detail?: string;
  /**
   * Куда пойти и посмотреть остаток своими глазами.
   *
   * Заведено по запросу владельца: число у GROK расходится с консолью
   * (аккаунт на постоплате, журнальное сальдо — не то же самое, что
   * «остаток»), и до того, как это разберут, экран обязан давать
   * дорогу к первоисточнику, а не только своё число. Ссылка стоит
   * рядом с остатком у всех провайдеров, у кого такая страница есть, —
   * в том числе у тех, где остатка мы не спрашиваем вовсе.
   */
  dashboardUrl?: string;
  /**
   * Сырой ответ провайдера целиком, обрезанный по длине.
   *
   * Диагностика, а не витрина: заполняется ТОЛЬКО когда разобрать
   * остаток не вышло. Пока поле не было опознано, ответ показывался
   * всегда — тогда это и был способ его опознать. Теперь единица и
   * знак известны, а в `changes` лежат номера счетов, и держать их на
   * экране в обычном случае незачем. Ключ сюда не попадает никогда —
   * это тело ответа, не запрос.
   */
  rawBody?: string;
  checkedAt: string;
}

/** Адрес Management API. НЕ `api.x.ai` — см. шапку файла. */
export const XAI_MANAGEMENT_BASE = 'https://management-api.x.ai';

export function xaiBalancePath(teamId: string): string {
  return `/v1/billing/teams/${encodeURIComponent(teamId)}/prepaid/balance`;
}

/**
 * Код ответа → причина, которую можно прочитать и починить.
 *
 * Ровно та часть, которой не хватало в прошлой попытке: «не работает»
 * превращается в «ключ не management» либо «нет права» либо «team_id не
 * тот или аккаунт на постоплате».
 */
export function xaiFailureReason(status: number): string {
  if (status === 401) {
    return 'ключ не принят: нужен management-ключ из консоли xAI (Settings → Management keys), обычный ключ генерации сюда не подходит';
  }
  if (status === 403) {
    return 'ключ принят, но прав не хватает: аккаунту нужно право «Management Keys» Read + Write';
  }
  if (status === 404) {
    return 'адрес не найден: проверьте team_id — либо он неверный, либо у аккаунта нет предоплаченных кредитов (postpaid-счёт остатка не имеет)';
  }
  if (status === 429) {
    return 'слишком часто — xAI ограничил частоту запросов; экран кеширует ответы, повторите позже';
  }
  if (status >= 500) {
    return `сторона xAI ответила ${status} — временная неполадка у провайдера, не у нас`;
  }
  return `неожиданный ответ ${status}`;
}

/**
 * ## Единица и знак: разобрано, а не угадано
 *
 * Первый живой вызов вернул `total.val = -1827`, и экран показал
 * «$−1 827». Оба слагаемых ошибки — в одной строке разбора:
 *
 *  - **Это центы, а не доллары.** В примере официальной документации
 *    пополнение на $10 выглядит как `"val": "-1000"`.
 *  - **Знак перевёрнут.** Это не «остаток», а сальдо предоплатного
 *    журнала: пополнение записывается со знаком минус, списание — с
 *    плюсом. Остаток человека равен `total.val` со сменённым знаком.
 *
 * То есть `-1827` — это $18.27 на счёте. Помимо примера в официальной
 * документации
 * (https://docs.x.ai/developers/rest-api-reference/management/billing)
 * единицу и знак подтверждают два независимых источника:
 * https://github.com/brian-bell/swift-usage-bar/pull/53 — читает
 * `total.val`, трактует как центы, знак инвертирует; и
 * https://github.com/robinebers/openusage/issues/391 — там же названы
 * значения `changeOrigin`: `PURCHASE` со знаком минус, `SPEND` с
 * плюсом. Эндпоинт в документации описан, но поведение сальдо в ней не
 * оговорено, поэтому сверка со сторонними реализациями здесь не
 * перестраховка.
 *
 * Почему число всё равно может не совпасть с консолью до цента:
 * консоль показывает остаток на момент своего запроса, а списания
 * доезжают в журнал с задержкой, и на счёте владельца включено
 * автопополнение — между двумя взглядами баланс успевает вырасти
 * скачком. Поэтому рядом с суммой считается разбивка по `changes`, и
 * если она не сходится с `total`, экран говорит об этом прямо, а не
 * делает вид, что журнал полон.
 */

/** Центы биллингового журнала → микродоллары (масштаб `AiUsage`). */
export function centsToMicroUsd(cents: number): number {
  return Math.round(cents * 10_000);
}

export interface XaiChangesSummary {
  /** Сколько всего пополнено за возвращённые записи, микродоллары. */
  purchasedMicroUsd: number;
  /** Сколько списано за них же, микродоллары. */
  spentMicroUsd: number;
  /** Сколько записей отдал провайдер. */
  entries: number;
  /**
   * Сходится ли «пополнено − списано» с `total`.
   *
   * `false` означает ровно одно: журнал пришёл неполным (провайдер
   * ограничивает выдачу). Тогда разбивка — справка, а не отчёт, и
   * выдавать её за полную нельзя.
   */
  matchesTotal: boolean;
}

function changeAmounts(body: unknown): number[] {
  const changes = (body as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes)) return [];
  const out: number[] = [];
  for (const change of changes) {
    const val = (change as { amount?: { val?: unknown } } | null)?.amount?.val;
    if (val === undefined || val === null) continue;
    const n = Number(val);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Разбивка журнала пополнений и списаний.
 *
 * Знак берётся из самих записей, а не из `changeOrigin`: названий
 * источника в документации перечислено не всё, а знак суммы определён
 * однозначно тем же правилом, что и `total`.
 */
export function summarizeXaiChanges(
  body: unknown,
  totalCents?: number,
): XaiChangesSummary | undefined {
  const amounts = changeAmounts(body);
  if (!amounts.length) return undefined;
  let purchasedCents = 0;
  let spentCents = 0;
  for (const n of amounts) {
    if (n < 0) purchasedCents += -n;
    else spentCents += n;
  }
  const sumCents = spentCents - purchasedCents;
  return {
    purchasedMicroUsd: centsToMicroUsd(purchasedCents),
    spentMicroUsd: centsToMicroUsd(spentCents),
    entries: amounts.length,
    matchesTotal:
      totalCents !== undefined && Math.abs(sumCents - totalCents) < 0.5,
  };
}

/** Сколько сырого ответа показываем: хватает, чтобы увидеть форму. */
export const RAW_BODY_LIMIT = 4000;

export function previewBody(body: unknown): string {
  try {
    const text = JSON.stringify(body, null, 2);
    return text.length > RAW_BODY_LIMIT
      ? `${text.slice(0, RAW_BODY_LIMIT)}\n…(обрезано)`
      : text;
  } catch {
    return String(body);
  }
}

export function parseXaiBalance(body: unknown): {
  amountMicroUsd?: number;
  raw?: string;
  changes?: XaiChangesSummary;
} {
  const total = (body as { total?: { val?: unknown } } | null)?.total?.val;
  if (total === undefined || total === null) return {};
  const raw = String(total);
  const cents = Number(raw);
  if (!Number.isFinite(cents)) return { raw };
  return {
    // Знак меняется здесь, и только здесь: журнальное сальдо
    // превращается в остаток, который видит человек.
    amountMicroUsd: centsToMicroUsd(-cents),
    raw,
    changes: summarizeXaiChanges(body, cents),
  };
}
