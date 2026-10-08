/**
 * Проигрыватель примера голоса для раздела «Голос» (VoiceSection; заход 10,
 * Р-З10-3 (в)). Две беды прежнего `await sample → new Audio().play()`:
 *  1. `play()` после `await` — уже вне жеста пользователя: Safari/iOS и
 *     WebView Telegram отвечают NotAllowedError, пример молчит;
 *  2. при уходе с экрана звук не гаснет (unmount только отзывал URL), а
 *     повторное нажатие запускало второй звук поверх первого.
 *
 * Решение: ОДИН элемент на раздел. `prime()` синхронно в обработчике
 * нажатия «разблокирует» его коротким беззвучным WAV (blob: — CSP TMA
 * разрешает `media-src blob:`, data: — нет), потом тот же элемент получает
 * пример. Если браузер всё же отказал — пример остаётся в памяти, и второе
 * нажатие проигрывает его СИНХРОННО в жесте (`replay`) без нового запроса.
 * `stop()` — `pause()` + `removeAttribute('src')` + `load()` (сброс элемента
 * без запроса пустого/текущего URL; повтор и уход с экрана), `dispose()`
 * ещё и отзывает URL. Чистый модуль без React: тест — scripts/sample-player.test.ts.
 */

export interface AudioLike {
  src: string;
  play(): Promise<void>;
  pause(): void;
  /** HTMLMediaElement: снять источник без запроса пустого URL (аудит P3-10). */
  removeAttribute(name: 'src'): void;
  load(): void;
}

export interface SamplePlayerDeps {
  createAudio(): AudioLike;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
}

export type PlayOutcome = 'played' | 'blocked';

/** Беззвучный WAV: 8 кГц, 8 бит, моно, 80 отсчётов (10 мс тишины). */
export function silentWav(): Blob {
  const samples = 80;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // моно
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  ascii(36, 'data');
  v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128); // 8 бит: 128 = 0
  return new Blob([buf], { type: 'audio/wav' });
}

function isNotAllowed(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'NotAllowedError'
  );
}

export class SamplePlayer {
  private el: AudioLike | null = null;
  private url: string | null = null;
  private key: string | null = null;
  private silentUrl: string | null = null;
  private disposed = false;

  constructor(private readonly deps: SamplePlayerDeps) {}

  private audio(): AudioLike {
    if (!this.el) this.el = this.deps.createAudio();
    return this.el;
  }

  /** Пример для этого ключа (голос + язык) уже в памяти. */
  has(key: string): boolean {
    return !this.disposed && this.key === key && this.url !== null;
  }

  /**
   * СИНХРОННО в обработчике нажатия, до любого `await`: остановить
   * прежний звук и разблокировать элемент беззвучным звуком.
   */
  prime(): void {
    if (this.disposed) return;
    this.stop();
    const a = this.audio();
    if (!this.silentUrl) this.silentUrl = this.deps.createUrl(silentWav());
    a.src = this.silentUrl;
    a.play().catch(() => undefined);
  }

  /** Пример пришёл (после `await`): тот же элемент, новый источник. */
  async load(key: string, blob: Blob): Promise<PlayOutcome> {
    if (this.disposed) return 'blocked';
    this.stop();
    if (this.url) this.deps.revokeUrl(this.url);
    this.url = this.deps.createUrl(blob);
    this.key = key;
    return this.start();
  }

  /** Повтор из памяти — синхронно в жесте (второе нажатие). */
  replay(): Promise<PlayOutcome> {
    if (this.disposed || !this.url) return Promise.resolve('blocked');
    this.stop();
    return this.start();
  }

  private async start(): Promise<PlayOutcome> {
    const a = this.audio();
    a.src = this.url ?? '';
    try {
      await a.play();
      return 'played';
    } catch (e) {
      // Ушли с экрана/нажали повтор, пока звук запускался, — не ошибка.
      if (isNotAllowed(e) || this.disposed) return 'blocked';
      if ((e as { name?: unknown })?.name === 'AbortError') return 'blocked';
      throw e;
    }
  }

  /** Остановить звук (повтор, уход с экрана). */
  stop(): void {
    const a = this.el;
    if (!a) return;
    a.pause();
    a.removeAttribute('src');
    a.load();
  }

  /** Уход с экрана: тишина и освобождение URL. */
  dispose(): void {
    this.stop();
    this.disposed = true;
    if (this.url) this.deps.revokeUrl(this.url);
    if (this.silentUrl) this.deps.revokeUrl(this.silentUrl);
    this.url = null;
    this.silentUrl = null;
    this.key = null;
    this.el = null;
  }
}
