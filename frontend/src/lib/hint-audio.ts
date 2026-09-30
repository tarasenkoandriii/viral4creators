/**
 * Голос советника на клиенте — ТЗ Greeting 2.0 §4А.4, этап K1.
 *
 * Правила, которые проверяются без React и без браузера: когда реплику
 * произносить, как понимать ответ сервера, где хранится «без звука» и
 * как играет один общий аудиоэлемент. `HintLine` только связывает это с
 * экраном.
 *
 * ## Почему один общий аудиоэлемент
 *
 * iOS и WebView Telegram разрешают звук только из обработчика касания.
 * Разрешение выдаётся ЭЛЕМЕНТУ, а не странице: элемент, однажды
 * запущенный в ответ на касание, дальше играет и из асинхронного кода —
 * после сетевого запроса за файлом. Новый `new Audio()` на каждую
 * реплику такого разрешения не имел бы, и вторая подсказка молча не
 * прозвучала бы. Поэтому элемент один на страницу, и первое касание его
 * «отпирает» (`unlock`) коротким беззвучным проигрыванием.
 */

/** Ключ localStorage: «без звука» запоминается на устройстве (§4А.4). */
export const HINT_AUDIO_MUTED_KEY = 'wizardGuide.voiceMuted';

/** Причина молчания, о которой говорят (потолок голоса В-14). */
export const VOICE_BUDGET_EXHAUSTED = 'budget-exhausted';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * «Без звука» с устройства. Хранилище может не существовать или бросать
 * (приватный режим Safari, запрет в WebView) — тогда звук включён:
 * человек видит кнопку и выключит его одним касанием.
 */
export function readMuted(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(HINT_AUDIO_MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeMuted(
  storage: StorageLike | null | undefined,
  muted: boolean
): void {
  try {
    storage?.setItem(HINT_AUDIO_MUTED_KEY, muted ? '1' : '0');
  } catch {
    // Не запомнилось — кнопка всё равно сработала на этой странице.
  }
}

/**
 * Потолок голоса (В-14) — на UTC-сутки, общий для голоса советника и
 * микрофона (`features/voice`). Один ключ и один формат (`YYYY-MM-DD`
 * по UTC): иначе каждый из двух каналов узнавал бы про исчерпанный
 * потолок сам и сообщал о нём сам — дважды (аудит волны 1).
 */
export const VOICE_BUDGET_DAY_KEY = 'greeting-voice-budget-day';

/** Сутки UTC — те же, по которым сервер считает потолок. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function budgetExhaustedOn(
  storage: StorageLike | null | undefined,
  now: Date
): boolean {
  try {
    return storage?.getItem(VOICE_BUDGET_DAY_KEY) === utcDay(now);
  } catch {
    return false;
  }
}

export function rememberBudgetExhausted(
  storage: StorageLike | null | undefined,
  now: Date
): void {
  try {
    storage?.setItem(VOICE_BUDGET_DAY_KEY, utcDay(now));
  } catch {
    // Без памяти потолок узнается заново одним запросом — не беда.
  }
}

/**
 * «Сказать об исчерпанном потолке» — ровно одному месту на странице.
 * Первый вызов получает `true`, все следующие — `false`.
 */
export function createOnceClaim(): () => boolean {
  let claimed = false;
  return () => {
    if (claimed) return false;
    claimed = true;
    return true;
  };
}

/**
 * Что сейчас делать с репликой.
 *
 * - `off` — голоса нет вовсе (выключен, нет подсказки, потолок исчерпан);
 * - `muted` — голос есть, но человек выключил звук;
 * - `done` — эта реплика уже прозвучала (или запрошена): второй раз
 *   на тот же ключ не идём — повтор был бы и лишним звуком, и лишним
 *   запросом;
 * - `await-gesture` — касания ещё не было, браузер звук не даст: до него
 *   реплика только текстом, рядом — «коснитесь, чтобы советник
 *   заговорил» (§4А.4);
 * - `speak` — просить файл и играть.
 */
export type HintVoicePlan =
  | 'off'
  | 'muted'
  | 'done'
  | 'await-gesture'
  | 'speak';

export function hintVoicePlan(input: {
  voice: boolean;
  muted: boolean;
  gestured: boolean;
  budgetExhausted: boolean;
  /** Ключ кеша подсказки на экране; нет — нечего озвучивать. */
  hintKey: string | null | undefined;
  /** Последний ключ, который уже озвучивали. */
  spokenKey: string | null;
}): HintVoicePlan {
  if (!input.voice || !input.hintKey || input.budgetExhausted) return 'off';
  if (input.muted) return 'muted';
  if (input.hintKey === input.spokenKey) return 'done';
  if (!input.gestured) return 'await-gesture';
  return 'speak';
}

export type HintAudioAnswer =
  | { kind: 'play'; url: string }
  | { kind: 'silent' }
  | { kind: 'budget-exhausted' };

/**
 * Ответ `GET …/hint-audio`, уже развёрнутый из конверта: 204 приходит
 * пустым телом, то есть `undefined`/`''`; 200 — `{ url }` или
 * `{ url: null, reason: 'budget-exhausted' }`. Всё незнакомое — тишина:
 * сервер может уехать вперёд на деплой, а голос — украшение, а не путь.
 */
export function interpretHintAudio(data: unknown): HintAudioAnswer {
  if (!data || typeof data !== 'object') return { kind: 'silent' };
  const { url, reason } = data as { url?: unknown; reason?: unknown };
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    return { kind: 'play', url };
  }
  if (reason === VOICE_BUDGET_EXHAUSTED) return { kind: 'budget-exhausted' };
  return { kind: 'silent' };
}

/**
 * Минимум от `HTMLAudioElement`, который нужен плееру, — ради тестов
 * без браузера.
 */
export interface AudioLike {
  src: string;
  muted: boolean;
  currentTime: number;
  play(): Promise<void> | void;
  pause(): void;
  /** `false` — элемент играет (браузер знает это синхронно). */
  paused?: boolean;
  addEventListener?(type: string, listener: () => void): void;
}

/**
 * Беззвучный WAV в несколько байт — им элемент «отпирается» в
 * обработчике касания. Пустой `src` не годится: `play()` без источника
 * отвергается, и разрешение не выдаётся.
 */
export const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

export interface HintPlayer {
  /** Звать синхронно из обработчика касания. Повтор ничего не делает. */
  unlock(): void;
  /** Играть файл. Прежняя реплика обрывается: говорит одна. */
  play(url: string): void;
  /** Замолчать — уход с шага, «без звука», размонтирование. */
  stop(): void;
  readonly unlocked: boolean;
  /**
   * Звучит ли реплика прямо сейчас. Микрофон (`features/voice`) по нему
   * ставит детектор речи на паузу: иначе он записал бы голос самого
   * советника и отправил его на распознавание (аудит волны 1).
   * Беззвучное отпирание репликой не считается.
   */
  readonly playing: boolean;
  /** Подписка на смену `playing`; возвращает отписку. */
  onPlayingChange(cb: (playing: boolean) => void): () => void;
}

export function createHintPlayer(make: () => AudioLike): HintPlayer {
  let el: AudioLike | null = null;
  let unlocked = false;
  let playing = false;
  const subscribers = new Set<(playing: boolean) => void>();
  const setPlaying = (next: boolean) => {
    if (next === playing) return;
    playing = next;
    for (const cb of subscribers) cb(next);
  };
  const element = (): AudioLike => {
    if (el) return el;
    el = make();
    // События элемента — источник правды: реплика кончилась сама,
    // файл не загрузился, браузер поставил на паузу.
    // Беззвучное отпирание (`muted`) репликой не считается: оно не
    // слышно, и глушить из-за него микрофон незачем.
    el.addEventListener?.('playing', () => {
      if (el && !el.muted) setPlaying(true);
    });
    for (const type of ['pause', 'ended', 'error']) {
      el.addEventListener?.(type, () => {
        // `pause` приходит задачей из очереди: новая реплика ставит
        // прежнюю на паузу и тут же запускается, и к приходу события
        // элемент уже снова играет. Такая пауза — не конец речи.
        if (type === 'pause' && el?.paused === false) return;
        setPlaying(false);
      });
    }
    return el;
  };
  // `play()` у браузера — обещание, и отказ (автовоспроизведение
  // запрещено, файл не загрузился) иначе стал бы необработанной ошибкой
  // в консоли. Голос — украшение: молча.
  const quietly = (r: Promise<void> | void, onFail?: () => void) => {
    if (r && typeof (r as Promise<void>).catch === 'function') {
      (r as Promise<void>).catch(() => onFail?.());
    }
  };
  return {
    get unlocked() {
      return unlocked;
    },
    get playing() {
      return playing;
    },
    onPlayingChange(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    unlock() {
      if (unlocked) return;
      unlocked = true;
      const a = element();
      a.muted = true;
      a.src = SILENT_WAV;
      quietly(a.play());
    },
    play(url: string) {
      const a = element();
      a.pause();
      a.muted = false;
      a.src = url;
      a.currentTime = 0;
      // Сразу, не дожидаясь события `playing`: микрофон должен замолчать
      // раньше, чем из динамика пойдёт первый звук.
      setPlaying(true);
      quietly(a.play(), () => setPlaying(false));
    },
    stop() {
      setPlaying(false);
      if (!el) return;
      el.pause();
      el.currentTime = 0;
    },
  };
}
