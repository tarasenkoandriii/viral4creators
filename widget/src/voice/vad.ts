/**
 * Детектор речи на устройстве (§5-бис.7: «на сервер — только речь»; «фраза
 * кончается тишиной ~1 с»; «фразы короче 0.4 с отбрасываются»). Чистый —
 * проверяется скриптом без браузера (scripts/voice.test.ts).
 *
 * Уровень — RMS сэмплов окна (0…1). Порог адаптивный: шумовой пол —
 * скользящее среднее уровня, пока речи нет; речь — уровень выше
 * max(minThreshold, пол × ratio). Так тихий ноутбук и шумная кухня
 * дают одинаковое «есть голос / нет голоса».
 */
export interface VadOptions {
  minSpeechMs: number;
  endSilenceMs: number;
  maxMs: number;
  /** Абсолютный минимум порога речи (RMS). */
  minThreshold?: number;
  /** Во сколько раз речь громче шумового пола. */
  ratio?: number;
  /**
   * Первые мс записи — только шумовой пол: человек начинает говорить через
   * ~0.3 с после нажатия, а гул комнаты иначе сразу сошёл бы за речь.
   */
  calibrateMs?: number;
  /**
   * Э6-бис: множитель порога в моменте — пока звучит собственная озвучка
   * помощника, порог выше (порог перебивания `bargeInFactor` TMA,
   * §5-бис.5): своя реплика не ставит план на паузу.
   */
  boost?: () => number;
}

export type VadStep = 'listen' | 'end' | 'max';

export class Vad {
  speechMs = 0;
  private started = -1;
  private lastSpeech = -1;
  private lastT = -1;
  private floor = 0;
  private readonly minThreshold: number;
  private readonly ratio: number;
  private readonly calibrateMs: number;

  constructor(private readonly o: VadOptions) {
    this.minThreshold = o.minThreshold ?? 0.02;
    this.ratio = o.ratio ?? 2.5;
    this.calibrateMs = o.calibrateMs ?? 200;
  }

  get heardSpeech(): boolean {
    return this.lastSpeech >= 0;
  }

  /** Окно уровня `level` в момент `t` (мс от начала записи). */
  push(level: number, t: number): VadStep {
    if (this.started < 0) this.started = t;
    const dt = this.lastT < 0 ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const threshold =
      Math.max(this.minThreshold, this.floor * this.ratio) *
      (this.o.boost ? this.o.boost() : 1);
    const calibrating = t - this.started < this.calibrateMs;
    if (!calibrating && level > threshold) {
      this.speechMs += dt;
      this.lastSpeech = t;
    } else {
      // Шумовой пол учится только на тишине: речь его не поднимает.
      this.floor = this.floor === 0 ? level : this.floor * 0.9 + level * 0.1;
    }
    if (t - this.started >= this.o.maxMs) return 'max';
    if (
      this.lastSpeech >= 0 &&
      this.speechMs >= this.o.minSpeechMs &&
      t - this.lastSpeech >= this.o.endSilenceMs
    )
      return 'end';
    return 'listen';
  }
}

/** RMS окна сэмплов float (-1…1). */
export function rms(samples: Float32Array): number {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return samples.length ? Math.sqrt(s / samples.length) : 0;
}

/**
 * Формат записи: Opus в webm/ogg (Chrome, Firefox, Android), AAC в mp4
 * (Safari и iOS — webm он не пишет). Первый поддержанный; пусто —
 * пусть браузер выберет сам (сервер примет любой audio/* из списка).
 */
export const RECORD_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const;

export function pickMime(isSupported: (m: string) => boolean): string {
  for (const m of RECORD_MIMES) {
    try {
      if (isSupported(m)) return m;
    } catch {
      /* старый Safari бросает на неизвестном типе */
    }
  }
  return '';
}
