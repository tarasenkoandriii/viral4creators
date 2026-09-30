/**
 * Строка совета под степпером — «Тонкая красная линия» §5.11, этапы 6–7.
 *
 * Правила поведения живут в `lib/hint-line.ts` и проверяются без
 * React; здесь остаются только три вещи, которых в чистой функции быть
 * не может: таймер простоя, сетевой вызов с отменой и отрисовка.
 *
 * ## Что здесь сделано нарочно
 *
 * 1. **Высота строки не меняется в момент загрузки.** Спиннер встаёт на
 *    место шеврона, а не добавляется рядом: подмена высоты заставляет
 *    содержимое под строкой прыгать, и человек теряет место, где читал.
 * 2. **Уход с шага и снятие галочки отменяют запрос в полёте.** Иначе
 *    ответ приезжает на экран, которого уже нет, — и совет оказывается
 *    не про то, что человек видит. Машина состояний роняет такой ответ
 *    и сама, но отмена ещё и не даёт за него платить дважды.
 * 3. **Ошибка не краснеет.** Строка сворачивается обратно. Совет —
 *    украшение пути, а не сам путь: плашка поверх мастера из-за
 *    неотвеченной подсказки несоразмерна поводу.
 * 4. **Подписи кнопок берутся из словаря и роутера, а не из ответа.**
 *    Модель называет только идентификатор (§5.7) — и незнакомый
 *    идентификатор здесь просто не рисуется, молча.
 * 5. **Голос (ТЗ Greeting 2.0 §4А.4, K1) — второй канал той же строки.**
 *    Звучит ровно раскрытый текст, по ключу его кеша; до первого
 *    касания на странице — только текст и «коснитесь, чтобы советник
 *    заговорил» (браузеры iOS и WebView без жеста звук не дают); «без
 *    звука» виден всегда, пока голос включён, и помнится на устройстве;
 *    уход с шага и размонтирование глушат реплику. Правила — в
 *    `lib/hint-audio.ts`, состояние страницы — в `lib/hint-audio-session.ts`.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { ChevronRight, Lightbulb, Volume2, VolumeX } from 'lucide-react';
import { Spinner } from './ui';
import { useI18n } from '../lib/i18n-context';
import { useHelp } from '../features/projects/help-context';
import { routes } from '../lib/router';
import {
  HINT_IDLE_MS,
  hintReducer,
  initialHintState,
  isVisible,
  waitsForIdle,
} from '../lib/hint-line';
import {
  getHintAudio,
  requestWizardHint,
  sendWizardComplaint,
} from '../services/wizard-guide-api';
import {
  VOICE_BUDGET_EXHAUSTED,
  hintVoicePlan,
  readMuted,
  writeMuted,
} from '../lib/hint-audio';
import {
  claimVoiceBudgetNotice,
  hasGesture,
  hintPlayer,
  isVoiceBudgetExhaustedToday,
  markGesture,
  markVoiceBudgetExhausted,
  subscribeGesture,
  useVoiceBudgetOwner,
} from '../lib/hint-audio-session';
import type { GuideAction } from '../types';

/**
 * Код уведомления → фраза. Сервер присылает КОД (`'personal-limit'`), а
 * не текст: мини-апп живёт на пяти языках, и русская строка с сервера
 * доезжала бы до немецкого интерфейса как есть.
 *
 * Незнакомый код молча ничего не показывает: сервер может уехать
 * вперёд на деплой, и сырой машинный код на экране хуже его отсутствия.
 */
function noticeText(code: string, t: { personalLimit: string }): string | null {
  return code === 'personal-limit' ? t.personalLimit : null;
}

/** localStorage, которого может не быть (приватный режим, WebView). */
function deviceStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Было ли касание на странице — с подпиской на первое. */
function useFirstGesture(listen: boolean): boolean {
  const [gestured, setGestured] = useState(hasGesture);
  useEffect(() => subscribeGesture(() => setGestured(true)), []);
  // Слушаем страницу, только пока голос включён: отпирание плеера —
  // это беззвучное проигрывание, и у человека без голоса ему незачем
  // трогать аудиосессию устройства.
  useEffect(() => {
    if (!listen || hasGesture()) return;
    const on = () => markGesture();
    window.addEventListener('pointerdown', on, true);
    window.addEventListener('keydown', on, true);
    return () => {
      window.removeEventListener('pointerdown', on, true);
      window.removeEventListener('keydown', on, true);
    };
  }, [listen]);
  return gestured;
}

/** Слаг документа → ключ словаря. Список закрыт на сервере (§5.7). */
const DOC_KEYS: Record<string, 'offer' | 'termsOfUse'> = {
  offer: 'offer',
  'terms-of-use': 'termsOfUse',
};

export function HintLine({
  projectId,
  stepId,
  enabled,
  voice = false,
  stepLabels,
  onGoToStep,
  onEvent,
}: {
  projectId: string;
  /** Текущий шаг мастера — он же часть ключа кеша на сервере. */
  stepId: string;
  /** Галочка стоит И фича включена оператором. */
  enabled: boolean;
  /**
   * Советник «голосом» (`guide.voice`, ТЗ Greeting 2.0 §4А.5, В-10).
   * Не передан — голоса нет, строка работает как прежде.
   */
  voice?: boolean;
  /**
   * Подписи шагов, на которые СЕЙЧАС можно перейти, — из них собираются
   * кнопки. Именно достижимых, а не всех: сервер проверяет, что шаг
   * существует в сценарии, но о том, открыт ли он на этом экране, знает
   * только мастер. Кнопка, по которой ничего не происходит, — ровно то,
   * что §5.7 называет «хуже отсутствия кнопки».
   */
  stepLabels: Record<string, string>;
  onGoToStep: (stepId: string) => void;
  /**
   * Телеметрия шагов (§8): раскрытие совета.
   *
   * «Тут непонятно» сюда НЕ идёт: его пишет сервер тем же запросом, что
   * принимает жалобу.
   */
  onEvent?: (kind: 'hint_open', detail?: string) => void;
}) {
  const { dict, locale } = useI18n();
  const t = dict.wizardGuide;
  const [state, dispatch] = useReducer(
    hintReducer,
    initialHintState(enabled, stepId)
  );
  /**
   * Жалоба: `null` — кнопка не нажата, строка — открытое поле,
   * `'sent'` — поблагодарили.
   *
   * Отдельным состоянием, а не в машине §5.11: жалоба живёт поверх
   * совета и не меняет ни одного его перехода, а всякое лишнее
   * состояние в той машине пришлось бы проверять в паре с каждым
   * другим.
   */
  const [complaint, setComplaint] = useState<string | null | 'sent'>(null);

  // Новый шаг — новая жалоба: «спасибо» на следующем шаге относилось бы
  // к предыдущему.
  useEffect(() => setComplaint(null), [stepId]);

  // ── Голос (§4А.4) ─────────────────────────────────────────────────
  const voiceOn = enabled && voice;
  const gestured = useFirstGesture(voiceOn);
  const [muted, setMuted] = useState(() => readMuted(deviceStorage()));
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  /** Ключ кеша подсказки, приехавшей на шаг, — по нему просят звук. */
  const [spoken, setSpoken] = useState<{
    stepId: string;
    key: string | null;
  } | null>(null);
  /** Какой ключ уже озвучивали — повтор той же реплики не звучит. */
  const spokenKeyRef = useRef<string | null>(null);
  /** Запрос звука в полёте: ответ на ушедший шаг роняется. */
  const pendingRef = useRef<string | null>(null);
  const [budgetNotice, setBudgetNotice] = useState(false);
  const budgetOwner = useVoiceBudgetOwner();
  const budgetOwnerRef = useRef(budgetOwner);
  budgetOwnerRef.current = budgetOwner;

  useEffect(() => {
    dispatch(enabled ? { type: 'enabled' } : { type: 'disabled' });
  }, [enabled]);

  useEffect(() => {
    dispatch({ type: 'step', stepId });
  }, [stepId]);

  // Простой на шаге. Таймер заводится, только пока его ждут: в
  // остальных состояниях событие ничего не меняет, а после ошибки не
  // должно менять и подавно — иначе лежащий провайдер превращается в
  // семь платных попыток в минуту.
  //
  // В зависимостях всё состояние целиком, и это безопасно: редьюсер
  // возвращает ТОТ ЖЕ объект, когда событие ничего не изменило, — иначе
  // каждый рендер перезаряжал бы отсчёт и восьми секунд не наступало бы
  // никогда.
  useEffect(() => {
    if (!waitsForIdle(state)) return;
    const id = setTimeout(() => dispatch({ type: 'idle' }), HINT_IDLE_MS);
    return () => clearTimeout(id);
  }, [state]);

  // Шаг берётся ИЗ СОСТОЯНИЯ, а не из пропа, и проп в зависимостях не
  // участвует. Иначе уход с шага во время загрузки давал лишний
  // ПЛАТНЫЙ вызов: проп менялся на один рендер раньше, чем машина
  // состояний успевала обработать `step`, эффект перезапускался с новым
  // шагом и тут же отменялся — но сервер к этому моменту уже считал
  // подсказку, а разрыв соединения его не останавливает.
  const loadingStep = state.phase === 'loading' ? state.stepId : null;
  useEffect(() => {
    if (!loadingStep) return;
    const ctl = new AbortController();
    let alive = true;
    requestWizardHint(projectId, { stepId: loadingStep, locale }, ctl.signal)
      .then((res) => {
        if (!alive) return;
        setSpoken({ stepId: loadingStep, key: res.key ?? null });
        dispatch({
          type: 'result',
          hint: res.hint,
          actions: res.actions ?? [],
          notice: res.notice,
        });
      })
      .catch(() => {
        // Таймаут, 429, отказ модели — для человека это одно и то же:
        // строка сворачивается, повтор возможен.
        if (alive) dispatch({ type: 'failed' });
      });
    return () => {
      alive = false;
      ctl.abort();
    };
  }, [loadingStep, projectId, locale]);

  const hintKey =
    state.phase === 'shown' && state.hint && spoken?.stepId === state.stepId
      ? spoken.key
      : null;
  const voicePlan = hintVoicePlan({
    voice: voiceOn,
    muted,
    gestured,
    budgetExhausted: isVoiceBudgetExhaustedToday(budgetOwner),
    hintKey,
    spokenKey: spokenKeyRef.current,
  });

  // Реплика звучит, когда раскрытый текст есть, касание было и звук не
  // выключен. Отмена — не очисткой эффекта: план сменится на `done` в
  // ту же секунду, как ключ помечен озвученным, и очистка уронила бы
  // собственный ответ. Ответ сверяется с `pendingRef`, который гасит
  // уход с шага.
  useEffect(() => {
    if (voicePlan !== 'speak' || !hintKey) return;
    spokenKeyRef.current = hintKey;
    pendingRef.current = hintKey;
    void getHintAudio(projectId, hintKey).then((answer) => {
      if (pendingRef.current !== hintKey) return;
      pendingRef.current = null;
      if (answer.kind === 'play') {
        if (!mutedRef.current) hintPlayer.play(answer.url);
      } else if (answer.kind === VOICE_BUDGET_EXHAUSTED) {
        // Дальше голос молчит до конца суток UTC (и микрофон тоже —
        // источник общий), а мастер работает текстом. Сказать об этом —
        // одному месту на странице.
        markVoiceBudgetExhausted(budgetOwnerRef.current);
        if (claimVoiceBudgetNotice()) setBudgetNotice(true);
      }
    });
  }, [voicePlan, hintKey, projectId]);

  // Уход с шага и размонтирование глушат реплику: голос про шаг, которого
  // уже нет на экране, хуже тишины.
  useEffect(
    () => () => {
      pendingRef.current = null;
      hintPlayer.stop();
      setBudgetNotice(false);
    },
    [stepId]
  );
  useEffect(() => {
    if (!voiceOn) hintPlayer.stop();
  }, [voiceOn]);

  const toggleMute = () => {
    // Кнопка — тоже касание: отпирает звук, если его ещё не было.
    markGesture();
    const next = !muted;
    setMuted(next);
    writeMuted(deviceStorage(), next);
    if (next) hintPlayer.stop();
  };

  if (!isVisible(state)) return null;

  const busy = state.phase === 'loading';
  const open = state.phase === 'shown' || state.phase === 'frozen';

  const header = (
    <span className="flex items-center gap-2 text-sm">
      <Lightbulb size={14} className="text-accent shrink-0" />
      <span className="font-medium">{t.title}</span>
      {!open &&
        (busy ? (
          <Spinner size={14} />
        ) : (
          <ChevronRight size={14} className="text-[var(--muted)]" />
        ))}
    </span>
  );

  return (
    <div className="mb-3 rounded-lg border border-[var(--border)] p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {open ? (
            header
          ) : (
            <button
              type="button"
              className="w-full text-left"
              aria-busy={busy}
              aria-label={busy ? t.loading : t.title}
              onClick={() => {
                // Считается именно КЛИК: показ по таймеру простоя — это
                // не внимание человека, а наша догадка о нём, и мешать
                // их в одной частоте значит потерять смысл обеих.
                onEvent?.('hint_open');
                dispatch({ type: 'open' });
              }}
            >
              {header}
            </button>
          )}
        </div>
        {/* «Без звука» — на виду всегда, пока голос включён (§4А.4), а
            не только под раскрытым советом: заговорить он может в любую
            секунду, и искать кнопку в этот момент поздно. */}
        {voiceOn && (
          <button
            type="button"
            className="shrink-0 rounded-full p-1 text-[var(--muted)]"
            aria-pressed={muted}
            aria-label={muted ? t.voiceUnmute : t.voiceMute}
            title={muted ? t.voiceUnmute : t.voiceMute}
            onClick={toggleMute}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          {state.hint && <p className="text-sm">{state.hint}</p>}
          {voicePlan === 'await-gesture' && (
            <button
              type="button"
              className="text-xs text-accent underline decoration-dotted underline-offset-2"
              // Само касание и есть разрешение: плеер отпирается здесь,
              // синхронно, и реплика звучит, как только приедет файл.
              onClick={markGesture}
            >
              {t.voiceTapToHear}
            </button>
          )}
          {budgetNotice && (
            <p className="text-xs text-[var(--muted)]">
              {t.voiceBudgetExhausted}
            </p>
          )}
          {state.notice && (
            <p className="text-sm text-[var(--muted)]">
              {noticeText(state.notice, t)}
            </p>
          )}
          <HintActions
            actions={state.actions}
            stepLabels={stepLabels}
            docLabels={t.docs}
            gotoTemplate={t.gotoStep}
            openTemplate={t.openDoc}
            onGoToStep={onGoToStep}
          />

          {/* «Тут непонятно» (§6.3). Кнопка живёт под СОВЕТОМ, а не под
              шагом: жалуются на совет, и по ней же потом заводится
              запись опыта именно для этого шага. */}
          {state.hint && complaint === 'sent' && (
            <p className="text-xs text-[var(--muted)]">{t.complaintThanks}</p>
          )}
          {state.hint && complaint === null && (
            <button
              type="button"
              className="text-xs text-[var(--muted)] underline decoration-dotted underline-offset-2"
              onClick={() => setComplaint('')}
            >
              {t.hintUseless}
            </button>
          )}
          {state.hint &&
            typeof complaint === 'string' &&
            complaint !== 'sent' && (
              <div className="space-y-2">
                <textarea
                  className="w-full rounded-lg border border-[var(--border)] bg-transparent p-2 text-sm"
                  rows={2}
                  autoFocus
                  value={complaint}
                  placeholder={t.complaintHint}
                  onChange={(e) => setComplaint(e.target.value)}
                />
                <button
                  type="button"
                  className="rounded-full border border-[var(--border)] px-3 py-1 text-xs"
                  onClick={() => {
                    // Событие телеметрии пишет СЕРВЕР, тем же запросом,
                    // и в любом случае — в том числе с пустым полем: «на
                    // этом шаге непонятно» само по себе частота, ради
                    // которой §8 и заведён. Слать его ещё и отсюда
                    // значило бы посчитать каждую жалобу дважды.
                    // Кандидата без слов сервер не создаёт — оператору
                    // нечего было бы дать.
                    const text = complaint.trim();
                    void sendWizardComplaint(projectId, {
                      stepId,
                      locale,
                      text: text || undefined,
                    });
                    setComplaint('sent');
                  }}
                >
                  {t.complaintSend}
                </button>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

/**
 * Кнопки под советом (§5.7, этап 7).
 *
 * Действие, для которого нет подписи, не рисуется. Сервер уже отбросил
 * то, чего не бывает; здесь отсекается второй случай — шаг существует,
 * но мастер на этом экране его не показывает (обучалка нумерует раунды
 * записи лентой, а не степпером). Кнопка, ведущая в невидимое место,
 * хуже её отсутствия — тот же принцип, что на сервере.
 */
function HintActions({
  actions,
  stepLabels,
  docLabels,
  gotoTemplate,
  openTemplate,
  onGoToStep,
}: {
  actions: GuideAction[];
  stepLabels: Record<string, string>;
  docLabels: Record<'offer' | 'termsOfUse', string>;
  gotoTemplate: string;
  openTemplate: string;
  onGoToStep: (stepId: string) => void;
}) {
  const { dict } = useI18n();
  const openHelp = useHelp();
  const rendered = actions
    .map((a, i) => {
      if (a.kind === 'goto-step' && a.stepId) {
        const label = stepLabels[a.stepId];
        if (!label) return null;
        const stepId = a.stepId;
        return (
          <button
            key={`s${i}`}
            type="button"
            className="rounded-full border border-[var(--border)] px-3 py-1 text-xs"
            onClick={() => onGoToStep(stepId)}
          >
            {gotoTemplate.replace('{{step}}', label)}
          </button>
        );
      }
      if (a.kind === 'play-video' && a.topic) {
        // Тот же лист, что открывает кнопка (i): второго пути к ролику
        // не заводим, он разошёлся бы с первым. Провайдера нет (совет
        // показан вне мастера) — кнопки тоже нет: она бы не сработала.
        if (!openHelp) return null;
        const topic = a.topic;
        return (
          <button
            key={`v${i}`}
            type="button"
            className="rounded-full border border-[var(--border)] px-3 py-1 text-xs"
            onClick={() => openHelp(topic)}
          >
            {dict.tutorialHelp.watch}
          </button>
        );
      }
      if (a.kind === 'open-doc' && a.slug) {
        const key = DOC_KEYS[a.slug];
        if (!key) return null;
        return (
          <a
            key={`d${i}`}
            // `#` обязателен: роутер мини-аппа хешевый, и «голый» путь
            // увёл бы человека со страницы, потеряв состояние мастера.
            href={`#${routes.legal(a.slug)}`}
            className="rounded-full border border-[var(--border)] px-3 py-1 text-xs"
          >
            {openTemplate.replace('{{doc}}', docLabels[key])}
          </a>
        );
      }
      return null;
    })
    .filter(Boolean);

  if (!rendered.length) return null;
  return <div className="flex flex-wrap gap-2">{rendered}</div>;
}
