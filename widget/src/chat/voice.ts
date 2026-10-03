/**
 * Голос в iframe-чате (Э5, ТЗ помощника §4.10, §4-бис.6, §4-бис.10 п.5,
 * §5-бис.7, Р-28, Р-29) — сторона чата; запись и звук — ленивый чанк
 * `/v1/voice.js` (src/voice/), в загрузчик и в chat.js не входит.
 *
 *  - Микрофон — ТОЛЬКО по нажатию (push-to-talk): первое нажатие — согласие,
 *    которое называет, кто слушает («ИИ-помощник сайта, запись уходит на
 *    распознавание и сразу удаляется»); согласие — в localStorage iframe
 *    (наш origin), не на странице заказчика.
 *  - Пока пишем — видимый индикатор (точка, таймер, уровень, «Стоп»);
 *    закрыли чат, ушли со вкладки или включили микрофон в другой вкладке
 *    (BroadcastChannel, §4-бис.10 п.5) — запись бросается без отправки.
 *  - После перезагрузки микрофон сам не открывается (Р-28): флаг «был
 *    включён» — в sessionStorage iframe, кнопка — в состоянии «на паузе».
 *  - Запись → `POST /widget/v1/voice` (сырые байты) → текст и билет →
 *    обычный вопрос чата с `voiceTicket` (диалог весом 2 — решает сервер).
 *    Звук нигде не сохраняется: Blob живёт до ответа сервера.
 *  - Исчерпан потолок голоса / голос выключен — ОДНО уведомление, кнопки
 *    голоса пропадают до перезагрузки, чат работает текстом (приёмка Э5 п.2).
 */
import type {
  CreateVoice,
  RecordEnd,
  Recording,
  RecordLimits,
  VoiceEngine,
} from '../shared/voice-api';
import { ApiError, CHUNK_BASE, headers, unwrap, type Auth } from './api';
import type { Dict } from './i18n';

/**
 * Чанк голоса — тот же origin, путь стабильный (кэш — vercel.json); (г)
 * канарейка — из каталога выпуска, откуда загружен сам чат.
 */
export const VOICE_CHUNK_PATH = `${CHUNK_BASE}voice.js`;

export interface VoiceUi {
  /** Кнопка микрофона (конфиг сайта + браузер умеет записывать). */
  mic: boolean;
  /** Кнопка «озвучить ответ». */
  speak: boolean;
  phase: 'idle' | 'paused' | 'consent' | 'recording' | 'sending';
  /** Уровень 0…1 для индикатора записи. */
  level: number;
  /** Начало записи (ms) — таймер индикатора. */
  since: number;
  /** id ответа, который сейчас звучит / грузится. */
  playing: string | null;
  loading: string | null;
}

export function voiceOff(): VoiceUi {
  return {
    mic: false,
    speak: false,
    phase: 'idle',
    level: 0,
    since: 0,
    playing: null,
    loading: null,
  };
}

/** Что голосу нужно от контроллера чата (узкий стык — тест без DOM). */
export interface VoiceHost {
  ui(): VoiceUi;
  setUi(p: Partial<VoiceUi>): void;
  t(): Dict;
  notify(text: string): void;
  auth(): Auth;
  refreshSession(): Promise<void>;
  ask(text: string, ticket: string | null): void;
  /** Э6-бис: начало речи во время плана — пауза (детектор на устройстве). */
  speech?(on: boolean): void;
  /** Э6-бис: фраза, сказанная во время плана («стоп», «да», новая команда). */
  planText?(text: string, ticket: string | null): void;
  storage(
    kind: 'local' | 'session',
    name: string,
    value?: string | null
  ): string | null;
  broadcast(msg: string): void;
}

export interface VoiceCfg extends RecordLimits {
  input: boolean;
  output: boolean;
}

/** Коды сервера, после которых голос до перезагрузки не предлагаем. */
const GIVE_UP = ['VOICE_LIMIT', 'VOICE_UNAVAILABLE'];

export class VoiceController {
  private engine: VoiceEngine | null = null;
  private loading: Promise<VoiceEngine | null> | null = null;
  private rec: Recording | null = null;
  private cfg: VoiceCfg | null = null;
  private gaveUp = false;
  /**
   * Э6-бис: микрофон держится открытым на время плана — только если человек
   * САМ нажал микрофон в этом документе (после перехода — нет, Р-28).
   */
  private pressedHere = false;
  private planMode = false;
  /** id вкладки — отличить своё сообщение канала от чужого. */
  readonly tab = Math.random().toString(36).slice(2, 10);

  constructor(
    private readonly host: VoiceHost,
    private readonly load: () => Promise<{ createVoice: CreateVoice }> = () =>
      import(/* @vite-ignore */ VOICE_CHUNK_PATH) as Promise<{
        createVoice: CreateVoice;
      }>
  ) {}

  /** Конфиг сайта получен: показать кнопки и заранее загрузить чанк. */
  configure(cfg: VoiceCfg | null) {
    this.cfg = cfg;
    if (!cfg || this.gaveUp) return this.host.setUi(voiceOff());
    const md =
      typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    const canMic =
      cfg.input &&
      !!md &&
      typeof md.getUserMedia === 'function' &&
      typeof MediaRecorder === 'function';
    const armed = this.host.storage('session', 'voice') === 'armed';
    this.host.setUi({
      mic: canMic,
      speak: cfg.output,
      phase: canMic && armed ? 'paused' : 'idle',
    });
    if (canMic || cfg.output) void this.ensure();
  }

  private ensure(): Promise<VoiceEngine | null> {
    if (this.engine) return Promise.resolve(this.engine);
    if (!this.loading)
      this.loading = this.load()
        .then((m) => (this.engine = m.createVoice()))
        .catch(() => {
          this.loading = null;
          return null;
        });
    return this.loading;
  }

  // ── микрофон ────────────────────────────────────────────────────────────

  /** Нажатие кнопки микрофона (жест пользователя). */
  press() {
    const ui = this.host.ui();
    if (!ui.mic || ui.phase === 'sending') return;
    if (ui.phase === 'recording') return this.rec?.stop();
    if (this.host.storage('local', 'vconsent') !== '1')
      return this.host.setUi({ phase: 'consent' });
    this.start();
  }

  consent(ok: boolean) {
    if (!ok) return this.host.setUi({ phase: 'idle' });
    this.host.storage('local', 'vconsent', '1');
    this.start();
  }

  private start(plan = false) {
    const cfg = this.cfg;
    const engine = this.engine;
    if (!cfg) return;
    if (!plan) this.pressedHere = true;
    if (!engine) {
      // Чанк ещё не пришёл: догрузить и попросить нажать ещё раз (жест
      // пользователя к этому времени истёк — Safari микрофон не даст).
      void this.ensure();
      this.host.setUi({ phase: 'idle' });
      return this.host.notify(this.host.t().voiceRetry);
    }
    engine.unlock();
    this.host.broadcast(`voice-on:${this.tab}`);
    this.host.storage('session', 'voice', 'armed');
    this.host.setUi({ phase: 'recording', since: Date.now(), level: 0 });
    this.rec = engine.record(
      {
        ...cfg,
        // Пока ждём «да» на карточке — порог TMA 150 мс (короткое «да» —
        // законный ответ, §5-бис.7); во время плана — тоже.
        minSpeechMs: plan ? Math.min(cfg.minSpeechMs, 150) : cfg.minSpeechMs,
        onSpeech: () => {
          if (this.planMode && this.host.speech) this.host.speech(true);
        },
      },
      (level) => this.host.setUi({ level }),
      (end) => void this.ended(end)
    );
  }

  /**
   * Э6-бис (§5-бис.5): на время плана микрофон открыт (видимый индикатор),
   * любое начало речи — пауза плана ещё до распознавания; фраза уходит на
   * распознавание только пока план идёт. Только в документе, где человек
   * сам нажал микрофон.
   */
  planListen(on: boolean) {
    if (!on) {
      const was = this.planMode;
      this.planMode = false;
      if (was && this.rec) this.rec.cancel();
      return;
    }
    if (!this.pressedHere || !this.engine || !this.cfg || this.gaveUp) return;
    this.planMode = true;
    if (!this.rec) this.start(true);
  }

  /** Вкладку скрыли: запись бросается (озвучка доигрывает — это не микрофон). */
  hidden() {
    if (this.rec) this.rec.cancel();
  }

  /** Бросить запись без отправки: закрыли чат, ушли, другая вкладка. */
  cancel() {
    if (this.rec) this.rec.cancel();
    this.engine?.stopPlayback();
    // И озвучка «в полёте»: байты придут после закрытия — не играть.
    const ui = this.host.ui();
    if (ui.playing || ui.loading)
      this.host.setUi({ playing: null, loading: null });
  }

  /** Сообщение канала вкладок. */
  onChannel(msg: string) {
    const m = /^voice-on:([a-z0-9]{1,16})$/.exec(msg);
    if (m && m[1] !== this.tab && this.rec) this.rec.cancel();
  }

  private async ended(end: RecordEnd) {
    this.rec = null;
    const t = this.host.t();
    if (end.reason === 'cancel')
      return this.host.setUi({ phase: 'idle', level: 0 });
    if (end.reason === 'short') {
      this.host.setUi({ phase: 'idle', level: 0 });
      if (this.planMode) {
        // Шум во время плана — снять паузу и слушать дальше, без уведомления.
        if (this.host.speech) this.host.speech(false);
        return this.start(true);
      }
      return this.host.notify(t.voiceNotHeard);
    }
    if (end.reason === 'error') this.planMode = false;
    if (end.reason === 'error') {
      this.host.setUi({ phase: 'idle', level: 0 });
      return this.host.notify(
        end.code === 'denied' ? t.micDenied : t.micFailed
      );
    }
    this.host.setUi({ phase: 'sending', level: 0 });
    try {
      const r = await this.post(
        '/widget/v1/voice',
        end.blob.type || 'audio/webm',
        end.blob
      );
      const data = unwrap(r.status, await r.json().catch(() => null)) as {
        text?: unknown;
        voiceTicket?: unknown;
      };
      this.host.setUi({ phase: 'idle' });
      const text =
        typeof data.text === 'string' ? data.text.trim().slice(0, 600) : '';
      const ticket =
        typeof data.voiceTicket === 'string' && data.voiceTicket.length <= 200
          ? data.voiceTicket
          : null;
      if (this.planMode && this.host.planText) {
        this.host.planText(text, ticket);
        // План ещё идёт — слушаем дальше («стоп» голосом доступен).
        if (this.planMode && !this.rec) this.start(true);
        return;
      }
      if (!text) return this.host.notify(t.voiceNotHeard);
      this.host.ask(text, ticket);
    } catch (e) {
      this.host.setUi({ phase: 'idle' });
      this.failed(e);
      // Во время плана сбой распознавания не оставляет план на паузе.
      if (this.planMode && this.host.speech) this.host.speech(false);
    }
  }

  // ── озвучка ─────────────────────────────────────────────────────────────

  /** «Озвучить ответ» (жест): повторное нажатие на звучащем — стоп. */
  speak(messageId: string) {
    const ui = this.host.ui();
    if (!ui.speak) return;
    const engine = this.engine;
    if (ui.playing === messageId || ui.loading === messageId) {
      engine?.stopPlayback();
      return this.host.setUi({ playing: null, loading: null });
    }
    if (!engine) {
      void this.ensure();
      return this.host.notify(this.host.t().voiceRetry);
    }
    engine.stopPlayback();
    engine.unlock();
    this.host.setUi({ loading: messageId, playing: null });
    void this.fetchAudio(engine, messageId);
  }

  private async fetchAudio(engine: VoiceEngine, messageId: string) {
    try {
      const r = await this.post(
        '/widget/v1/tts',
        'application/json',
        JSON.stringify({ messageId })
      );
      if (!r.ok) unwrap(r.status, await r.json().catch(() => null));
      const bytes = await r.arrayBuffer();
      if (this.host.ui().loading !== messageId) return; // нажали «стоп»
      this.host.setUi({ loading: null, playing: messageId });
      engine.play(bytes, () => {
        if (this.host.ui().playing === messageId)
          this.host.setUi({ playing: null });
      });
    } catch (e) {
      this.host.setUi({ loading: null, playing: null });
      this.failed(e);
    }
  }

  // ── общее ───────────────────────────────────────────────────────────────

  private async post(
    path: string,
    type: string,
    body: BodyInit
  ): Promise<Response> {
    const once = () =>
      fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: headers(this.host.auth(), { 'Content-Type': type }),
        body,
      });
    let r = await once();
    if (r.status === 401) {
      // Сессия истекла — один повтор с новой (как у остальных вызовов чата).
      await this.host.refreshSession();
      r = await once();
    }
    return r;
  }

  private failed(e: unknown) {
    const t = this.host.t();
    const code = e instanceof ApiError ? e.code : 'NETWORK';
    if (GIVE_UP.indexOf(code) >= 0) {
      if (this.gaveUp) return;
      this.gaveUp = true;
      this.cancel();
      this.host.setUi(voiceOff());
      return this.host.notify(
        code === 'VOICE_LIMIT' ? t.voiceLimit : t.voiceUnavailable
      );
    }
    this.host.notify(
      code === 'VOICE_NOT_HEARD'
        ? t.voiceNotHeard
        : code === 'RATE_LIMITED'
          ? t.errRate
          : t.voiceFailed
    );
  }
}
