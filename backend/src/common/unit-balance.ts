/**
 * Остаток, который не в деньгах (TODO §III п.36, этап 142).
 *
 * У ElevenLabs и SerpApi «сколько осталось» — это не сумма, а счётчик:
 * символы синтеза и поиски. Экран «Балансы» до этого этапа честно
 * говорил про обоих «остаток не в деньгах — отдельная задача»: показать
 * 40 000 в той же колонке, где $18.27, значило бы получить страницу, по
 * которой нельзя сложить ни одного вывода.
 *
 * ## Почему разбор отдельно от запроса
 *
 * Та же причина, что у `xai-balance.ts`: сетевой вызов снаружи, здесь
 * — только перевод чужого JSON в наши единицы. Проверяется без сети и
 * без ключей, а ключей у песочницы нет.
 *
 * ## Две ловушки, обе замечены по документации (24.09.2026)
 *
 *  1. **У ElevenLabs остаток не приходит готовым.** Приходят
 *     `character_count` (истрачено) и `character_limit` (сколько дают),
 *     а остаток — их разность. И она бывает ОТРИЦАТЕЛЬНОЙ: у тарифов с
 *     `current_overage` лимит можно перебрать. Приводить такое к нулю
 *     значило бы показать «осталось 0» там, где правда — «уже должны».
 *  2. **У SerpApi ключ идёт СТРОКОЙ ЗАПРОСА** — заголовка их API не
 *     принимает. Значит адрес запроса нельзя ни логировать, ни класть
 *     в сообщение об ошибке целиком: ключ уедет в журнал. Отсюда
 *     `SERPAPI_ACCOUNT_URL` без ключа — он только для человека.
 */

/** Остаток в единицах провайдера. */
export interface BalanceUnits {
  /**
   * Сколько осталось. Отрицательное — перебор сверх лимита: у
   * ElevenLabs это штатное состояние тарифа с `current_overage`.
   */
  left: number;
  /** Из скольких на период, если провайдер это сказал. */
  total?: number;
  /** Единица во множественном родительном: «символов», «поисков». */
  label: string;
  /** Когда счётчик обнулится, если провайдер это сказал. */
  resetsAt?: string;
}

export const ELEVENLABS_SUBSCRIPTION_URL =
  'https://api.elevenlabs.io/v1/user/subscription';

/** Адрес БЕЗ ключа: у SerpApi он идёт строкой запроса (см. шапку). */
export const SERPAPI_ACCOUNT_URL = 'https://serpapi.com/account.json';

/**
 * Вычистить ключ из чужого текста (аудит этапа 142).
 *
 * У SerpApi ключ стоит в адресе запроса, а сообщение об ошибке уходит
 * и на экран, и в журнал. Часть отказов `fetch` называет адрес в
 * тексте («Failed to parse URL from …», ошибки прокси и редиректов), и
 * тогда ключ уезжает туда же. Проверять по списку, какие именно
 * сообщения его содержат, значило бы держать этот список в голове
 * вечно; дешевле не пускать ключ ни в одну строку, которая покидает
 * функцию. Заодно вычищается и его URL-кодированный вид: в адрес он
 * попадает уже закодированным.
 */
export function redactKey(text: string, key: string | undefined): string {
  if (!key) return text;
  let out = text.split(key).join('…');
  const encoded = encodeURIComponent(key);
  if (encoded !== key) out = out.split(encoded).join('…');
  return out;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * `GET /v1/user/subscription` (заголовок `xi-api-key`). `null` — в
 * ответе нет обоих чисел, из которых считается остаток.
 */
export function parseElevenLabsBalance(body: unknown): BalanceUnits | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const used = finite(b.character_count);
  const limit = finite(b.character_limit);
  if (used === undefined || limit === undefined) return null;

  const reset = finite(b.next_character_count_reset_unix);
  return {
    left: limit - used,
    total: limit,
    label: 'символов',
    // Секунды, а не миллисекунды: у ElevenLabs поле так и названо —
    // `_unix`. Ноль означает «сброса нет» (бессрочный пакет), а не
    // «сброс был в 1970-м».
    ...(reset ? { resetsAt: new Date(reset * 1000).toISOString() } : {}),
  };
}

/**
 * `GET /account.json?api_key=…`. Считается по `total_searches_left` —
 * это план ПЛЮС докупленные кредиты, то есть то, что действительно
 * можно потратить; `plan_searches_left` меньше и без докупленного.
 */
export function parseSerpApiBalance(body: unknown): BalanceUnits | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const left = finite(b.total_searches_left) ?? finite(b.plan_searches_left);
  if (left === undefined) return null;
  return { left, label: 'поисков' };
}
