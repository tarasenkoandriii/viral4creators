/**
 * Выбор следующей голосовой подсказки в эфире живого аукциона — чистая
 * логика, вынесенная из `LiveAuctionStream.tsx`.
 *
 * Зачем отдельным модулем: здесь живёт самая дорогая ошибка плеера
 * (аудит L-1). Реплика `BID_STATS` — это «Новая ставка — <сумма>» с
 * суммой, впечатанной в аудио при генерации. Проиграть такую реплику
 * не вовремя значит назвать участнику торгов неверную цену ровно в тот
 * момент, когда он решает, сколько ставить. Компонент с таймерами,
 * рефами и `<audio>` тестировать нечем, а эти двадцать строк — можно.
 *
 * Два правила, которые модуль обязан держать:
 *
 * 1. Подсказки, лежавшие в плейлисте на момент подключения зрителя, уже
 *    прозвучали для тех, кто смотрел раньше. Их не проигрывают
 *    («seedPlayed» при первом наборе).
 * 2. Если к моменту выбора накопилось несколько непрозвучавших
 *    `BID_STATS`, актуальна ТОЛЬКО последняя. Остальные отбрасываются, а
 *    не откладываются на следующие круги: прежние назвали бы уже
 *    перебитую цену, да ещё и в обратном порядке.
 */

export interface RotationCue {
  id: string;
  seq: number;
  kind: string;
  audioUrl: string;
}

export interface RotationState {
  /** `seq` подсказок, которые проигрывать не нужно: прозвучали или отброшены. */
  played: Set<number>;
  /**
   * Перемешанный порядок pregen-подсказок на текущий круг — списком
   * `seq`, а не объектами. Так круг переживает смену объектов между
   * опросами (сервер каждые 4 секунды отдаёт новые экземпляры того же
   * плейлиста) и не навязывает состоянию конкретный тип подсказки.
   */
  order: number[];
  /** Подпись набора pregen-подсказок, на котором построен круг. */
  orderSig: string;
  orderIdx: number;
  /** Историю засеяли — второй раз не сеем. */
  seeded: boolean;
}

/** Верхняя граница журнала — эфир может идти часами. */
export const PLAYED_LOG_CAP = 200;

export function createRotationState(): RotationState {
  return { played: new Set(), order: [], orderSig: '', orderIdx: 0, seeded: false };
}

/**
 * Пометить всё, что уже лежало в плейлисте при подключении, как
 * не подлежащее проигрыванию. Идемпотентна: вызывается и из первого
 * рендера (когда есть снимок с сервера), и из первого тика опроса
 * (когда снимка не было).
 */
export function seedPlayed(state: RotationState, cues: readonly RotationCue[]): void {
  if (state.seeded) return;
  state.seeded = true;
  for (const cue of cues) {
    if (cue.kind === 'BID_STATS') state.played.add(cue.seq);
  }
}

/** Самая свежая непрозвучавшая ставка, если такая есть. */
export function pendingBidStatsSeq(state: RotationState, cues: readonly RotationCue[]): number | null {
  let max: number | null = null;
  for (const cue of cues) {
    if (cue.kind === 'BID_STATS' && !state.played.has(cue.seq)) {
      max = max === null ? cue.seq : Math.max(max, cue.seq);
    }
  }
  return max;
}

function prune(state: RotationState): void {
  if (state.played.size <= PLAYED_LOG_CAP) return;
  const keep = [...state.played].sort((a, b) => a - b).slice(-PLAYED_LOG_CAP);
  state.played = new Set(keep);
}

function defaultShuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Следующая подсказка: свежая ставка — вне очереди, иначе — следующая по
 * кругу из перемешанного набора pregen-реплик. Перемешивание
 * пересчитывается, когда набор pregen-подсказок изменился или круг
 * закончился. `shuffle` параметром — чтобы тест был детерминированным.
 */
export function pickNextCue<T extends RotationCue>(
  state: RotationState,
  cues: readonly T[],
  shuffle: <U>(arr: readonly U[]) => U[] = defaultShuffle,
): T | null {
  if (cues.length === 0) return null;

  const freshBidStats = cues.filter((c) => c.kind === 'BID_STATS' && !state.played.has(c.seq));
  if (freshBidStats.length > 0) {
    const next = freshBidStats[freshBidStats.length - 1];
    // Правило 2: остальные отбрасываем здесь же, а не откладываем.
    for (const stale of freshBidStats) state.played.add(stale.seq);
    prune(state);
    return next;
  }

  const pregen = cues.filter((c) => c.kind !== 'BID_STATS');
  if (pregen.length === 0) return null;

  const sig = pregen.map((c) => c.seq).join(',');
  if (state.order.length === 0 || state.orderIdx >= state.order.length || sig !== state.orderSig) {
    state.order = shuffle(pregen.map((c) => c.seq));
    state.orderSig = sig;
    state.orderIdx = 0;
  }
  const seq = state.order[state.orderIdx];
  state.orderIdx += 1;
  // Подсказка могла исчезнуть из плейлиста между вызовами (сервер отдаёт
  // последние 50) — тогда просто берём первую доступную, круг
  // пересоберётся на следующем вызове по изменившейся подписи.
  return pregen.find((c) => c.seq === seq) ?? pregen[0];
}
