/**
 * Очередь публикации на стороне экрана (Б-2.6 второго аудита, этап 121).
 *
 * ## Что чинится
 *
 * Сервер держит инвариант «одна ОТКРЫТАЯ заявка на сессию и площадку»
 * (`publication.service.ts`), а экран считал очередь занятой только для
 * ТЕКУЩЕГО ролика. После перегенерации (аудит нашёл замечание, человек
 * его применил — это тот же сеанс, но уже другой `generatedVideoId`)
 * заявка на прежнюю версию с экрана исчезала: кнопка «Опубликовать»
 * появлялась снова, а сервер отвечал 409 про заявку, которой на экране
 * нет и которую поэтому нельзя отозвать. Тупик.
 *
 * ## Почему фильтр по ролику вообще был
 *
 * Он не бессмысленный: человеку интересна судьба ИМЕННО того ролика, на
 * который он смотрит. Поэтому фильтр не выброшен, а разделён на два
 * вопроса, которые раньше были одним:
 *
 * - «занята ли очередь» — про сессию и площадку, как на сервере;
 * - «относится ли заявка к этому ролику» — про показ.
 *
 * Обе функции чистые и лежат здесь, а не в компоненте, чтобы их можно
 * было прогнать тестом: расхождение с сервером — это ровно тот дефект,
 * который тут закрывается, и заметить его повторно было бы нечем.
 */

/** Заявка в объёме, который нужен этим правилам. */
export interface QueuedRequest {
  id: string;
  platform: string;
  status: string;
  generatedVideoId?: string | null;
}

/** Статусы, которые сервер считает ОТКРЫТОЙ заявкой. */
export const OPEN_STATUSES = ['PENDING', 'APPROVED'] as const;

export function isOpen(request: QueuedRequest): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(request.status);
}

/**
 * Заявка, которая занимает очередь этой площадки, — по тому же правилу,
 * что и на сервере: сессия + площадка, БЕЗ учёта версии ролика.
 */
export function blockingRequest<T extends QueuedRequest>(
  requests: T[] | null | undefined,
  platform: string
): T | null {
  return (
    (requests ?? []).find((r) => r.platform === platform && isOpen(r)) ?? null
  );
}

/** Заявка относится к другой версии ролика, чем открытая на экране. */
export function isForOtherVideo(
  request: QueuedRequest,
  currentVideoId: string | null | undefined
): boolean {
  // Заявка без `generatedVideoId` — из времён до того, как его начали
  // записывать. Считать её «чужой» было бы обидной ошибкой: человек
  // увидел бы «прежняя версия» у заявки на тот самый ролик.
  if (!request.generatedVideoId || !currentVideoId) return false;
  return request.generatedVideoId !== currentVideoId;
}

/**
 * Что делать с очередью площадки прямо сейчас.
 *
 * `free` — можно отправлять; `blocked` — занята заявкой на ЭТОТ же
 * ролик (обычное «уже в очереди»); `blocked-by-other` — занята заявкой
 * на прежнюю версию: это и есть случай Б-2.6, и человеку нужно сказать
 * не «уже в очереди», а «отзовите ту заявку». `withdrawable` отделено,
 * потому что одобренную оператором заявку отозвать уже нельзя — совет
 * «отзовите» был бы издевательством.
 */
export interface QueueState<T extends QueuedRequest = QueuedRequest> {
  kind: 'free' | 'blocked' | 'blocked-by-other';
  request: T | null;
  withdrawable: boolean;
}

export function queueState<T extends QueuedRequest>(
  requests: T[] | null | undefined,
  platform: string,
  currentVideoId: string | null | undefined
): QueueState<T> {
  const request = blockingRequest(requests, platform);
  if (!request) return { kind: 'free', request: null, withdrawable: false };
  return {
    kind: isForOtherVideo(request, currentVideoId)
      ? 'blocked-by-other'
      : 'blocked',
    request,
    withdrawable: request.status === 'PENDING',
  };
}
