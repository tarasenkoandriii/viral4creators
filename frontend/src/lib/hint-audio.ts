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
 * микрофона (`features/voice`). Один ключ и один формат: иначе каждый
 * из двух каналов узнавал бы про исчерпанный потолок сам и сообщал о нём
 * сам — дважды (аудит волны 1).
 *
 * Ключ — с идентификатором пользователя (изменение контракта 6): потолок
 * считается сервером по человеку, и на общем устройстве (семейный
 * телефон, второй аккаунт Telegram) флаг одного не должен глушить
 * другого. Рядом хранится тариф: потолок зависит от тарифа, и после
 * смены тарифа запомненное «исчерпан» больше не правда.
 */
export const VOICE_BUDGET_DAY_KEY = 'greeting-voice-budget-day';

/** Чей потолок: пользователь и его тариф (`null` — ещё не известен). */
export interface VoiceBudgetOwner {
  userId: string;
  plan: string | null;
}

export function voiceBudgetKey(userId: string): string {
  return `${VOICE_BUDGET_DAY_KEY}:${userId}`;
}

/**
 * Чей это телефон — для ключа потолка. Сервер опознаёт по подписанному
 * `initData`; здесь достаточно того же id из `initDataUnsafe` (ключ
 * памяти, а не право). Вне Telegram — дев-вход стенда, иначе общий ключ
 * браузера: у браузерного входа id без запроса к серверу не узнать, а
 * вход в браузере — один на профиль.
 */
export function voiceBudgetUserOf(input: {
  telegramUserId?: number | string | null;
  devUserId?: string | null;
}): string {
  if (input.telegramUserId !== undefined && input.telegramUserId !== null) {
    const id = String(input.telegramUserId).trim();
    if (id) return `tg-${id}`;
  }
  if (input.devUserId) return `dev-${input.devUserId}`;
  return 'browser';
}

/** Сутки UTC — те же, по которым сервер считает потолок. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Исчерпан ли потолок этого человека сегодня — по записи устройства.
 * Запись всегда с тарифом (без тарифа она не пишется, см.
 * `createBudgetMemory`); тариф сверяется, только если сейчас он
 * известен: пока тариф грузится, запомненному дню веры больше, чем
 * лишнему платному запросу. Запись без тарифа (старый формат, ручная
 * правка) не действует — «исчерпан для любого тарифа навсегда» хуже
 * одного лишнего запроса.
 */
export function budgetExhaustedOn(
  storage: StorageLike | null | undefined,
  now: Date,
  owner: VoiceBudgetOwner
): boolean {
  try {
    const raw = storage?.getItem(voiceBudgetKey(owner.userId));
    if (!raw) return false;
    const saved = JSON.parse(raw) as { day?: unknown; plan?: unknown };
    if (saved.day !== utcDay(now)) return false;
    if (typeof saved.plan !== 'string' || !saved.plan) return false;
    return owner.plan === null || saved.plan === owner.plan;
  } catch {
    return false;
  }
}

/** Записать «исчерпан сегодня» — только с известным тарифом. */
export function rememberBudgetExhausted(
  storage: StorageLike | null | undefined,
  now: Date,
  owner: VoiceBudgetOwner & { plan: string }
): void {
  try {
    storage?.setItem(
      voiceBudgetKey(owner.userId),
      JSON.stringify({ day: utcDay(now), plan: owner.plan })
    );
  } catch {
    // Без памяти потолок узнается заново одним запросом — не беда.
  }
}

/**
 * Память о потолке на странице. Потолок узнан, пока тариф ещё не
 * пришёл, — запись на устройство откладывается до тарифа (в памяти
 * страницы флаг действует сразу): записанное без тарифа нечем было бы
 * сверить после его смены.
 */
export interface BudgetMemory {
  mark(owner: VoiceBudgetOwner, now: Date): void;
  isExhausted(owner: VoiceBudgetOwner, now: Date): boolean;
}

export function createBudgetMemory(
  storage: () => StorageLike | null | undefined
): BudgetMemory {
  let pending: { userId: string; day: string } | null = null;
  const settle = (owner: VoiceBudgetOwner, now: Date): boolean => {
    if (!pending) return false;
    if (pending.day !== utcDay(now)) {
      pending = null;
      return false;
    }
    if (pending.userId !== owner.userId) return false;
    if (owner.plan === null) return true;
    // Тариф пришёл — теперь есть с чем записать.
    rememberBudgetExhausted(storage(), now, { ...owner, plan: owner.plan });
    pending = null;
    return true;
  };
  return {
    mark(owner, now) {
      if (owner.plan === null) {
        pending = { userId: owner.userId, day: utcDay(now) };
        return;
      }
      pending = null;
      rememberBudgetExhausted(storage(), now, { ...owner, plan: owner.plan });
    },
    isExhausted(owner, now) {
      return settle(owner, now) || budgetExhaustedOn(storage(), now, owner);
    },
  };
}

/**
 * Прежний общий ключ (без человека) больше не читается — убрать его,
 * чтобы не лежал в хранилище вечно. Бросающее хранилище — не беда.
 */
export function dropLegacyBudgetKey(
  storage: (StorageLike & { removeItem?(key: string): void }) | null | undefined
): void {
  try {
    storage?.removeItem?.(VOICE_BUDGET_DAY_KEY);
  } catch {
    /* нечего убирать */
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
  | { kind: typeof VOICE_BUDGET_EXHAUSTED };

/**
 * Ответ `POST …/hint-audio`, уже развёрнутый из конверта: 204 приходит
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
  if (reason === VOICE_BUDGET_EXHAUSTED)
    return { kind: VOICE_BUDGET_EXHAUSTED };
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
