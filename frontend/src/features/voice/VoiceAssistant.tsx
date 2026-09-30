import { useEffect, useMemo, useRef, useState } from 'react';
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
import { K3_INTENT_HANDLERS } from '../../lib/voice-intents';
import {
  planLine,
  routeVoiceResult,
  screenCurrentOf,
  type VoiceLine,
} from '../../lib/voice-route';
import {
  claimVoiceBudgetNotice,
  hasGesture,
  isHintMuted,
  isHintPlaying,
  isVoiceBudgetExhaustedToday,
  markVoiceActivity,
  markVoiceBudgetExhausted,
  sayReply,
  stopHint,
  subscribeGesture,
  subscribeHintMuted,
  useVoiceBudgetOwner,
} from '../../lib/hint-audio-session';
import {
  createProactiveMemory,
  proactiveChannel,
  proactiveDecision,
  refusalOf,
  speakBodyOf,
  withQuestionHandler,
  type ProactiveEvent,
} from '../../lib/voice-proactive';
import { VOICE_BUDGET_EXHAUSTED } from '../../lib/hint-audio';
import { requestSpeech } from '../../services/wizard-guide-api';
import type { GreetingHelpTopic } from '../../lib/greeting-help';
import {
  announceProactive,
  stickyProactiveEvents,
  subscribeProactive,
} from './voice-proactive-bus';
import type { VoiceStepId } from '../../lib/voice-types';
import { understandVoice } from '../../services/greeting-voice-api';
import { VoiceConfirmCard } from './VoiceConfirmCard';
import { VoiceControl } from './VoiceControl';
import { useVoiceCommands, voiceConsentTarget } from './voice-commands';
import { useVoiceListening, type UtteranceMeta } from './useVoiceListening';
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
 * Реплику советника (K1) озвучивает `HintLine`; здесь — ответ на
 * сказанное и проактивная речь K4 (§4А.2 п.1, п.5): отказ сервера,
 * готовый ролик, сводка перед согласием, ответ на вопрос о шаге. Поводы
 * приходят от экранов шиной (`voice-proactive-bus.ts`), текст реплики
 * собирает сервер (`requestSpeech` шлёт только вид и коды), звучит она
 * тем же плеером, что подсказка, — и только у включившего звук; без
 * звука остаётся строка.
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

type Line = VoiceLine;

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
  // Колбэк-реф через состояние: панель бывает снята (при исчерпанном
  // потолке остаётся только область объявлений) и появляется позже —
  // эффект должен это увидеть.
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
  // Флаг — свой у каждого человека и тарифа (изменение контракта 6).
  const budgetOwner = useVoiceBudgetOwner();
  const budgetOwnerRef = useRef(budgetOwner);
  budgetOwnerRef.current = budgetOwner;
  // Пересчитывается при смене человека или тарифа: тариф приходит после
  // монтирования, и его смена снимает запомненное «исчерпан».
  const blocked = useMemo(
    () => isVoiceBudgetExhaustedToday(budgetOwner),
    [budgetOwner]
  );
  const [line, setLineState] = useState<Line | null>(null);
  // Постоянно смонтированная область объявлений (доступность): читалка
  // слышит ответы помощника, а не каждую смену «слушаю / слышу / разбираю».
  // Счётчик — чтобы тот же текст второй раз тоже прозвучал.
  const [announce, setAnnounce] = useState<{ text: string; n: number }>({
    text: '',
    n: 0,
  });
  const say = (text: string): void =>
    setAnnounce((a) => ({ text, n: a.n + 1 }));
  /** Фраза упёрлась в потолок длины — предупредить рядом с ответом. */
  const [truncated, setTruncatedState] = useState(false);
  const truncatedRef = useRef(false);
  const setTruncated = (next: boolean): void => {
    truncatedRef.current = next;
    setTruncatedState(next);
  };
  const setLine = (next: Line | null): void => {
    setLineState(next);
    if (next) {
      say(truncatedRef.current ? `${next.text} ${v.truncated}` : next.text);
    }
  };
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
    if (budgetClaimRef.current) {
      setLineState({ text: budgetText, tone: 'warning' });
      setAnnounce((a) => ({ text: budgetText, n: a.n + 1 }));
    }
  }, [blocked, budgetText]);
  const [transcript, setTranscript] = useState<string | null>(null);
  /**
   * K4: на вопрос о шаге нет факта — «не знаю» и кнопка справки темы
   * карточки в фокусе. Лист сам не открывается: спросили, а не просили.
   */
  const [helpTopic, setHelpTopic] = useState<GreetingHelpTopic | null>(null);

  // ── Проактивная речь (K4) ─────────────────────────────────────────
  // Память — на монтирование помощника: что уже звучало, повторно не
  // звучит (готовый ролик — раз на сессию, отказ — не чаще раза в 30 с).
  const [memory] = useState(createProactiveMemory);
  const speakRef = useRef<(event: ProactiveEvent) => void>(() => undefined);
  speakRef.current = (event) => {
    const channel = proactiveChannel({
      voice: true,
      muted: isHintMuted(),
      gestured: hasGesture(),
      budgetExhausted: isVoiceBudgetExhaustedToday(budgetOwnerRef.current),
    });
    // Повод с ключом (помеченный сценарий) строкой не расходуется — ждёт
    // голоса (CONTRACT5, `proactiveDecision`).
    const decision = proactiveDecision(event, channel, memory, Date.now());
    // Готовый ролик — ещё и строкой: без звука это единственный способ
    // сказать «готов» в панели, а читалке — в области объявлений.
    if (decision.line) {
      setLine({ text: dict.generationWizard.videoDoneTitle, tone: 'success' });
    }
    // Без звука — только строка; у отказов, ответа и сводки она уже на
    // экране (строка разбора, карточка шага, карточка сводки).
    if (!decision.speak) return;
    void requestSpeech(projectId, speakBodyOf(event, locale)).then((answer) => {
      if (answer.kind === 'play') {
        // Звук могли выключить, пока файл ехал. Звучащую реплику не
        // обрываем — очередь страницы скажет эту следом (CONTRACT5).
        if (!isHintMuted()) sayReply(answer.url, 'proactive');
      } else if (answer.kind === VOICE_BUDGET_EXHAUSTED) {
        markVoiceBudgetExhausted(budgetOwnerRef.current);
        if (claimVoiceBudgetNotice()) {
          setLine({ text: budgetText, tone: 'warning' });
        }
      }
    });
  };
  useEffect(() => subscribeProactive((e) => speakRef.current(e)), []);
  // Поводы, которые держатся, пока верны (помеченный сценарий), — ещё раз,
  // когда голосовой канал открывается: первое касание, включённый звук.
  useEffect(() => {
    const retry = () => {
      for (const e of stickyProactiveEvents()) speakRef.current(e);
    };
    retry();
    const offGesture = subscribeGesture(retry);
    const offMuted = subscribeHintMuted((muted) => {
      if (!muted) retry();
    });
    return () => {
      offGesture();
      offMuted();
    };
  }, []);

  const budgetExhaustedRef = useRef<() => void>(() => undefined);
  const stopUntilTapRef = useRef<() => void>(() => undefined);

  const onConfirmEvent = (event: ConfirmEvent): void => {
    const r = confirmReducer(confirmRef.current, event);
    confirmRef.current = r.state;
    setConfirm(r.state);
    // Карточка ушла («да», «нет») — предупреждение об обрезанной фразе
    // относилось к ней.
    if (!r.state.card && event.type !== 'propose') setTruncated(false);
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
    isCurrent: () => boolean,
    meta: UtteranceMeta
  ): Promise<void> => {
    // Фраза — действие человека: 20-секундный простой (K4) начинается
    // заново, и подсказка шага не повторяется поверх разговора.
    markVoiceActivity();
    // Больше серверного потолка своего типа — сервер откажет ещё на
    // ссылке загрузки: не шлём, сразу «короче» (микрофон слушает дальше).
    if (meta.tooLarge) {
      if (!isCurrent()) return;
      setTranscript(null);
      setTruncated(false);
      setLine({ text: v.tooLong, tone: 'warning' });
      return;
    }
    // Одна карточка на разбор и на справку: «что здесь?» открывает ролик
    // той карточки, о которой сервер и думал (K6).
    const card = focusCard(STEP_CARD[step]);
    // Бриф на экране — его несохранённые значения (изменение контракта 1):
    // сервер сверяет сказанное с тем, что человек видит.
    const current = screenCurrentOf(registry?.screenValues());
    const result = await understandVoice(
      { projectId, sessionId },
      audio,
      mimeType,
      {
        screen: { step, card },
        pending: pendingForServer(confirmRef.current),
        ...(current ? { current } : {}),
      }
    );
    const hasPendingCard = () => confirmRef.current.card !== null;
    const out = await routeVoiceResult(result, {
      isCurrent,
      hasPendingCard,
      consentTarget: () => voiceConsentTarget(registry),
      markBudgetExhausted: () =>
        markVoiceBudgetExhausted(budgetOwnerRef.current),
      claimBudgetNotice: claimVoiceBudgetNotice,
      onHeard: (heard) => {
        setTranscript(heard);
        // Обрезанная фраза — предупредить рядом с тем, что из неё поняли.
        setTruncated(meta.truncated);
      },
      handlers: () =>
        withQuestionHandler(
          withNavHelpHandlers(K3_INTENT_HANDLERS, {
            nav: navRef.current ?? null,
            card,
            stepCard: STEP_CARD[step],
            canOpenHelp: !!openHelp,
            uiLocale: locale,
            stepInView: stepSectionInView,
          }),
          // K4: вопрос о шаге — тот же резолвер темы справки, что у (i).
          { card, stepCard: STEP_CARD[step], canOpenHelp: !!openHelp }
        ),
      dispatch: {
        canFill: (target) => !!registry?.canFill(target),
        command: (command, args) => registry?.command(command, args) ?? null,
        texts: {
          unknown: v.unknown,
          manual: v.manual,
          nothingPending: v.nothingPending,
        },
      },
      texts: {
        notHeard: v.notHeard,
        unavailable: v.unavailable,
        budgetExhausted: dict.wizardGuide.voiceBudgetExhausted,
        tooLong: v.tooLong,
        noButton: dict.voiceConsent.noButton,
        sayHint: dict.voiceConsent.sayHint,
      },
    });
    switch (out.kind) {
      case 'stale':
        return;
      case 'status':
        // Потолок — до завтра; оператор, вход, лимит аккаунта — до
        // нажатия (изменение контракта 2): следующая фраза получила бы
        // тот же отказ, а строка показана один раз.
        if (out.stop === 'today') budgetExhaustedRef.current();
        else if (out.stop === 'until-tap') stopUntilTapRef.current();
        setLine(out.line);
        return;
      case 'line':
        setLine(out.line);
        return;
      case 'plan':
        break;
    }
    const plan = out.plan;
    const next = planLine(plan, result);
    setHelpTopic(plan.kind === 'answer' ? plan.help : null);
    // K4: отказ, который сервер пометил кодом (тон не для повода), —
    // объяснить голосом; строка с причиной уже в ответе разбора.
    const refusal = refusalOf(result.refusal);
    if (refusal) announceProactive({ kind: 'refusal', refusal });
    switch (plan.kind) {
      case 'propose':
        onConfirmEvent({ type: 'propose', card: plan.card });
        break;
      case 'confirm':
        onConfirmEvent({ type: 'confirm' });
        break;
      case 'cancel':
        onConfirmEvent({ type: 'cancel' });
        break;
      // K6: сразу, без карточки подтверждения. Прокрутка — та же, что
      // у клика по степперу; лист справки — тот же, что у (i), и ролик
      // в нём сам не запускается.
      case 'navigate':
        navRef.current?.go(plan.step);
        break;
      case 'help':
        openHelp?.(plan.topic);
        break;
      case 'answer':
        // Ответ из фактов звучит тем же текстом, что в строке: сервер
        // собирает его заново по теме и языку реплики.
        // «Не знаю, посмотрите справку» — тоже вслух (CONTRACT5): сервер
        // говорит свою фразу по `topic: null`.
        announceProactive({
          kind: 'answer',
          topic: plan.answered ? plan.topic : null,
          language: result.language,
        });
        break;
      case 'reply':
        break;
    }
    if (next !== 'keep') setLine(next);
    // Карточка появилась внутри страницы, а не диалогом — читалке о ней
    // говорит область объявлений: что поняли и что спросят.
    if (plan.kind === 'propose') {
      const c = plan.card;
      const what =
        c.kind === 'fill'
          ? c.fields
              .map((f) => `${f.label}: ${registry?.describe(f) ?? f.value}`)
              .join('; ')
          : c.label;
      say(
        [
          v.confirmTitle,
          what,
          next && next !== 'keep' ? next.text : '',
          truncatedRef.current ? v.truncated : '',
          v.confirmHint,
        ]
          .filter(Boolean)
          .join('. ')
      );
    }
  };

  const listening = useVoiceListening({
    active: true,
    blocked,
    onUtterance,
    playback: HINT_PLAYBACK,
  });
  budgetExhaustedRef.current = listening.budgetExhausted;
  // Тариф сменился, и потолок для нового не исчерпан — микрофон снова
  // включается кнопкой (в том числе если исчерпанным его сделал ответ
  // сервера в этой же вкладке).
  const { unblock } = listening;
  useEffect(() => {
    if (!isVoiceBudgetExhaustedToday(budgetOwner)) unblock();
  }, [budgetOwner, unblock]);
  stopUntilTapRef.current = listening.disable;

  // Область объявлений — смонтирована всегда, даже когда панели нет:
  // область, появившаяся вместе с текстом, читалкой не объявляется.
  const liveRegion = (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {announce.text && <p key={announce.n}>{announce.text}</p>}
    </div>
  );
  const truncatedNote = truncated ? v.truncated : null;

  // Потолок: микрофона до завтра нет, и если уведомление уже сказал
  // другой канал — показывать нечего вовсе (пустая панель — тот же повтор).
  const panelHidden =
    listening.state.phase === 'blocked' &&
    !line &&
    !transcript &&
    !confirm.card;

  // Область объявлений — первым ребёнком в ОБОИХ случаях: на том же
  // месте дерева React её не пересоздаёт, и читалка не теряет область
  // при появлении и снятии панели.
  return (
    <>
      {liveRegion}
      {!panelHidden && (
        // Прилипает к низу экрана: индикатор открытого микрофона обязан
        // быть виден при любой прокрутке (условие 3 В-15), а карточка «я
        // понял так» — рядом с ним, чтобы «да» было видно, на что.
        <div ref={setPanelEl} className="sticky bottom-3 z-30">
          <Card className="space-y-2 p-3 shadow-lg">
            {/* Распознанная фраза — речь человека, в ней имена: на
                кадре лендинга размывается (этап I ТЗ Greeting 2.0). */}
            {transcript && (
              <p
                className="text-xs text-silver-400"
                data-qa-mask="personal-voice-transcript"
              >
                {v.youSaid.replace('{text}', transcript)}
              </p>
            )}
            {line && (
              <p className={`text-sm ${LINE_TONE[line.tone]}`}>{line.text}</p>
            )}
            {helpTopic && openHelp && (
              <button
                type="button"
                className="rounded-full border border-[var(--border)] px-3 py-1 text-xs"
                onClick={() => {
                  openHelp(helpTopic);
                  setHelpTopic(null);
                }}
              >
                {dict.tutorialHelp.button}
              </button>
            )}
            {/* Обрезанная фраза (изменение контракта 4): у карточки — на
                ней, иначе — под строкой ответа. */}
            {truncatedNote && !(confirm.card && registry) && (
              <p className={`text-xs ${LINE_TONE.warning}`}>{truncatedNote}</p>
            )}
            {confirm.card && registry && (
              <VoiceConfirmCard
                card={confirm.card}
                describe={(f) => registry.describe(f)}
                note={truncatedNote}
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
      )}
    </>
  );
}
