/**
 * GreetingVideoWizard — GREETING_VIDEO (ТЗ TZ-Greeting-Video-Project-Type.md
 * §4.3/§5/§8), and the follow-up request: reference-image upload (до 7 —
 * предел Grok reference-to-video) с ИИ-скетчем, как у остальных
 * изображений проекта.
 *
 * Один экран на весь путь, а не отдельные маршруты на каждый шаг — тем же
 * приёмом, что ClientSiteWizard: шаги строго последовательны (бриф →
 * референсы → сценарий → видео), и адрес «шаг 3» без сессии ничего не
 * значит. `Stepper` ниже — только индикатор, не роутинг.
 *
 * Каждый шаг — минимальный API-контракт, а не переиспользование
 * `useWorkflow`: тот хук — конечный автомат SINGLE/LINE
 * (upload → analyze → product → prompt → generate), завязанный на разбор
 * референсного видео и `productInformation`, которых у GREETING_VIDEO нет
 * вообще (см. backend GreetingPromptService/GreetingVideoService
 * doc-comment — тот же выбор архитектуры, отдельный сервис вместо ветки в
 * существующем).
 *
 * Раскладка по файлам: здесь — только сам мастер (загрузка брифа и
 * сессии, степпер, порядок шагов); каждый шаг и каждая карточка блока
 * «Характер ролика» — в `./greeting/*.tsx`, общая голосовая склейка
 * карточек — в `../voice/greeting-session-voice.ts`. Файл перерос 3700
 * строк, и правка одного шага требовала листать двенадцать остальных.
 * Дочитывание сессии (`getSession`) остаётся ЗДЕСЬ: шов check-docs
 * «восстановление шага в greeting» ищет его именно в этом файле.
 */

import { useState, useCallback, useEffect } from 'react';
import { Spinner, Stepper, Card, Button, Alert } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { routes } from '../../lib/router';
import { listBrandManifests, getPlanState } from '../../services/projects-api';
import {
  getGreetingBrief,
  listGreetingSessions,
  createGreetingSession,
} from '../../services/greeting-api';
import { ScreenHeader, LoadError } from './shared';
import { ReadinessPanel } from '../../components/ReadinessPanel';
import { HintLine } from '../../components/HintLine';
import { useWizardEvents } from '../../lib/useWizardEvents';
import { toStepsView } from '../../lib/wizard-steps';
import { isVideoBusy } from '../../lib/greeting-render';
import { EmptyResponseError } from '../../lib/greeting-errors';
import {
  greetingFactsOf,
  greetingStepOf,
  greetingSteps,
  type GreetingStepId,
  greetingAnchorId,
} from '../../lib/greeting-steps';
import { greetingStepLabels, stepIsReachable } from '../../lib/voice-nav';
import {
  getWizardGuide,
  setWizardGuide,
} from '../../services/wizard-guide-api';
import { getSession, getSessionReadiness } from '../../services/api';
import {
  type PlanId,
  type GenerationPrompt,
  type GeneratedVideo,
  type Readiness,
  type WizardGuideState,
  GenerationStatus,
} from '../../types';
import type {
  GreetingBriefView,
  BrandManifestSummaryView,
} from '../../types/project';
import { HelpProvider } from './HelpSheet';
import { VoiceCommandsProvider } from '../voice/VoiceCommandsProvider';
import { VoiceAssistant } from '../voice/VoiceAssistant';
import { VoiceToggle } from '../../components/VoiceToggle';
import { BriefStep } from './greeting/BriefStep';
import { ReferencesStep } from './greeting/ReferencesStep';
import { ScriptStep } from './greeting/ScriptStep';
import { CharacterBlock, type SelectedVoice } from './greeting/CharacterBlock';
import { VideoStep } from './greeting/VideoStep';

/**
 * Хуки позиций степпера — литералами и по индексу, как `STEPPER_QA` у
 * мастера товара: подпись шага на пяти языках разная, а селектор
 * сценария обучалки обязан быть один. Порядок — `GREETING_STEP_IDS`,
 * и шов check-docs держит длину списка равной числу шагов.
 */
// Кнопка (i) и лист справки — общий провайдер на весь мастер.
const GREETING_STEPPER_QA = [
  'greeting-step-brief',
  'greeting-step-references',
  'greeting-step-script',
  'greeting-step-video',
] as const;

export function GreetingVideoWizard({ projectId }: { projectId: string }) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [brief, setBrief] = useState<GreetingBriefView | null>(null);
  const [manifests, setManifests] = useState<BrandManifestSummaryView[]>([]);
  const [plan, setPlan] = useState<PlanId>('LITE');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<GenerationPrompt | undefined>();
  const [video, setVideo] = useState<GeneratedVideo | undefined>();
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  // Голос из «Характера ролика» — шагу «Видео» (S2): подпись для сводки
  // согласия K7, вид — для плашки «озвучка не легла».
  const [senderVoice, setSenderVoice] = useState<SelectedVoice>({
    label: null,
    kind: null,
  });
  /**
   * Этап C: правка брифа после старта может сбросить наклейку, музыку и
   * число сцен или увести в новую версию сессии. Шаги ниже читают своё
   * состояние сами при монтировании — счётчик в `key` перемонтирует их,
   * чтобы экран не показывал уже сброшенное.
   */
  const [revision, setRevision] = useState(0);
  /** Чекбокс «использовать ИИ» (§3). `null` — ещё не спросили. */
  const [guide, setGuide] = useState<WizardGuideState | null>(null);
  const track = useWizardEvents(projectId);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [b, mfs, planState, sessions] = await Promise.all([
        getGreetingBrief(projectId),
        listBrandManifests().catch(() => []),
        getPlanState().catch(() => null),
        listGreetingSessions(projectId).catch(() => []),
      ]);
      setBrief(b);
      setManifests(mfs);
      if (planState) setPlan(planState.plan);
      const latest = sessions[0];
      if (latest) {
        setSessionId(latest.sessionId);
        // Блокер §4.5: сводка сессий несёт только `sessionId` — ни
        // промпта, ни ролика в `ItemSessionSummary` нет. Без этого
        // дочитывания после перезагрузки вкладки степпер показывал
        // первый шаг даже у готового ролика, а кликабельный степпер
        // поверх вранья хуже некликабельного.
        //
        // Сбой дочитывания — ошибка загрузки с «Повторить», а не пустой
        // сценарий (CONTRACT6 G-FE п. 2): раньше `.catch(() => null)`
        // показывал «сценария нет» у готового ролика, и кнопка «Собрать»
        // предлагала заплатить ещё раз. Готовность — необязательная
        // строка над шагами: её сбой экран не ломает.
        const full = await getSession(latest.sessionId);
        if (!full) throw new EmptyResponseError('session');
        setPrompt(full.generationPrompt);
        setVideo(full.generatedVideo);
        setReadiness(
          await getSessionReadiness(latest.sessionId).catch(() => null)
        );
      }
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Шаг вычисляется ДО ранних выходов, и эффект телеметрии стоит здесь
   * же: хуки обязаны вызываться в одном и том же порядке на каждом
   * рендере, а ниже по файлу уже есть выходы по загрузке и ошибке.
   *
   * «Вошёл на шаг» и «ушёл с шага» считаются по СТЕППЕРУ, а не по
   * прокрутке (§8): экран один, и считать шагом то, что в этот момент в
   * середине экрана, значило бы мерить случайность.
   */
  const facts = greetingFactsOf(sessionId, prompt, video);
  // Ролик снимается — правки, которые меняют ролик, ждут (сервер ответил
  // бы 409): бриф, текст, пересборка (CONTRACT6 G-FE п. 5).
  const videoBusy = isVideoBusy(video?.status);
  const currentStepId = greetingStepOf(facts);

  useEffect(() => {
    track('enter', currentStepId);
    return () => track('leave', currentStepId);
  }, [currentStepId, track]);

  // Чекбокс советника — отдельным запросом и молча: его недоступность
  // не должна мешать открыть мастер (§3.4).
  useEffect(() => {
    let cancelled = false;
    void getWizardGuide(projectId)
      .then((g) => {
        if (!cancelled) setGuide(g);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner size={24} />
      </div>
    );
  }
  if (loadError || !brief) {
    return (
      <div>
        <ScreenHeader title={w.title} back={routes.project(projectId)} />
        <LoadError error={loadError} onRetry={load} />
      </div>
    );
  }

  /**
   * После правки из сессии (этап C, §3.6): сессия могла смениться на
   * новую версию, сценарий — стереться. Всё перечитывается с сервера, а
   * не собирается из ответа по кусочкам: так экран не может разойтись с
   * тем, что реально лежит в сессии.
   */
  const afterSessionEdit = async (nextSessionId: string): Promise<void> => {
    setSessionId(nextSessionId);
    const [full, b, ready] = await Promise.all([
      getSession(nextSessionId)
        .then((f) => f ?? { failed: new EmptyResponseError('session') })
        .catch((e: unknown) => ({ failed: e as unknown })),
      getGreetingBrief(projectId).catch(() => null),
      getSessionReadiness(nextSessionId).catch(() => null),
    ]);
    // Как при загрузке: не дочитали сессию — не рисуем «сценария нет»,
    // а показываем ошибку с повтором (`load` перечитает всё).
    if ('failed' in full) {
      setLoadError(full.failed);
      return;
    }
    setPrompt(full.generationPrompt);
    setVideo(full.generatedVideo);
    if (b) setBrief(b);
    if (ready) setReadiness(ready);
    setRevision((r) => r + 1);
  };

  /** Перечитать готовность; сбой — оставить прежнюю строку, не падать. */
  const refreshReadiness = (id: string): void => {
    void getSessionReadiness(id)
      .then(setReadiness)
      .catch(() => undefined);
  };

  const toggleGuide = async (next: boolean): Promise<void> => {
    if (!next && !window.confirm(dict.wizardGuide.disableConfirm)) return;
    const updated = await setWizardGuide(projectId, next).catch(() => null);
    if (updated) setGuide(updated);
  };

  // «Голосом» (В-10) — второй канал советника: без включённого советника
  // голоса нет. Старый сервер поля `voice` не присылает — голоса нет.
  const voiceOn = !!guide?.available && !!guide.enabled && !!guide.voice;

  // Список шагов — один на степпер и на голос (K6, §4А.7.2): голосу
  // уходят ЭТИ `steps` и ЭТОТ `stepsView`, а подписи — из того же
  // соответствия, по которому голос называет шаг в отказе.
  const steps = greetingSteps(facts, greetingStepLabels(w));
  const stepsView = toStepsView(steps, currentStepId);

  /**
   * Клик по шагу — ПРОКРУТКА к секции, а не переключение экрана (§4.5).
   * Лента здесь осмысленна: человек листает уже готовое.
   */
  const goToStep = (id: GreetingStepId): void => {
    document
      .getElementById(greetingAnchorId(id))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Куда сейчас можно — один список на строку готовности и на кнопки
  // советника; текущий шаг исключён: вести туда, где человек и так
  // стоит, незачем.
  const reachable = new Map<string, string>();
  stepsView.targets.forEach((target, i) => {
    if (target && stepIsReachable(stepsView, i))
      reachable.set(target, stepsView.steps[i]);
  });
  const goToTarget = (id: string): void => {
    const target = stepsView.targets.find((x) => x === id);
    if (target) goToStep(target);
  };

  return (
    // Провайдер оборачивает ВЕСЬ мастер: лист справки один на девять
    // карточек, и открывает его любая из них.
    <HelpProvider>
      <VoiceCommandsProvider>
        <div className="animate-fadeIn space-y-4">
          <ScreenHeader
            title={w.title}
            back={routes.project(projectId)}
            hint={w.hint}
          />
          <Stepper
            qa={GREETING_STEPPER_QA}
            steps={stepsView.steps}
            current={stepsView.current}
            selectable={stepsView.selectable}
            done={stepsView.done}
            onSelect={(i) => {
              const target = stepsView.targets[i];
              if (target) goToStep(target);
            }}
          />

          {readiness && (
            <ReadinessPanel
              readiness={readiness}
              canGoToStep={(stepId) => reachable.has(stepId)}
              onGoToStep={goToTarget}
            />
          )}

          <HintLine
            projectId={projectId}
            stepId={currentStepId}
            enabled={!!guide?.available && !!guide?.enabled}
            voice={voiceOn}
            stepLabels={Object.fromEntries(reachable)}
            onGoToStep={goToTarget}
            onEvent={(kind, detail) => track(kind, currentStepId, detail)}
          />

          {/* Чекбокс живёт на первом шаге и только там: включить советы
          можно ТОЛЬКО в начале сценария (§3.2). У поздравления первый
          шаг — бриф, то есть всё время до создания сессии. */}
          {guide?.available && guide.canEnable && (
            <Card className="p-4">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={guide.enabled}
                  onChange={(e) => void toggleGuide(e.target.checked)}
                />
                <span>
                  <span className="font-medium">
                    {dict.wizardGuide.checkboxLabel}
                  </span>
                  <span className="block text-sm text-[var(--muted)]">
                    {dict.wizardGuide.checkboxHint}
                  </span>
                </span>
              </label>
            </Card>
          )}
          {/* «Голосом» (В-10) — под чекбоксом советника, но НЕ под
            `canEnable`: канал подсказок можно сменить на любом шаге. */}
          {guide?.available && guide.enabled && (
            <Card className="p-4">
              <VoiceToggle
                projectId={projectId}
                guide={guide}
                onChange={setGuide}
              />
            </Card>
          )}
          {!guide?.canEnable && guide?.available && guide.enabled && (
            <div className="text-right">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void toggleGuide(false)}
              >
                {dict.wizardGuide.disableButton}
              </Button>
            </div>
          )}

          <div id={greetingAnchorId('brief')}>
            <BriefStep
              brief={brief}
              manifests={manifests}
              plan={plan}
              sessionId={sessionId}
              videoBusy={videoBusy}
              onSaved={setBrief}
              onSessionEdited={(r) => afterSessionEdit(r.sessionId)}
              onStartSession={async () => {
                const session = await createGreetingSession(projectId);
                setSessionId(session.sessionId);
                setReadiness(
                  await getSessionReadiness(session.sessionId).catch(() => null)
                );
              }}
            />
          </div>

          {sessionId && (
            <div id={greetingAnchorId('references')}>
              {/* Клик по шагу «Фото» после сборки сценария приводит на
              серый экран: референсы после генерации не меняют. Это
              правда, но кликабельность и редактируемость здесь
              расходятся, и интерфейс обязан сказать почему (§4.5). */}
              {prompt && (
                <Alert tone="info" className="mb-2">
                  {w.referencesLockedHint}
                </Alert>
              )}
              <ReferencesStep
                key={`${sessionId}:${revision}`}
                sessionId={sessionId}
                disabled={!!prompt}
                // Фото меняют пункты готовности («лицо ведущего», «фото»)
                // — строка над шагами не должна отставать (п. 7).
                onChanged={() => refreshReadiness(sessionId)}
              />
            </div>
          )}

          {sessionId && (
            <div id={greetingAnchorId('script')}>
              <ScriptStep
                sessionId={sessionId}
                prompt={prompt}
                videoDone={video?.status === GenerationStatus.COMPLETE}
                videoBusy={videoBusy}
                onGenerated={(p) => {
                  setPrompt(p);
                  refreshReadiness(sessionId);
                }}
                onEdited={(r) => {
                  if (r.newVersion) {
                    void afterSessionEdit(r.sessionId);
                    return;
                  }
                  setPrompt(r.prompt);
                  refreshReadiness(sessionId);
                }}
              />
            </div>
          )}

          {sessionId && prompt && (
            <CharacterBlock
              sessionId={sessionId}
              stepKey={`${sessionId}:${revision}`}
              brief={brief}
              videoStatus={video?.status ?? null}
              onVoice={setSenderVoice}
            />
          )}

          {sessionId && prompt && (
            <div id={greetingAnchorId('video')}>
              <VideoStep
                key={sessionId}
                sessionId={sessionId}
                video={video}
                onVideo={(v) => {
                  setVideo(v);
                  refreshReadiness(sessionId);
                }}
                recipientName={brief.recipientName}
                senderName={brief.senderName}
                consentBrief={brief}
                prompt={prompt}
                readiness={readiness}
                onGoToScript={() => goToStep('script')}
                voiceLabel={senderVoice.label}
                voiceKind={senderVoice.kind}
              />
            </div>
          )}

          {/* Голосовой помощник (этап K3, В-15) — только у включивших
          «голосом»: снятие компонента закрывает микрофон. Последним в
          ленте — панель прилипает к низу экрана и не закрывает шаги. */}
          {voiceOn && (
            <VoiceAssistant
              projectId={projectId}
              sessionId={sessionId}
              step={currentStepId}
              nav={{ steps, view: stepsView, facts, go: goToStep }}
            />
          )}
        </div>
      </VoiceCommandsProvider>
    </HelpProvider>
  );
}
