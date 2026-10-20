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
import { DICTS, type Dict } from './i18n';

/**
 * Заход 9 (аудит P2-2): язык интерфейса виджета на запись голоса — один
 * источник языка для счётчиков Т-4 «расслышал / не расслышал» (сервер:
 * `site-voice.service.ts` `STT_UI_LANG_HEADER`). Язык — по словарю хоста
 * (контроллер отдаёт `DICTS[lang]`); не узнали — без заголовка.
 */
export const UI_LANG_HEADER = 'X-Assist-Lang';
export function uiLangOfDict(t: Dict): 'uk' | 'ru' | 'en' | null {
  for (const l of ['uk', 'ru', 'en'] as const) if (DICTS[l] === t) return l;
  return null;
}

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
  private recordingEpoch = 0;
  private playbackEpoch = 0;
  private sttRequest: AbortController | null = null;
  private audioRequest: AbortController | null = null;
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
    if (!cfg || this.gaveUp) {
      this.cancel();
      return this.host.setUi(voiceOff());
    }
    if (!cfg.input) this.stopRecording();
    if (!cfg.output) this.stopSpeaking();
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
    if (!this.host.ui().mic) return;
    this.host.storage('local', 'vconsent', '1');
    this.start();
  }

  private start(plan = false) {
    const cfg = this.cfg;
    const engine = this.engine;
    if (!cfg?.input || this.gaveUp) return;
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
    const epoch = ++this.recordingEpoch;
    let ended = false;
    const rec = engine.record(
      {
        ...cfg,
        // Пока ждём «да» на карточке — порог TMA 150 мс (короткое «да» —
        // законный ответ, §5-бис.7); во время плана — тоже.
        minSpeechMs: plan ? Math.min(cfg.minSpeechMs, 150) : cfg.minSpeechMs,
        onSpeech: () => {
          if (
            epoch === this.recordingEpoch &&
            this.planMode &&
            this.host.speech
          )
            this.host.speech(true);
        },
      },
      (level) => {
        if (epoch === this.recordingEpoch) this.host.setUi({ level });
      },
      (end) => {
        ended = true;
        void this.ended(end, epoch);
      }
    );
    if (!ended) this.rec = rec;
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
      if (was) this.stopRecording();
      return;
    }
    if (!this.pressedHere || !this.engine || !this.cfg || this.gaveUp) return;
    this.planMode = true;
    if (!this.rec && this.host.ui().phase !== 'sending') this.start(true);
  }

  /** Вкладку скрыли: запись бросается (озвучка доигрывает — это не микрофон). */
  hidden() {
    this.stopRecording();
  }

  /** Бросить запись без отправки: закрыли чат, ушли, другая вкладка. */
  cancel() {
    this.stopRecording();
    this.stopSpeaking();
  }

  private stopRecording() {
    this.recordingEpoch++;
    this.planMode = false;
    this.pressedHere = false;
    this.sttRequest?.abort();
    this.sttRequest = null;
    const rec = this.rec;
    this.rec = null;
    rec?.cancel();
    this.host.setUi({ phase: 'idle', level: 0 });
  }

  private stopSpeaking() {
    this.playbackEpoch++;
    this.audioRequest?.abort();
    this.audioRequest = null;
    this.engine?.stopPlayback();
    // И озвучка «в полёте»: байты придут после закрытия — не играть.
    const ui = this.host.ui();
    if (ui.playing || ui.loading)
      this.host.setUi({ playing: null, loading: null });
  }

  /** Сообщение канала вкладок. */
  onChannel(msg: string) {
    const m = /^voice-on:([a-z0-9]{1,16})$/.exec(msg);
    if (m && m[1] !== this.tab) this.stopRecording();
  }

  private async ended(end: RecordEnd, epoch: number) {
    if (epoch !== this.recordingEpoch) return;
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
    const request = new AbortController();
    this.sttRequest = request;
    try {
      const lang = uiLangOfDict(this.host.t());
      const r = await this.post(
        '/widget/v1/voice',
        end.blob.type || 'audio/webm',
        end.blob,
        lang ? { [UI_LANG_HEADER]: lang } : {},
        request.signal
      );
      const data = unwrap(r.status, await r.json().catch(() => null)) as {
        text?: unknown;
        voiceTicket?: unknown;
      };
      if (epoch !== this.recordingEpoch) return;
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
      if (epoch !== this.recordingEpoch) return;
      this.host.setUi({ phase: 'idle' });
      this.failed(e);
      // Во время плана сбой распознавания не оставляет план на паузе.
      if (this.planMode && this.host.speech) this.host.speech(false);
    } finally {
      if (this.sttRequest === request) this.sttRequest = null;
    }
  }

  // ── озвучка ─────────────────────────────────────────────────────────────

  /** «Озвучить ответ» (жест): повторное нажатие на звучащем — стоп. */
  speak(messageId: string) {
    const ui = this.host.ui();
    if (!ui.speak) return;
    const engine = this.engine;
    if (ui.playing === messageId || ui.loading === messageId) {
      return this.stopSpeaking();
    }
    if (!engine) {
      void this.ensure();
      return this.host.notify(this.host.t().voiceRetry);
    }
    this.stopSpeaking();
    engine.unlock();
    this.host.setUi({ loading: messageId, playing: null });
    void this.fetchAudio(engine, messageId, this.playbackEpoch);
  }

  private async fetchAudio(
    engine: VoiceEngine,
    messageId: string,
    epoch: number
  ) {
    const request = new AbortController();
    this.audioRequest = request;
    try {
      const r = await this.post(
        '/widget/v1/tts',
        'application/json',
        JSON.stringify({ messageId }),
        {},
        request.signal
      );
      if (!r.ok) unwrap(r.status, await r.json().catch(() => null));
      const bytes = await r.arrayBuffer();
      if (epoch !== this.playbackEpoch) return;
      this.host.setUi({ loading: null, playing: messageId });
      engine.play(bytes, () => {
        if (
          epoch === this.playbackEpoch &&
          this.host.ui().playing === messageId
        )
          this.host.setUi({ playing: null });
      });
    } catch (e) {
      if (epoch !== this.playbackEpoch) return;
      this.host.setUi({ loading: null, playing: null });
      this.failed(e);
    } finally {
      if (this.audioRequest === request) this.audioRequest = null;
    }
  }

  // ── общее ───────────────────────────────────────────────────────────────

  private async post(
    path: string,
    type: string,
    body: BodyInit,
    extra: Record<string, string> = {},
    signal?: AbortSignal
  ): Promise<Response> {
    const once = () =>
      fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: headers(this.host.auth(), { 'Content-Type': type, ...extra }),
        body,
        signal,
      });
    let r = await once();
    if (r.status === 401) {
      // Сессия истекла — один повтор с новой (как у остальных вызовов чата).
      signal?.throwIfAborted();
      await this.host.refreshSession();
      signal?.throwIfAborted();
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
