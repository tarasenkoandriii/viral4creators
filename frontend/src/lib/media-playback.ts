/**
 * Что сейчас звучит на странице — общий реестр `<video>`/`<audio>`
 * (аудит волны 2 ветки K, §4А.7.5 ТЗ поздравления).
 *
 * Микрофон помощника не должен писать звук самой страницы: ролик
 * справки или готовое поздравление, играющие вслух, иначе уходят на
 * сервер как «речь» — и платно распознаются, и разбираются как команда.
 * Голос советника уже учитывается (`isHintPlaying`); этот реестр — то же
 * для любых медиа-элементов: элемент регистрируется при монтировании
 * (`registerMediaPlayback`), детектор речи спрашивает `isMediaPlaying()`.
 *
 * «Играет» — по событиям `play`/`pause`/`ended`/`error` и по состоянию
 * самого элемента (`paused`, `ended`), а не по флагу, который можно
 * забыть сбросить: снятый с экрана элемент снимается и из реестра.
 */

/** Ровно то, что реестру нужно от элемента, — фейк в тесте, `HTMLMediaElement` в браузере. */
export interface MediaLike {
  readonly paused: boolean;
  readonly ended: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

const EVENTS = ['play', 'playing', 'pause', 'ended', 'error', 'emptied'];

export interface MediaPlaybackRegistry {
  register(el: MediaLike): () => void;
  isPlaying(): boolean;
  onChange(cb: (playing: boolean) => void): () => void;
}

export function createMediaPlaybackRegistry(): MediaPlaybackRegistry {
  const elements = new Set<MediaLike>();
  const listeners = new Set<(playing: boolean) => void>();
  let last = false;

  const isPlaying = (): boolean => {
    for (const el of elements) if (!el.paused && !el.ended) return true;
    return false;
  };
  // Подписчики слышат только смену состояния: `play` и `playing` подряд
  // — одно «заиграло», а не два.
  const notify = (): void => {
    const now = isPlaying();
    if (now === last) return;
    last = now;
    for (const cb of [...listeners]) cb(now);
  };

  return {
    register(el) {
      if (elements.has(el)) return () => undefined;
      elements.add(el);
      for (const e of EVENTS) el.addEventListener(e, notify);
      notify();
      return () => {
        elements.delete(el);
        for (const e of EVENTS) el.removeEventListener(e, notify);
        notify();
      };
    },
    isPlaying,
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

const page = createMediaPlaybackRegistry();

/** Зарегистрировать медиа-элемент страницы; вернёт снятие регистрации. */
export function registerMediaPlayback(el: MediaLike): () => void {
  return page.register(el);
}

/**
 * Колбэк-реф для `<video ref={…}>`: элемент регистрируется, когда React
 * его монтирует, и снимается, когда снимает (`null`). Держите один
 * экземпляр на компонент — `useState(() => mediaPlaybackRef())[0]`:
 * новый реф на каждый рендер снимал бы и заново ставил регистрацию.
 */
export function mediaPlaybackRef(
  registry: Pick<MediaPlaybackRegistry, 'register'> = page
): (el: MediaLike | null) => void {
  let off: (() => void) | null = null;
  let current: MediaLike | null = null;
  return (el) => {
    if (el === current) return;
    off?.();
    current = el;
    off = el ? registry.register(el) : null;
  };
}

/**
 * «Звучит ли страница» для детектора речи: голос советника ИЛИ любой
 * зарегистрированный медиа-элемент. Глушится при перебивании только
 * советник: ролик ставит на паузу сам человек — иначе эхо дикторского
 * текста, принятое за перебивание, само останавливало бы ролик.
 */
export function withMediaPlayback(
  hint: { isPlaying: () => boolean; stop: () => void },
  registry: Pick<MediaPlaybackRegistry, 'isPlaying'> = page
): { isPlaying: () => boolean; stop: () => void } {
  return {
    isPlaying: () => hint.isPlaying() || registry.isPlaying(),
    stop: hint.stop,
  };
}

/** Звучит ли сейчас хоть один зарегистрированный элемент. */
export function isMediaPlaying(): boolean {
  return page.isPlaying();
}

/** Подписка на смену «звучит / не звучит»; вернёт отписку. */
export function onMediaPlayingChange(
  cb: (playing: boolean) => void
): () => void {
  return page.onChange(cb);
}
