/**
 * Одна правда о текущей ставке на странице лота (аудит плеера, L-2).
 *
 * Проблема, которую это решает: на BLITZ-лоте страница одновременно
 * держала ДВА независимых опроса одной и той же величины —
 * `LiveAuctionStream` бил в `GET /auctions/:id/state` раз в 4 с и рисовал
 * сумму оверлеем, `AuctionBidForm` бил в `GET /auctions/:id` раз в 8 с и
 * рисовал её же под полем ставки. Два эндпоинта, два интервала, два
 * состояния — и до восьми секунд расхождения между двумя числами,
 * видимыми на одном экране одновременно.
 *
 * Почему шина, а не подъём состояния в общего родителя: между плеером и
 * формой на странице лежит серверная разметка (заголовок, автор, счётчик
 * ставок), а сама страница — серверный компонент и состояния держать не
 * может. Обернуть половину страницы в клиентский компонент ради одного
 * числа — более крупная и более рискованная правка, чем этот модуль.
 *
 * Модуль намеренно примитивен: публикует тот, кто опрашивает чаще
 * (плеер), подписчик (форма) на время жизни публикации выключает
 * собственный опрос. Нет публикаций — форма работает ровно как раньше,
 * поэтому на не-BLITZ лотах и на страницах без плеера ничего не меняется.
 */

export interface HighestBidUpdate {
  listingId: string;
  amount: number | null;
  /** Время публикации — по нему подписчик решает, жив ли публикатор. */
  at: number;
}

type Listener = (update: HighestBidUpdate) => void;

const listeners = new Set<Listener>();
const last = new Map<string, HighestBidUpdate>();

/**
 * Считаем публикатора живым столько же, сколько длится один цикл опроса
 * формы плюс запас: пропал плеер (размонтировался, ушёл в ошибку) —
 * форма молча возвращается к собственному опросу.
 */
export const PUBLISHER_TTL_MS = 12_000;

export function publishHighestBid(listingId: string, amount: number | null): void {
  const update: HighestBidUpdate = { listingId, amount, at: Date.now() };
  last.set(listingId, update);
  for (const listener of listeners) listener(update);
}

/** Есть ли свежая публикация по этому лоту — то есть можно ли не опрашивать самому. */
export function hasFreshPublisher(listingId: string, now: number = Date.now()): boolean {
  const seen = last.get(listingId);
  return !!seen && now - seen.at < PUBLISHER_TTL_MS;
}

export function subscribeHighestBid(listingId: string, listener: Listener): () => void {
  const wrapped: Listener = (update) => {
    if (update.listingId === listingId) listener(update);
  };
  listeners.add(wrapped);
  // Отдаём последнее известное значение сразу — подписчик мог смонтироваться
  // позже первой публикации.
  const seen = last.get(listingId);
  if (seen) wrapped(seen);
  return () => {
    listeners.delete(wrapped);
  };
}
