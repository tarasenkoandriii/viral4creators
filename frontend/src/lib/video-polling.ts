/**
 * Когда опрос статуса ролика можно прекращать (§15.4/§16.1, этап 37).
 *
 * Вынесено из `useWorkflow` отдельным модулем ровно потому, что здесь и
 * была ошибка: опрос гасился на `status === 'complete'`, то есть в ту
 * секунду, когда задача постобработки только создана. Обрезка и озвучка
 * оплачивались, готовый файл ложился в Blob и до пользователя не
 * доходил никогда — при том, что интерфейс обещал «ссылка обновится
 * сама».
 *
 * Правило одно и его стоит проговорить: **опрос ведёт два процесса, а не
 * один**. Рендер у Veo и следующая за ним постобработка — разные
 * операции с разными состояниями, и каждая имеет право продлить опрос.
 */

/** Только те поля, от которых зависит решение. */
export interface PollableVideo {
  status?: 'pending' | 'processing' | 'complete' | 'failed';
  postStatus?: 'pending' | 'complete' | 'failed' | 'skipped';
}

/** Ролик снят и его уже можно показывать — не дожидаясь постобработки. */
export function isVideoReady(video: PollableVideo | null | undefined): boolean {
  return video?.status === 'complete';
}

/** Постобработка идёт: ссылка на ролик ещё сменится. */
export function isPostProductionPending(
  video: PollableVideo | null | undefined
): boolean {
  return video?.postStatus === 'pending';
}

/**
 * Опрашивать дальше?
 *
 * Провал рендера — конец: постобработке нечего обрабатывать. Готовый
 * ролик сам по себе концом НЕ является: если постобработка идёт, ссылка
 * ещё сменится, и прекратить опрос значит выбросить оплаченный результат.
 */
export function shouldKeepPolling(
  video: PollableVideo | null | undefined
): boolean {
  if (!video) return true;
  if (video.status === 'failed') return false;
  if (video.status !== 'complete') return true;
  return isPostProductionPending(video);
}
