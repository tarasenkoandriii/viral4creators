/**
 * Прогоны генерации одного товара (Б-2.9 второго аудита, этап 121).
 *
 * ## Что чинится
 *
 * Маршрут `GET /projects/:id/items/:itemId/sessions` существовал с
 * этапа, где заводились сессии из товара, и не вызывался НИ ОДНИМ
 * экраном. Последствие не косметическое: кнопка «Запустить» затирает
 * единственный `localStorage['sessionId']`, которым живёт мастер. Пока
 * товар A рендерится, человек запускает товар B — и прогон A становится
 * недостижим вовсе: незавершённые сессии не показывает ни один список
 * (`/postprod/videos` отбирает только готовые), а через сутки TTL уносит
 * его вместе с уже оплаченным роликом.
 *
 * Здесь — чистая часть: как читать статус прогона и какой из них
 * предлагать продолжить.
 */

/** Прогон в объёме, который отдаёт `GET …/sessions`. */
export interface ItemRun {
  sessionId: string;
  status: string;
  createdAt: string;
  lastActivityAt: string;
  videoUrl: string | null;
}

/**
 * Не два состояния, а четыре: «готов», «идёт», «брошен» и «пустой».
 *
 * Различать «идёт» и «брошен» приходится потому, что предлагать
 * продолжить имеет смысл и то и другое, но говорить о них одинаково
 * нельзя: у идущего рендера человек ждёт результата, у брошенного —
 * ждёт напоминания, что он остановился на полпути. «Пустой» — сессия,
 * в которой не сделано ничего: возвращаться там не к чему.
 */
export type RunState = 'done' | 'running' | 'stalled' | 'failed' | 'fresh';

/** Статусы сессии (`SessionStatus` бэкенда), означающие идущую работу. */
const RUNNING = new Set(['analyzing', 'generating_video']);

export function runState(run: ItemRun): RunState {
  // Готовый ролик — по факту файла, а не по статусу: статус мог
  // остаться прежним, если что-то дописывалось после (постобработка).
  if (run.videoUrl) return 'done';
  if (run.status === 'error') return 'failed';
  if (RUNNING.has(run.status)) return 'running';
  // `created` — сессия, заведённая кнопкой «Сделать ролик», в которой
  // человек не сделал НИЧЕГО: ни референса, ни разбора. Таких у
  // активного товара накапливается по одной на каждое случайное
  // нажатие, и звать «вернуться» к пустоте — значит спорить с
  // человеком на ровном месте и врать про потраченные деньги.
  if (run.status === 'created') return 'fresh';
  return 'stalled';
}

export function isUnfinished(run: ItemRun): boolean {
  const state = runState(run);
  return state !== 'done' && state !== 'fresh';
}

/**
 * Какой прогон предлагать продолжить перед запуском нового.
 *
 * Берём самый свежий незавершённый — и именно по `lastActivityAt`, а не
 * по дате создания: человек мог вернуться к старому прогону и
 * продолжить его, и предлагать ему вместо этого более новый, но давно
 * брошенный, значит спорить с тем, что он только что делал.
 *
 * `null` — продолжать нечего, запуск нового вопросов не вызывает.
 */
export function resumableRun(
  runs: ItemRun[] | null | undefined
): ItemRun | null {
  const unfinished = (runs ?? []).filter(isUnfinished);
  if (unfinished.length === 0) return null;
  return unfinished.reduce((best, run) =>
    activityTime(run) > activityTime(best) ? run : best
  );
}

function activityTime(run: ItemRun): number {
  const t = Date.parse(run.lastActivityAt || run.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Прогоны в порядке показа: свежие сверху, по последней активности. */
export function sortRuns(runs: ItemRun[]): ItemRun[] {
  return [...runs].sort((a, b) => activityTime(b) - activityTime(a));
}
