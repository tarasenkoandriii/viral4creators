import { useLayoutEffect, useRef, type FocusEvent } from 'react';
import { Mic, MicOff, Square } from 'lucide-react';
import { Button } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import {
  micOpen,
  type ListenPhase,
  type ListenState,
} from '../../lib/voice-listen-mode';

/** Какой набор кнопок на экране: сменился — фокус переходит на новый. */
function controlMode(phase: ListenPhase): 'off' | 'open' | 'holding' | 'none' {
  if (phase === 'blocked' || phase === 'unsupported') return 'none';
  if (phase === 'holding') return 'holding';
  return micOpen(phase) ? 'open' : 'off';
}

/**
 * Кнопка «управление голосом» и индикатор открытого микрофона — условие 3
 * решения В-15 ТЗ Greeting 2.0 §4А.7.5: открытый микрофон видно ВСЕГДА,
 * и выключается он одним касанием.
 *
 * Индикатор — не значок в углу, а строка с текстом и кнопкой «Выключить»
 * рядом: человек должен понять, что его слушают, не зная, что значит
 * красная точка. Панель, в которой он стоит, прилипает к низу экрана
 * (`VoiceAssistant`), поэтому не уезжает при прокрутке мастера.
 *
 * Доступность (финальный аудит): фаза («слушаю», «слышу», «разбираю»)
 * меняется каждые секунды — живой областью её не объявляем, иначе
 * читалка тонула бы в шуме; ответы помощника объявляет `VoiceAssistant`.
 * Кнопка, которой человек только что пользовался, при смене набора
 * исчезает — фокус переходит на новую главную кнопку, а не в начало
 * страницы.
 */
export function VoiceControl({
  state,
  onEnable,
  onDisable,
  onTalkStart,
  onTalkStop,
}: {
  state: ListenState;
  onEnable: () => void;
  onDisable: () => void;
  onTalkStart: () => void;
  onTalkStop: () => void;
}) {
  const { dict } = useI18n();
  const v = dict.voiceAssistant;
  const { phase } = state;
  const mode = controlMode(phase);

  // Фокус был на кнопках панели (нажали или дошли табом) — после смены
  // набора он на новой главной кнопке. Ушёл сам (таб дальше) — не
  // возвращаем: панель не отнимает фокус у того, кто работает с формой.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hadFocusRef = useRef(false);
  const modeRef = useRef(mode);
  useLayoutEffect(() => {
    if (modeRef.current === mode) return;
    modeRef.current = mode;
    if (!hadFocusRef.current) return;
    const active = document.activeElement;
    // Фокус уже где-то осознанно (не на исчезнувшей кнопке) — не трогаем.
    if (
      active &&
      active !== document.body &&
      !wrapRef.current?.contains(active)
    )
      return;
    wrapRef.current
      ?.querySelector<HTMLButtonElement>('[data-voice-primary]')
      ?.focus();
  }, [mode]);
  const focusProps = {
    ref: wrapRef,
    onFocus: () => {
      hadFocusRef.current = true;
    },
    onBlur: (e: FocusEvent<HTMLDivElement>) => {
      // Фокус ушёл за пределы панели — человек сам ушёл дальше.
      if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
        hadFocusRef.current = false;
    },
  };

  // Потолок (В-14) — микрофона нет до завтра, и сказано об этом один раз
  // на страницу (общий `claimVoiceBudgetNotice`): строки здесь нет, иначе
  // уведомление повторялось бы при каждом открытии мастера.
  if (phase === 'blocked') return null;

  if (phase === 'unsupported') {
    return (
      <p className="text-xs text-silver-400" role="status">
        <MicOff size={12} className="mr-1 inline" />
        {v.unsupported}
      </p>
    );
  }

  if (phase === 'holding') {
    return (
      <div className="flex items-center justify-between gap-2" {...focusProps}>
        <span className="flex items-center gap-2 text-sm font-medium text-rose-600 dark:text-rose-400">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" />
          <span className="sr-only">{v.micOpen}. </span>
          {v.talkSpeakNow}
        </span>
        <Button
          size="sm"
          icon={<Square size={14} />}
          onClick={onTalkStop}
          data-voice-primary
        >
          {v.talkDone}
        </Button>
      </div>
    );
  }

  if (micOpen(phase)) {
    const label =
      phase === 'requesting'
        ? v.requesting
        : phase === 'recording'
          ? v.recording
          : phase === 'processing'
            ? v.processing
            : v.listening;
    return (
      <div className="flex items-center justify-between gap-2" {...focusProps}>
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 text-sm font-medium text-rose-600 dark:text-rose-400">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full bg-rose-500 ${
                phase === 'recording' ? 'animate-pulse' : ''
              }`}
            />
            <Mic size={14} aria-hidden="true" />
            {/* Значок и точка читалке ничего не скажут — словами. */}
            <span className="sr-only">{v.micOpen}. </span>
            {label}
          </span>
          {/* Во время разбора детектор на паузе: сказанное сейчас не
              услышат (изменение контракта 4). */}
          {phase === 'processing' && (
            <span className="text-xs text-silver-400">{v.processingWait}</span>
          )}
        </span>
        <Button
          size="sm"
          variant="danger"
          icon={<MicOff size={14} />}
          onClick={onDisable}
          data-voice-primary
        >
          {v.turnOff}
        </Button>
      </div>
    );
  }

  // Микрофон закрыт: «управление голосом» ждёт нажатия (В-15), рядом —
  // ручной путь одной фразой.
  return (
    <div className="space-y-2" {...focusProps}>
      {state.notice === 'idle' && (
        <p className="text-xs text-silver-400" role="status">
          {v.idleStopped}
        </p>
      )}
      {state.notice === 'recording-error' && (
        <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
          {v.recordingError}
        </p>
      )}
      {state.notice === 'denied' && (
        <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
          {v.denied}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          icon={<Mic size={14} />}
          onClick={onEnable}
          data-voice-primary
        >
          {v.controlButton}
        </Button>
        <Button size="sm" variant="outline" onClick={onTalkStart}>
          {v.talkOnce}
        </Button>
      </div>
    </div>
  );
}
