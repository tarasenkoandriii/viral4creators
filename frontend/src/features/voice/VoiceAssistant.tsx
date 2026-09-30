import { useEffect, useRef, useState } from 'react';
import { Card } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import {
  CONFIRM_INITIAL,
  applyOutcomeLine,
  confirmReducer,
  pendingForServer,
  type ConfirmEvent,
  type ConfirmState,
} from '../../lib/voice-confirm';
import {
  K3_INTENT_HANDLERS,
  dispatchVoiceResult,
} from '../../lib/voice-intents';
import { voiceStatusOutcome } from '../../lib/voice-status';
import {
  claimVoiceBudgetNotice,
  isHintPlaying,
  isVoiceBudgetExhaustedToday,
  markVoiceBudgetExhausted,
  stopHint,
} from '../../lib/hint-audio-session';
import type { VoiceStepId } from '../../lib/voice-types';
import { understandVoice } from '../../services/greeting-voice-api';
import { VoiceConfirmCard } from './VoiceConfirmCard';
import { VoiceControl } from './VoiceControl';
import { useVoiceCommands, voiceConsentTarget } from './voice-commands';
import { consentRoute } from '../../lib/voice-consent';
import { useVoiceListening } from './useVoiceListening';
import { stepSectionInView, useFocusedCard } from './voice-focus';
import { useHelp } from '../projects/help-context';
import type { GreetingStepId } from '../../lib/greeting-steps';
import { withNavHelpHandlers, type VoiceNavState } from '../../lib/voice-nav';
import { withMediaPlayback } from '../../lib/media-playback';

/**
 * Голосовой помощник мастера поздравления — клиент этапа K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2, §4А.7.5.
 *
 * Связывает три куска: прослушивание (`useVoiceListening`, В-15), разбор
 * на сервере (`understandVoice`) и реестр полей экрана
 * (`voice-commands.ts`). Сам ничего в бриф не пишет: разобранное идёт на
 * карточку «я понял так», и только «Да» отдаёт его карточкам через те же
 * обработчики, что у ручного ввода.
 *
 * Монтируется, только пока «голосом» включён: снятие компонента
 * закрывает микрофон (`useVoiceListening`), так что выключенный голос —
 * это гарантированно закрытый микрофон, а не флаг внутри открытого.
 *
 * Реплику советника (K1) озвучивает `HintLine`; здесь — только текст
 * ответа на сказанное.
 */

/** Голос советника — микрофон не пишет его и глушит при перебивании. */
// Плюс ролики страницы (справка, готовое поздравление) — их звук тоже не
// речь человека (`media-playback.ts`, аудит волны 2).
const HINT_PLAYBACK = withMediaPlayback({
  isPlaying: isHintPlaying,
  stop: stopHint,
});

/** Карточка шага по умолчанию — если фокус ни в одной из карточек. */
const STEP_CARD: Record<VoiceStepId, string> = {
  brief: 'greeting-brief-card',
  references: 'greeting-references-card',
  script: 'greeting-script-card',
  video: 'greeting-video-card',
};

// Карточка в фокусе (контекст разбора и тема справки) — `useFocusedCard`
// (K6): последняя тронутая карточка, иначе самая видимая, иначе карточка
// шага. Прежний `document.activeElement` почти всегда попадал в кнопку
// микрофона — вне карточек.

type Line = { text: string; tone: 'info' | 'warning' | 'success' };

const LINE_TONE: Record<Line['tone'], string> = {
  info: 'text-silver-500 dark:text-silver-300',
  warning: 'text-amber-700 dark:text-amber-400',
  success: 'text-emerald-700 dark:text-emerald-400',
};

export function VoiceAssistant({
  projectId,
  sessionId,
  step,
  nav,
}: {
  projectId: string;
  /** Есть — реплики идут в сессию; нет — в проект (бриф до старта). */
  sessionId: string | null;
  step: VoiceStepId;
  /**
   * Степпер мастера — ТОТ ЖЕ список шагов и вид, что у `Stepper` (K6,
   * §4А.7.2), и его же прокрутка; нет — навигации голосом нет.
   */
  nav?: (VoiceNavState & { go: (step: GreetingStepId) => void }) | null;
}) {
  const { dict, locale } = useI18n();
  const v = dict.voiceAssistant;
  const registry = useVoiceCommands();
  // K6: лист справки — тот же, что у кнопки (i); карточка в фокусе.
  const openHelp = useHelp();
  const focusCard = useFocusedCard();
  // Разбор асинхронный: переходить надо по степперу, каким он стал к
  // ответу, а не каким был в начале фразы.
  const navRef = useRef(nav);
  navRef.current = nav;
  // Панель прилипает к низу и в середине ленты перекрывает то, что под
  // ней. В конце ленты она стоит на своём месте и ничего не закрывает, но
  // прокрутка к элементу (фокус клавиатуры на «Сгенерировать», переход к
  // полю) браузером ставит его к нижнему краю — под панель. Отступ
  // прокрутки на высоту панели, пока она на экране (аудит волны 2).
  // Колбэк-реф через состояние: панель бывает снята (`return null` при
  // исчерпанном потолке) и появляется позже — эффект должен это увидеть.
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = panelEl;
    const root = document.documentElement;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      root.style.scrollPaddingBottom = `${el.offsetHeight + 12}px`;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.scrollPaddingBottom = '';
    };
  }, [panelEl]);

  const [confirm, setConfirm] = useState<ConfirmState>(CONFIRM_INITIAL);
  // Разбор приходит асинхронно, а «да» голосом должно видеть карточку,
  // которая на экране СЕЙЧАС, — не ту, что была при начале фразы.
  const confirmRef = useRef(confirm);
  // Потолок — общий с голосом советника (`hint-audio-session.ts`): узнал
  // один канал — молчат оба до конца суток UTC, а сказано об этом ровно
  // один раз на страницу (§4А.7.5), кто бы ни узнал первым.
  const [blocked] = useState(() => isVoiceBudgetExhaustedToday());
  const [line, setLine] = useState<Line | null>(null);
  // Право сказать о потолке берётся ОДИН раз за монтирование: `claim` —
  // «первый на странице», и повторный вызов (StrictMode дважды зовёт
  // инициализаторы и эффекты) отнял бы уведомление у самого себя.
  const budgetClaimRef = useRef<boolean | null>(null);
  const budgetText = dict.wizardGuide.voiceBudgetExhausted;
  useEffect(() => {
    if (!blocked) return;
    if (budgetClaimRef.current === null) {
      budgetClaimRef.current = claimVoiceBudgetNotice();
    }
    if (budgetClaimRef.current) setLine({ text: budgetText, tone: 'warning' });
  }, [blocked, budgetText]);
  const [transcript, setTranscript] = useState<string | null>(null);
  const budgetExhaustedRef = useRef<() => void>(() => undefined);

  const onConfirmEvent = (event: ConfirmEvent): void => {
    const r = confirmReducer(confirmRef.current, event);
    confirmRef.current = r.state;
    setConfirm(r.state);
    if (!r.apply || !registry) return;
    // Строка — по тому, что применилось на самом деле, а не по карточке;
    // сохранения карточек сессии дожидаемся (K5, аудит волны 2).
    const vf = dict.voiceFields;
    void registry.applyCard(r.apply).then((outcome) =>
      setLine(
        applyOutcomeLine(outcome, {
          applied: v.applied,
          nothingApplied: v.nothingApplied,
          actionStarted: v.actionStarted,
          actionStale: v.actionStale,
          saved: vf.saved,
          filledNeedsSave: vf.filledNeedsSave,
          notSaved: vf.notSaved,
        })
      )
    );
  };

  const onUtterance = async (
    audio: Blob,
    mimeType: string,
    isCurrent: () => boolean
  ): Promise<void> => {
    // Одна карточка на разбор и на справку: «что здесь?» открывает ролик
    // той карточки, о которой сервер и думал (K6).
    const card = focusCard(STEP_CARD[step]);
    const result = await understandVoice(
      { projectId, sessionId },
      audio,
      mimeType,
      {
        screen: { step, card },
        pending: pendingForServer(confirmRef.current),
      }
    );
    // Потолок запоминается даже из устаревшего ответа: он правда
    // исчерпан, и советник тоже должен замолчать.
    if (result.status === 'budget-exhausted') markVoiceBudgetExhausted();
    // Человек выключил микрофон или уже сказал следующее — этот ответ
    // никому не нужен: ни карточки, ни строки (аудит волны 1).
    if (!isCurrent()) return;
    setTranscript(result.transcript);
    const outcome = voiceStatusOutcome(
      result,
      {
        notHeard: v.notHeard,
        unavailable: v.unavailable,
        budgetExhausted: dict.wizardGuide.voiceBudgetExhausted,
      },
      result.status === 'budget-exhausted' && claimVoiceBudgetNotice()
    );
    if (outcome) {
      if (outcome.stopForToday) budgetExhaustedRef.current();
      setLine(
        outcome.text
          ? {
              text: outcome.text,
              tone: outcome.tone === 'info' ? 'info' : 'warning',
            }
          : null
      );
      return;
    }
    // K7 (§4А.7.4): согласие на генерацию — мимо реестра интентов, прямо
    // владельцу кнопки (`VideoStep`): сводка с ценой, потом та же кнопка.
    const consentTarget = voiceConsentTarget(registry);
    const route = consentRoute(
      result.intent?.kind,
      confirmRef.current.card !== null,
      !!consentTarget?.isOpen()
    );
    if (route === 'consent') {
      const said = consentTarget
        ? await consentTarget.consent(
            result.confidence,
            confirmRef.current.card !== null,
            isCurrent
          )
        : { text: dict.voiceConsent.noButton, tone: 'info' as const };
      if (!isCurrent()) return;
      setLine(said);
      return;
    }
    if (route === 'cancel') {
      setLine(consentTarget?.cancel() ?? null);
      return;
    }
    if (route === 'hint') {
      setLine({ text: dict.voiceConsent.sayHint, tone: 'info' });
      return;
    }
    if (route === 'interrupt') consentTarget?.interrupt();
    const handlers = withNavHelpHandlers(K3_INTENT_HANDLERS, {
      nav: navRef.current ?? null,
      card,
      stepCard: STEP_CARD[step],
      canOpenHelp: !!openHelp,
      uiLocale: locale,
      stepInView: stepSectionInView,
    });
    const plan = dispatchVoiceResult(result, handlers, {
      hasPending: confirmRef.current.card !== null,
      canFill: (target) => !!registry?.canFill(target),
      command: (command, args) => registry?.command(command, args) ?? null,
      texts: {
        unknown: v.unknown,
        manual: v.manual,
        nothingPending: v.nothingPending,
      },
    });
    switch (plan.kind) {
      case 'propose':
        onConfirmEvent({ type: 'propose', card: plan.card });
        // Сервер мог отбросить часть сказанного (тон, недоступный
        // поводу) — причину он кладёт в `reply`, и она нужна рядом с
        // карточкой, а не вместо неё.
        setLine(result.reply ? { text: result.reply, tone: 'info' } : null);
        return;
      case 'confirm':
        onConfirmEvent({ type: 'confirm' });
        return;
      case 'cancel':
        onConfirmEvent({ type: 'cancel' });
        setLine(null);
        return;
      case 'reply':
        setLine({ text: plan.text, tone: 'info' });
        return;
      // K6: сразу, без карточки подтверждения. Прокрутка — та же, что
      // у клика по степперу; лист справки — тот же, что у (i), и ролик
      // в нём сам не запускается.
      case 'navigate':
        navRef.current?.go(plan.step);
        setLine(plan.text ? { text: plan.text, tone: 'info' } : null);
        return;
      case 'help':
        openHelp?.(plan.topic);
        setLine(null);
        return;
    }
  };

  const listening = useVoiceListening({
    active: true,
    blocked,
    onUtterance,
    playback: HINT_PLAYBACK,
  });
  budgetExhaustedRef.current = listening.budgetExhausted;

  // Потолок: микрофона до завтра нет, и если уведомление уже сказал
  // другой канал — показывать нечего вовсе (пустая панель — тот же повтор).
  if (
    listening.state.phase === 'blocked' &&
    !line &&
    !transcript &&
    !confirm.card
  ) {
    return null;
  }

  return (
    // Прилипает к низу экрана: индикатор открытого микрофона обязан быть
    // виден при любой прокрутке (условие 3 В-15), а карточка «я понял
    // так» — рядом с ним, чтобы «да» было видно, на что.
    <div ref={setPanelEl} className="sticky bottom-3 z-30">
      <Card className="space-y-2 p-3 shadow-lg">
        {transcript && (
          <p className="text-xs text-silver-400">
            {v.youSaid.replace('{text}', transcript)}
          </p>
        )}
        {line && (
          <p className={`text-sm ${LINE_TONE[line.tone]}`} role="status">
            {line.text}
          </p>
        )}
        {confirm.card && registry && (
          <VoiceConfirmCard
            card={confirm.card}
            describe={(f) => registry.describe(f)}
            onConfirm={() => onConfirmEvent({ type: 'confirm' })}
            onCancel={() => onConfirmEvent({ type: 'cancel' })}
          />
        )}
        <VoiceControl
          state={listening.state}
          onEnable={listening.enable}
          onDisable={listening.disable}
          onTalkStart={listening.talkStart}
          onTalkStop={listening.talkStop}
        />
      </Card>
    </div>
  );
}
