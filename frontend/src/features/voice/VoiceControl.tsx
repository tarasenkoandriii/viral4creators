import { Mic, MicOff, Square } from 'lucide-react';
import { Button } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { micOpen, type ListenState } from '../../lib/voice-listen-mode';

/**
 * Кнопка «управление голосом» и индикатор открытого микрофона — условие 3
 * решения В-15 ТЗ Greeting 2.0 §4А.7.5: открытый микрофон видно ВСЕГДА,
 * и выключается он одним касанием.
 *
 * Индикатор — не значок в углу, а строка с текстом и кнопкой «Выключить»
 * рядом: человек должен понять, что его слушают, не зная, что значит
 * красная точка. Панель, в которой он стоит, прилипает к низу экрана
 * (`VoiceAssistant`), поэтому не уезжает при прокрутке мастера.
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
      <div className="flex items-center justify-between gap-2" role="status">
        <span className="flex items-center gap-2 text-sm font-medium text-rose-600 dark:text-rose-400">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" />
          {v.talkSpeakNow}
        </span>
        <Button size="sm" icon={<Square size={14} />} onClick={onTalkStop}>
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
      <div className="flex items-center justify-between gap-2" role="status">
        <span
          className="flex items-center gap-2 text-sm font-medium text-rose-600 dark:text-rose-400"
          aria-label={v.micOpen}
        >
          <span
            className={`h-2.5 w-2.5 rounded-full bg-rose-500 ${
              phase === 'recording' ? 'animate-pulse' : ''
            }`}
          />
          <Mic size={14} />
          {label}
        </span>
        <Button
          size="sm"
          variant="danger"
          icon={<MicOff size={14} />}
          onClick={onDisable}
        >
          {v.turnOff}
        </Button>
      </div>
    );
  }

  // Микрофон закрыт: «управление голосом» ждёт нажатия (В-15), рядом —
  // ручной путь одной фразой.
  return (
    <div className="space-y-2">
      {state.notice === 'idle' && (
        <p className="text-xs text-silver-400" role="status">
          {v.idleStopped}
        </p>
      )}
      {state.notice === 'denied' && (
        <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
          {v.denied}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Mic size={14} />} onClick={onEnable}>
          {v.controlButton}
        </Button>
        <Button size="sm" variant="outline" onClick={onTalkStart}>
          {v.talkOnce}
        </Button>
      </div>
    </div>
  );
}
