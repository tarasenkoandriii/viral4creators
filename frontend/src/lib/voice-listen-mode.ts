/**
 * Режим прослушивания — решение В-15 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.5.
 *
 * Сценарий владельца: у включившего «голосом» микрофон открывается с
 * открытием вкладки, гаснет после 20 с тишины, дальше ждёт кнопка
 * «управление голосом». Три условия:
 *   1. только у включивших голос, и ПЕРВОЕ включение — нажатием;
 *   2. на сервер — только речь (`voice-listen.ts`);
 *   3. открытый микрофон виден всегда и выключается одним касанием.
 *
 * Здесь — конечный автомат режима и решение «слушать ли сразу».
 * Чистый: хук `useVoiceListening` только исполняет переходы (открыть
 * поток, запустить запись), а какие переходы допустимы — решается тут и
 * проверяется `scripts/voice-listen-mode.test.ts`.
 */

export type ListenPhase =
  /** Микрофон закрыт; кнопка «управление голосом» ждёт нажатия. */
  | 'off'
  /** Ждём `getUserMedia` (окно разрешения, если браузер его покажет). */
  | 'requesting'
  /** Микрофон открыт, детектор ждёт речь. */
  | 'listening'
  /** Идёт фраза — пишем отрезок. */
  | 'recording'
  /** Отрезок ушёл на разбор; детектор на паузе, поток открыт. */
  | 'processing'
  /** «Удерживайте и говорите» — ручная запись без детектора. */
  | 'holding'
  /** Потолок голоса на сегодня (В-14) — до завтра руками. */
  | 'blocked'
  /** Браузер не умеет записывать звук. */
  | 'unsupported';

export interface ListenState {
  phase: ListenPhase;
  /** Куда вернуться после разбора: в прослушивание или к кнопке. */
  resumeTo: 'listening' | 'off';
  /** Почему микрофон закрыт — чтобы сказать об этом, а не молчать. */
  notice: 'idle' | 'denied' | null;
  /**
   * Номер отрезка на разборе. Растёт при каждой отправке и при каждом
   * выключении: ответ приходит асинхронно, и `processed` со старым
   * номером — ответ на то, что человек уже отменил или перебил новым
   * отрезком (аудит волны 1). Такой ответ не должен ни открывать
   * микрофон, ни показываться.
   */
  seq: number;
}

export type ListenEvent =
  | { type: 'enable' }
  | { type: 'granted' }
  | { type: 'denied' }
  | { type: 'speech-start' }
  | { type: 'utterance'; keep: boolean }
  | { type: 'idle-timeout' }
  | { type: 'hold-start' }
  | { type: 'hold-end'; keep: boolean }
  | { type: 'processed'; seq: number }
  | { type: 'disable' }
  | { type: 'budget-exhausted' };

export const LISTEN_INITIAL: ListenState = {
  phase: 'off',
  resumeTo: 'off',
  notice: null,
  seq: 0,
};

export function listenReducer(
  state: ListenState,
  event: ListenEvent
): ListenState {
  const { phase } = state;
  // Потолок и неподдержка — конечные состояния до перезагрузки: ни
  // кнопка, ни автозапуск не должны открывать микрофон, который тут же
  // получит 403 или упадёт.
  if (phase === 'blocked' || phase === 'unsupported') return state;
  switch (event.type) {
    case 'enable':
      return phase === 'off'
        ? { ...state, phase: 'requesting', resumeTo: 'listening', notice: null }
        : state;
    case 'granted':
      return phase === 'requesting' ? { ...state, phase: 'listening' } : state;
    case 'denied':
      return phase === 'requesting' || phase === 'holding'
        ? { ...state, phase: 'off', resumeTo: 'off', notice: 'denied' }
        : state;
    case 'speech-start':
      return phase === 'listening' ? { ...state, phase: 'recording' } : state;
    case 'utterance':
      if (phase !== 'recording') return state;
      return event.keep
        ? { ...state, phase: 'processing', seq: state.seq + 1 }
        : { ...state, phase: 'listening' };
    case 'idle-timeout':
      // Условие В-15: 20 с тишины → микрофон гаснет, кнопка ждёт.
      return phase === 'listening'
        ? { ...state, phase: 'off', resumeTo: 'off', notice: 'idle' }
        : state;
    case 'hold-start':
      // Ручной путь — только когда прослушивание выключено: при открытом
      // микрофоне детектор и так поймает фразу, а две записи одного
      // голоса — два платных разбора.
      return phase === 'off'
        ? { ...state, phase: 'holding', resumeTo: 'off', notice: null }
        : state;
    case 'hold-end':
      if (phase !== 'holding') return state;
      return event.keep
        ? { ...state, phase: 'processing', seq: state.seq + 1 }
        : { ...state, phase: 'off' };
    case 'processed':
      return phase === 'processing' && event.seq === state.seq
        ? { ...state, phase: state.resumeTo }
        : state;
    case 'disable':
      // Одно касание гасит микрофон из ЛЮБОГО открытого состояния
      // (условие 3) — в том числе посреди фразы и во время разбора.
      return phase === 'off'
        ? state
        : { ...LISTEN_INITIAL, seq: state.seq + 1 };
    case 'budget-exhausted':
      return {
        phase: 'blocked',
        resumeTo: 'off',
        notice: null,
        seq: state.seq + 1,
      };
  }
}

/**
 * Ответ на отрезок `seq` ещё нужен: отрезок последний, и его не отменили
 * выключением или потолком.
 */
export function isCurrentUtterance(state: ListenState, seq: number): boolean {
  return state.phase === 'processing' && state.seq === seq;
}

/** Микрофон сейчас открыт — индикатор обязан быть на экране. */
export function micOpen(phase: ListenPhase): boolean {
  return (
    phase === 'requesting' ||
    phase === 'listening' ||
    phase === 'recording' ||
    phase === 'processing' ||
    phase === 'holding'
  );
}

export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/**
 * Слушать ли сразу при открытии вкладки (условие 1 В-15).
 *
 * `armed` — человек хоть раз САМ включил прослушивание нажатием и дал
 * разрешение. Но и тогда микрофон открывается сам, только если браузер
 * ПОДТВЕРЖДАЕТ, что разрешение есть (`granted`): Telegram на iOS
 * спрашивает в каждой сессии, и окно разрешения, выскочившее без
 * нажатия, — прямой путь к «Запретить» навсегда. Не знаем (нет
 * Permissions API) — ждём нажатия: лишнее касание дешевле запрета.
 */
export function autoListenDecision(opts: {
  voiceOn: boolean;
  armed: boolean;
  permission: MicPermission;
  blocked: boolean;
  supported: boolean;
}): 'listen' | 'wait-tap' | 'off' {
  if (!opts.voiceOn || opts.blocked || !opts.supported) return 'off';
  return opts.armed && opts.permission === 'granted' ? 'listen' : 'wait-tap';
}
