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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Download,
  Film,
  Gift,
  ImageIcon,
  Pencil,
  RefreshCw,
  Mic,
  Music,
  Sparkles,
  Sticker,
  Trash2,
  Type,
  Upload,
  Wand2,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Pills,
  Select,
  Spinner,
  Stepper,
  Textarea,
} from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes } from '../../lib/router';
import {
  errorMessage,
  getPlanState,
  isGenerationLocked,
  listBrandManifests,
} from '../../services/projects-api';
import { recordInviteEvent } from '../../services/invite-api';
import { useRenderVoiceConsent } from '../voice/VoiceConsentFlow';
import { mediaPlaybackRef } from '../../lib/media-playback';
import { VoiceConsentCard } from '../voice/VoiceConsentCard';
import {
  createGreetingSession,
  deleteGreetingReference,
  generateGreetingPrompt,
  generateGreetingReferenceFrame,
  GREETING_MUSIC_ACCEPT,
  MAX_GREETING_MUSIC_BYTES,
  MAX_GREETING_CARD_LENGTH,
  clearGreetingSticker,
  getGreetingCards,
  getGreetingMusic,
  getGreetingScenes,
  getGreetingVoice,
  listGreetingPresetVoices,
  linkGreetingMusic,
  moveGreetingSticker,
  searchGreetingStickers,
  searchGreetingMusicLibrary,
  selectGreetingMusic,
  selectGreetingMusicFromLibrary,
  selectGreetingSticker,
  setGreetingScenes,
  updateGreetingCards,
  uploadGreetingMusic,
  selectGreetingPresetVoice,
  selectGreetingSenderVoice,
  suggestGreetingSceneSettings,
  getGreetingBrief,
  getGreetingVideoStatus,
  listGreetingReferences,
  listGreetingSessions,
  MAX_GREETING_REFERENCE_IMAGES,
  startGreetingVideo,
  updateGreetingBrief,
  updateGreetingReference,
  updateGreetingScript,
  updateSessionGreetingBrief,
  uploadGreetingReference,
} from '../../services/greeting-api';
import { SketchSlotActions } from '../sketch/SketchSlotActions';
import { revokeObjectUrl } from '../../lib/object-url';
import { LoadError, ScreenHeader } from './shared';
import { ReadinessPanel } from '../../components/ReadinessPanel';
import { HintLine } from '../../components/HintLine';
import { useWizardEvents } from '../../lib/useWizardEvents';
import { toStepsView } from '../../lib/wizard-steps';
import {
  sessionBriefPatch,
  startAfterSave,
} from '../../lib/greeting-brief-diff';
import {
  greetingAnchorId,
  greetingFactsOf,
  greetingStepOf,
  greetingSteps,
  type GreetingStepId,
} from '../../lib/greeting-steps';
import { greetingStepLabels, stepIsReachable } from '../../lib/voice-nav';
import {
  getWizardGuide,
  setWizardGuide,
} from '../../services/wizard-guide-api';
import { getSession, getSessionReadiness } from '../../services/api';
import type { Readiness, WizardGuideState } from '../../types';
import { GreetingDeliveryPanel } from './GreetingDeliveryPanel';
import { MyVoicesSection } from '../brand/VoicePicker';
import {
  GREETING_RESOLUTIONS,
  GREETING_SCRIPT_LANGUAGES,
  GREETING_SCRIPT_LANGUAGE_NAMES,
} from '../../types/project';
import { GreetingOccasionFields } from './GreetingOccasionFields';
import {
  initialMood,
  occasionFieldsComplete,
  occasionRegisterField,
  effectiveServerRegister,
  fieldsRegister,
  type OccasionFieldsState,
} from '../../lib/greeting-occasion-fields';
import {
  useGreetingPolicy,
  useSessionSelections,
} from '../../lib/useGreetingPolicy';
import { predictedSessionResets } from '../../lib/greeting-policy';
import { STICKER_PLACEMENTS } from '../../types/project';
import type {
  BrandManifestSummaryView,
  GreetingBriefView,
  GreetingPresenterProvider,
  GreetingReferenceImageView,
  GreetingCardsView,
  GreetingMusicView,
  GreetingResolution,
  GreetingResetField,
  GreetingScenesView,
  GreetingScriptLanguage,
  SessionBriefEditResult,
  SessionScriptEditResult,
  UpdateGreetingBriefInput,
  GreetingStickerView,
  GreetingVoiceView,
  GrokPresetVoice,
} from '../../types/project';
import type { GeneratedVideo, GenerationPrompt, PlanId } from '../../types';
import { GenerationStatus, ModerationStatus } from '../../types';
import { HelpButton, HelpProvider } from './HelpSheet';
import { useMemo } from 'react';
import {
  rulesOf,
  type GreetingRegisterRules,
  type ToneChange,
} from '../../lib/greeting-policy';
import {
  BRIEF_VOICE_TARGETS,
  BRIEF_VOICE_TARGET_LIST,
  applyBriefVoiceFields,
  toneForCommand,
  type BriefVoiceRefusal,
  type ToneCommand,
} from '../../lib/voice-brief';
import type { VoiceField } from '../../lib/voice-types';
// K5 (§4А.7.1): элементы сессии голосом — те же обработчики, что кнопки.
import {
  SESSION_VOICE_TARGETS,
  cardsVoiceSave,
  planCardsVoice,
  planMusicVoice,
  planReferenceVoice,
  planScenesVoice,
  planScriptVoice,
  planStickerVoice,
  planVoiceChoice,
  refusalLines,
  needsSave,
  saveEffect,
  type ReferenceFormsState,
  type SessionVoiceTexts,
} from '../../lib/voice-fields';
import { listUserVoices } from '../../services/projects-api';
import { useFeature } from '../../lib/plan-context';
import type { VoiceCommandHandler } from '../voice/voice-commands';
import { useVoiceCommand, useVoiceFieldApplier } from '../voice/voice-commands';
import { VoiceCommandsProvider } from '../voice/VoiceCommandsProvider';
import { VoiceAssistant } from '../voice/VoiceAssistant';
import { VoiceToggle } from '../../components/VoiceToggle';
import {
  cardsSummary,
  characterRegister,
  characterSummaryLine,
  musicSummary,
  scenesSummary,
  showOwnMusicWarning,
  stickerCardHidden,
  stickerSummary,
  voiceSummary,
  type CharacterPart,
  type CharacterSummary,
} from '../../lib/greeting-character';

const REFERENCE_PHOTO_MIME = ['image/png', 'image/jpeg'];
const REFERENCE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const POLL_INTERVAL_MS = 4000;

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
        const full = await getSession(latest.sessionId).catch(() => null);
        if (full) {
          setPrompt(full.generationPrompt);
          setVideo(full.generatedVideo);
        }
        const ready = await getSessionReadiness(latest.sessionId);
        setReadiness(ready);
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
      getSession(nextSessionId).catch(() => null),
      getGreetingBrief(projectId).catch(() => null),
      getSessionReadiness(nextSessionId).catch(() => null),
    ]);
    setPrompt(full?.generationPrompt);
    setVideo(full?.generatedVideo);
    if (b) setBrief(b);
    if (ready) setReadiness(ready);
    setRevision((r) => r + 1);
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
              onSaved={setBrief}
              onSessionEdited={(r) => afterSessionEdit(r.sessionId)}
              onStartSession={async () => {
                const session = await createGreetingSession(projectId);
                setSessionId(session.sessionId);
                setReadiness(await getSessionReadiness(session.sessionId));
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
              />
            </div>
          )}

          {sessionId && (
            <div id={greetingAnchorId('script')}>
              <ScriptStep
                sessionId={sessionId}
                prompt={prompt}
                videoDone={video?.status === GenerationStatus.COMPLETE}
                onGenerated={(p) => {
                  setPrompt(p);
                  void getSessionReadiness(sessionId).then(setReadiness);
                }}
                onEdited={(r) => {
                  if (r.newVersion) {
                    void afterSessionEdit(r.sessionId);
                    return;
                  }
                  setPrompt(r.prompt);
                  void getSessionReadiness(sessionId).then(setReadiness);
                }}
              />
            </div>
          )}

          {sessionId && prompt && (
            <CharacterBlock
              sessionId={sessionId}
              stepKey={`${sessionId}:${revision}`}
              brief={brief}
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
                  void getSessionReadiness(sessionId).then(setReadiness);
                }}
                recipientName={brief.recipientName}
                senderName={brief.senderName}
                consentBrief={brief}
                prompt={prompt}
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

// ── Шаг 1: бриф ──────────────────────────────────────────────────────────

function resetFieldLabel(
  w: {
    resetFieldSticker: string;
    resetFieldMusic: string;
    resetFieldScenes: string;
    resetFieldPhotos: string;
  },
  field: GreetingResetField
): string {
  switch (field) {
    case 'referenceImages':
      return w.resetFieldPhotos;
    case 'sticker':
      return w.resetFieldSticker;
    case 'musicTheme':
      return w.resetFieldMusic;
    case 'sceneCount':
      return w.resetFieldScenes;
  }
}

function BriefStep({
  brief,
  manifests,
  plan,
  sessionId,
  onSaved,
  onSessionEdited,
  onStartSession,
}: {
  brief: GreetingBriefView;
  manifests: BrandManifestSummaryView[];
  plan: PlanId;
  /** Есть — правка идёт в сессию (этап C, §3.6), нет — в бриф проекта. */
  sessionId: string | null;
  onSaved: (brief: GreetingBriefView) => void;
  onSessionEdited: (result: SessionBriefEditResult) => Promise<void>;
  onStartSession: () => Promise<void>;
}) {
  const { dict, locale } = useI18n();
  const w = dict.greetingVideoWizard;
  const hasSession = !!sessionId;

  // Этап D (§3.4, §3.5): повод, настроение и тон — одним куском, его
  // правит общий с экраном создания блок `GreetingOccasionFields`.
  // Настроение — сохранённый ответ человека (сервер хранит его отдельно
  // от поднятого итога), см. `initialMood`; нет ответа — вопрос заново.
  const [occ, setOcc] = useState<OccasionFieldsState>(() => ({
    occasion: brief.occasion,
    customOccasionText: brief.customOccasionText ?? '',
    mood: initialMood(brief),
    tone: brief.tone,
  }));
  const { occasion, customOccasionText, tone } = occ;
  const policy = useGreetingPolicy();
  // Итог сервера из ПОСЛЕДНЕГО сохранения: `brief` обновляется после
  // каждой правки, так что строка «уточнено как …» не отстаёт. Переписал
  // человек описание — прежний итог уже не про этот текст и не держит
  // тоны (`effectiveServerRegister`).
  const serverRegister = effectiveServerRegister(brief, occ);
  const [recipientName, setRecipientName] = useState(brief.recipientName);
  const [senderName, setSenderName] = useState(brief.senderName ?? '');
  const [personalMessage, setPersonalMessage] = useState(
    brief.personalMessage ?? ''
  );
  const [presenterProvider, setPresenterProvider] =
    useState<GreetingPresenterProvider>(brief.presenterProvider);
  const [resolution, setResolution] = useState<GreetingResolution>(
    brief.resolution
  );
  const [brandManifestId, setBrandManifestId] = useState(
    brief.brandManifestId ?? ''
  );
  const [occasionDate, setOccasionDate] = useState(brief.occasionDate ?? '');
  // Этап C (§3.8): по умолчанию — язык интерфейса автора.
  const [scriptLanguage, setScriptLanguage] = useState<GreetingScriptLanguage>(
    brief.scriptLanguage ?? locale
  );
  /** Что показать рядом с «Сохранено» после правки из сессии. */
  const [editResult, setEditResult] = useState<SessionBriefEditResult | null>(
    null
  );

  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /**
   * Счётчик удачных сохранений. Сохранение само сбрасывает несовместимое
   * в сессии и делает устаревшей строку «Тон: … → …», а регистр от него
   * может не поменяться — без счётчика предупреждение «сбросится …»
   * висело бы после уже случившегося сброса.
   */
  const [saveCount, setSaveCount] = useState(0);

  // У «Особого повода» без ответа о настроении сервер отвечает 400
  // (§3.4: «без ответа бриф не сохраняется») — кнопка гаснет раньше.
  const canSave =
    recipientName.trim().length > 0 && occasionFieldsComplete(occ);

  // Предупреждение ДО сохранения: что сбросится в уже начатой сессии при
  // новом поводе и регистре (музыка каталога зависит от повода).
  // Окончательный список всё равно назовёт сервер (`resetFields` рядом с
  // «Сохранено»); это — чтобы не удивлять.
  const registerNow = fieldsRegister(policy, occ, serverRegister);
  const selections = useSessionSelections(
    sessionId,
    occasion,
    registerNow,
    saveCount
  );
  const predictedResets = selections
    ? predictedSessionResets(policy, occasion, registerNow, selections)
    : [];

  // ── Голос (этап K3, ТЗ Greeting 2.0 §4А.2 п. 3–4) ─────────────────────
  // Карточка «я понял так» применяется сюда, в те же setState, что у
  // ручного ввода, и по тем же правилам (`applyBriefVoiceFields`): повод
  // — через сброс тона `applyOccasionPatch`, тон — только допустимый.
  const v = dict.voiceAssistant;
  const [voiceToneChange, setVoiceToneChange] = useState<{
    change: ToneChange | null;
    seq: number;
  }>({ change: null, seq: 0 });
  const describeVoiceField = (f: VoiceField): string => {
    if (typeof f.value === 'boolean') return f.value ? v.valueYes : v.valueNo;
    const T = BRIEF_VOICE_TARGETS;
    const names: Partial<Record<string, Record<string, string>>> = {
      [T.occasion]: w.occasion,
      [T.mood]: w.mood,
      [T.tone]: w.tone,
      [T.scriptLanguage]: GREETING_SCRIPT_LANGUAGE_NAMES,
      [T.presenter]: { grok: w.providerGrok, hedra: w.providerHedra },
    };
    return names[f.target]?.[f.value] ?? f.value;
  };
  const refusalReason = (reason: BriefVoiceRefusal): string =>
    reason === 'tone-unavailable'
      ? w.toneUnavailable
      : reason === 'not-other'
        ? v.refusedNotOther
        : v.refusedInvalid;
  useVoiceFieldApplier({
    targets: BRIEF_VOICE_TARGET_LIST,
    describe: describeVoiceField,
    apply: (fields) => {
      const r = applyBriefVoiceFields(policy, occ, fields, (next) =>
        effectiveServerRegister(brief, next)
      );
      if (r.occPatch) {
        const occPatch = r.occPatch;
        setOcc((prev) => ({ ...prev, ...occPatch }));
        setVoiceToneChange((prev) => ({
          change: r.toneChange,
          seq: prev.seq + 1,
        }));
      }
      const p = r.patch;
      if (p.recipientName !== undefined) setRecipientName(p.recipientName);
      if (p.senderName !== undefined) setSenderName(p.senderName);
      if (p.personalMessage !== undefined)
        setPersonalMessage(p.personalMessage);
      if (p.scriptLanguage !== undefined) setScriptLanguage(p.scriptLanguage);
      if (p.presenterProvider !== undefined)
        setPresenterProvider(p.presenterProvider);
      if (p.resolution !== undefined) setResolution(p.resolution);
      if (p.occasionDate !== undefined) setOccasionDate(p.occasionDate);
      const refusals = r.refused.map((x) =>
        v.refusedField
          .replace(
            '{field}',
            fields.find((f) => f.target === x.target)?.label ?? x.target
          )
          .replace('{reason}', refusalReason(x.reason))
      );
      // Бриф голос не сохраняет — строка после «Да» называет кнопку (K5).
      return {
        refusals,
        effects:
          fields.length > refusals.length
            ? [needsSave(w.editSubmitButton)]
            : [],
      };
    },
  });
  // «Серьёзнее», «легче», «без шуток» — не отдельное действие, а
  // предложенный тон на той же карточке «я понял так»: применится только
  // после «Да» и через те же правила регистра, что пилюля тона.
  const toneCommand = (command: ToneCommand): VoiceCommandHandler => ({
    propose: (args) => {
      const r = toneForCommand(
        command,
        tone,
        policy,
        occasion,
        registerNow,
        args?.tone
      );
      if ('tone' in r) {
        return {
          kind: 'propose',
          card: {
            kind: 'fill',
            fields: [
              {
                target: BRIEF_VOICE_TARGETS.tone,
                value: r.tone,
                label: w.toneLabel,
              },
            ],
          },
        };
      }
      const lighter = command === 'tone-lighter';
      const text =
        r.refusal === 'unavailable'
          ? lighter
            ? v.toneLighterUnavailable
            : v.toneSeriousUnavailable
          : command === 'no-jokes'
            ? v.noJokesAlready
            : lighter
              ? v.toneLighterAlready
              : v.toneSeriousAlready;
      return { kind: 'refuse', text };
    },
  });
  useVoiceCommand('tone-serious', toneCommand('tone-serious'));
  useVoiceCommand('tone-lighter', toneCommand('tone-lighter'));
  useVoiceCommand('no-jokes', toneCommand('no-jokes'));

  const fieldsNow = () => ({
    occasion: occasion as string,
    customOccasionText: occasion === 'OTHER' ? customOccasionText.trim() : null,
    // Только у «Особого повода». После старта уходят лишь изменённые
    // поля, но ответ о настроении — ВСЕГДА (`sessionBriefPatch`): сервер
    // теперь помнит ответ сам, но у брифа, поднятого словами или
    // классификатором до отдельной колонки ответа, его там нет, и правка
    // без него получила бы 400 OTHER_MOOD_REQUIRED.
    occasionRegister: occasionRegisterField(occ) as string | null,
    scriptLanguage: scriptLanguage as string,
    recipientName: recipientName.trim(),
    senderName: senderName.trim() || null,
    tone: tone as string,
    personalMessage: personalMessage.trim() || null,
    presenterProvider: presenterProvider as string,
    resolution: resolution as string,
    occasionDate: occasionDate || null,
  });
  /** Что было на экране при открытии или после последнего сохранения. */
  const baseline = useRef<ReturnType<typeof fieldsNow> | null>(null);
  if (!baseline.current) baseline.current = fieldsNow();

  /** `true` — сохранено; ошибку показывает сам (`start` ждёт ответа). */
  const save = async (): Promise<boolean> => {
    if (!canSave) return false;
    setSaving(true);
    setError(null);
    setSaved(false);
    setEditResult(null);
    const fields = fieldsNow();
    try {
      if (sessionId) {
        // Этап C (§3.6): после старта правка идёт в СЕССИЮ — сервер
        // обновит и её снимок, и бриф проекта. Раньше здесь был бриф
        // проекта, до сессии правка не доходила (Г-3), и этап A закрыл
        // поля целиком. Уходят только изменённые поля (и ответ о
        // настроении «Особого повода») — почему, см.
        // `lib/greeting-brief-diff.ts`.
        const result = await updateSessionGreetingBrief(
          sessionId,
          sessionBriefPatch(
            baseline.current!,
            fields
          ) as UpdateGreetingBriefInput
        );
        baseline.current = fields;
        setEditResult(result);
        await onSessionEdited(result);
      } else {
        const updated = await updateGreetingBrief(brief.projectId, {
          ...(fields as UpdateGreetingBriefInput),
          brandManifestId: brandManifestId || null,
        });
        baseline.current = fields;
        onSaved(updated);
      }
      setSaved(true);
      setSaveCount((n) => n + 1);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      // Бриф не сохранился (например, 400) — сессию не начинаем: она
      // собралась бы из СТАРОГО брифа, а ошибку `save` уже показал.
      await startAfterSave(save, onStartSession);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card className="p-5" data-qa="greeting-brief-card">
      <CardHeader
        icon={<Gift size={18} />}
        title={w.occasionLabel}
        hint={hasSession ? undefined : w.hint}
        action={<HelpButton cardHook="greeting-brief-card" />}
      />
      <div className="space-y-4">
        {/* Этап D (§3.5): повод → настроение → тон одной группой, тот же
            блок, что на экране создания, — сброс тона при смене повода
            и объяснение недоступного живут в нём, а не в двух копиях. */}
        <GreetingOccasionFields
          // Новый `key` после сохранения сбрасывает строку «Тон: … → …»:
          // она об изменении, которое уже сохранено.
          key={saveCount}
          value={occ}
          onChange={(patch) => setOcc((prev) => ({ ...prev, ...patch }))}
          policy={policy}
          serverRegister={serverRegister}
          serverRegisterFor={(next) => effectiveServerRegister(brief, next)}
          announcedToneChange={voiceToneChange}
        />

        <Field label={w.recipientNameLabel}>
          <Input
            data-qa="greeting-field-recipient"
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value.slice(0, 120))}
            placeholder={w.recipientNamePlaceholder}
          />
        </Field>

        <Field label={w.senderNameLabel}>
          <Input
            data-qa="greeting-field-sender"
            value={senderName}
            onChange={(e) => setSenderName(e.target.value.slice(0, 120))}
            placeholder={w.senderNamePlaceholder}
          />
        </Field>

        <Field
          label={w.personalMessageLabel}
          hint={w.personalMessageHint}
          counter={`${personalMessage.length}/2000`}
        >
          <Textarea
            data-qa="greeting-field-message"
            rows={3}
            value={personalMessage}
            onChange={(e) => setPersonalMessage(e.target.value.slice(0, 2000))}
            placeholder={w.personalMessagePlaceholder}
          />
        </Field>

        <Field label={w.scriptLanguageLabel} hint={w.scriptLanguageHint}>
          <Select
            data-qa="greeting-field-script-language"
            value={scriptLanguage}
            onChange={(e) =>
              setScriptLanguage(e.target.value as GreetingScriptLanguage)
            }
          >
            {GREETING_SCRIPT_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {GREETING_SCRIPT_LANGUAGE_NAMES[l]}
              </option>
            ))}
          </Select>
        </Field>

        <div data-qa="greeting-field-presenter">
          <span className="label">{w.presenterProviderLabel}</span>
          <Pills
            value={presenterProvider}
            onChange={setPresenterProvider}
            options={[
              { value: 'grok', label: w.providerGrok },
              {
                value: 'hedra',
                label: w.providerHedra,
                sub:
                  plan === 'PREMIUM' ? undefined : w.providerHedraPremiumOnly,
              },
            ]}
          />
          {presenterProvider === 'hedra' && (
            // Не предупреждение, а объяснение: аватару нужно лицо, и
            // узнать об этом лучше здесь, чем отказом на кнопке
            // генерации. Раньше на этом месте стояло «недоступно даже
            // на PREMIUM» — текст пилота, который решение владельца
            // продукта отменило.
            <Alert tone="info" className="mt-2">
              {w.providerHedraPortraitNotice}
            </Alert>
          )}
        </div>

        <Field label={w.resolutionLabel}>
          <Select
            data-qa="greeting-field-resolution"
            value={resolution}
            onChange={(e) =>
              setResolution(e.target.value as GreetingResolution)
            }
          >
            {GREETING_RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={w.occasionDateLabel}>
          <Input
            data-qa="greeting-field-date"
            type="date"
            value={occasionDate}
            onChange={(e) => setOccasionDate(e.target.value)}
          />
        </Field>

        <Field
          label={w.manifestLabel}
          hint={hasSession ? w.manifestSessionHint : undefined}
        >
          <Select
            value={brandManifestId}
            onChange={(e) => setBrandManifestId(e.target.value)}
            disabled={hasSession || manifests.length === 0}
          >
            <option value="">{w.noManifestOption}</option>
            {manifests.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </Field>

        {error && <Alert tone="error">{error}</Alert>}
        {saved && !error && (
          <Alert tone="success">
            <Check size={14} className="inline mr-1" />
            {w.editSubmitButton}
            {/* Этап C (§3.6): молча ничего не пропадает — сброшенное
                называется рядом с «Сохранено». */}
            {editResult && editResult.resetFields.length > 0 && (
              <span className="block">
                {w.savedResetPrefix}{' '}
                {editResult.resetFields
                  .map((f) => resetFieldLabel(w, f))
                  .join(', ')}
              </span>
            )}
            {editResult?.promptCleared && (
              <span className="block">{w.promptClearedNote}</span>
            )}
            {editResult?.newVersion && (
              <span className="block">{w.newVersionNote}</span>
            )}
          </Alert>
        )}

        {/* Этап C ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md
            (§3.6) снял временную блокировку этапа A: правка после старта
            идёт в сессию через `PATCH /sessions/:id/greeting-brief`. */}
        {hasSession && <Alert tone="info">{w.briefSessionHint}</Alert>}
        {/* Этап D (§3.5): несовместимое с новым регистром называется до
            нажатия, а не только после — «Сохранено» со списком снятого
            ниже остаётся окончательным ответом сервера. */}
        {hasSession && predictedResets.length > 0 && (
          <Alert tone="warning">
            {w.sessionResetWarning.replace(
              '{list}',
              predictedResets.map((f) => resetFieldLabel(w, f)).join(', ')
            )}
          </Alert>
        )}

        <div className="flex gap-2">
          <Button
            data-qa="greeting-brief-save"
            variant="outline"
            disabled={!canSave || saving || starting}
            loading={saving}
            onClick={() => void save()}
          >
            {w.editSubmitButton}
          </Button>
          {!hasSession && (
            <Button
              data-qa="greeting-start"
              disabled={!canSave || saving || starting}
              loading={starting}
              onClick={() => void start()}
            >
              {w.startSessionButton}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Голос в элементах сессии (этап K5, ТЗ Greeting 2.0 §4А.7.1) ─────────
//
// Каждая карточка ниже регистрирует свои хуки (`SESSION_VOICE_TARGETS`)
// и применяет подтверждённое «Да» ТЕМИ ЖЕ обработчиками, что её кнопки;
// что применимо к текущему состоянию, решают `plan*Voice` из
// `lib/voice-fields.ts`. Хуки регистрируются, только пока карточка на
// экране (`targets` пуст — поле не попадёт на карточку «я понял так»).

/** Строки отказов K5: свой раздел словаря плюс причины, уже написанные
 * на экране (наклейки под запретом регистра, «сценарий не собран»). */
function useSessionVoiceTexts(): SessionVoiceTexts {
  const { dict } = useI18n();
  const vf = dict.voiceFields;
  const w = dict.greetingVideoWizard;
  return {
    refusedField: dict.voiceAssistant.refusedField,
    invalid: vf.invalid,
    notOnScreen: vf.notOnScreen,
    busy: vf.busy,
    tooMany: vf.tooMany,
    ambiguous: vf.ambiguous,
    ambiguousNone: vf.ambiguousNone,
    manual: vf.manual,
    conflict: vf.conflict,
    already: vf.already,
    unavailable: {
      'sticker-register': w.stickerUnavailable,
      'no-search': vf.noSearch,
      'no-sticker': vf.noSticker,
      'no-script': w.scriptEmpty,
      // Та же строка, что стоит над карточкой кадров после сборки.
      'references-locked': w.referencesLockedHint,
      'form-closed': vf.formClosed,
      'two-forms': vf.twoForms,
    },
  };
}

/** Значение галочки и пустого титра на карточке «я понял так». */
function describeSessionValue(
  value: string | boolean,
  vf: { valueOn: string; valueOff: string; cardRemove: string }
): string {
  if (typeof value === 'boolean') return value ? vf.valueOn : vf.valueOff;
  return value === '' ? vf.cardRemove : value;
}

// ── Шаг 2: референс-изображения (доп. запрос — до 7, скетч) ─────────────

function ReferencesStep({
  sessionId,
  disabled,
}: {
  sessionId: string;
  disabled: boolean;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [images, setImages] = useState<GreetingReferenceImageView[] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /* Фича №36: три варианта сеттинга. `null` — ещё не спрашивали,
     `[]` — спросили, но модель не дала ничего (бэкенд глотает свои
     ошибки и отдаёт пустой список); во втором случае показываем
     подсказку, а не ошибку: кадр рисуется и без сеттинга. */
  const [settings, setSettings] = useState<string[] | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const load = useCallback(() => {
    listGreetingReferences(sessionId)
      .then(setImages)
      .catch((e) => setError(errorMessage(e)));
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (fn: () => Promise<GreetingReferenceImageView[]>) => {
    setSaving(true);
    setError(null);
    try {
      setImages(await fn());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const suggest = async () => {
    setSettingsBusy(true);
    setError(null);
    try {
      setSettings(await suggestGreetingSceneSettings(sessionId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSettingsBusy(false);
    }
  };

  const canDraw =
    !disabled &&
    images !== null &&
    images.length < MAX_GREETING_REFERENCE_IMAGES;

  // Голос (K5): подпись и описание живут ТОЛЬКО в открытой форме кадра —
  // её и заполняет голос (форма регистрируется сама, `voiceActive`).
  // Нет формы, их две или правки заперты — карточка отвечает причиной,
  // а не молчит: «Да» на такое ничего бы не сделало.
  const openForms = (adding ? 1 : 0) + (editingId !== null ? 1 : 0);
  const referenceForms: ReferenceFormsState = disabled
    ? 'locked'
    : openForms === 0
      ? 'none'
      : openForms === 1
        ? 'one'
        : 'two';
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets:
      images === null || referenceForms === 'one'
        ? []
        : [
            SESSION_VOICE_TARGETS.referenceLabel,
            SESSION_VOICE_TARGETS.referenceDescription,
          ],
    describe: (f) => describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) =>
      refusalLines(
        planReferenceVoice(referenceForms, saving, fields).refused,
        fields,
        voiceTexts
      ),
  });

  return (
    <Card className="p-5" data-qa="greeting-references-card">
      <CardHeader
        icon={<ImageIcon size={18} />}
        title={w.referencesHeading}
        hint={w.referencesHint}
        action={
          <>
            <HelpButton cardHook="greeting-references-card" />
            {canDraw && (
              <div className="flex flex-wrap gap-2">
                {/* Фича №6: нарисовать кадр по брифу. Рядом с загрузкой, а
                  не вместо неё — своё фото остаётся более точным
                  вариантом, а кадр нужен тем, у кого фото нет вовсе:
                  именно у них grok-путь уходил в text-to-video вслепую
                  и показывал результат только после дорогого рендера. */}
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Sparkles size={14} />}
                  loading={saving}
                  disabled={saving}
                  onClick={() =>
                    void apply(() => generateGreetingReferenceFrame(sessionId))
                  }
                >
                  {w.generateReference}
                </Button>
                {/* Фича №36: дешёвый текстовый вызов перед дорогим
                  рисованием. Отдельной кнопкой, а не автоматически при
                  открытии шага, — иначе платный вызов уходил бы у
                  каждого, кто просто пролистал шаг. */}
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Wand2 size={14} />}
                  loading={settingsBusy}
                  disabled={saving || settingsBusy}
                  onClick={() => void suggest()}
                >
                  {w.suggestSettings}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAdding((v) => !v)}
                  active={adding}
                >
                  {w.addReference}
                </Button>
              </div>
            )}
          </>
        }
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!images ? (
        <div className="flex justify-center py-4">
          <Spinner size={20} />
        </div>
      ) : (
        <>
          {settings !== null && canDraw && (
            <div className="mt-3 rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
              <p className="text-xs text-silver-400">{w.settingsHint}</p>
              {settings.length === 0 ? (
                <p className="mt-2 text-xs text-silver-400">
                  {w.settingsEmpty}
                </p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {settings.map((setting) => (
                    <li key={setting}>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saving || settingsBusy}
                        onClick={() =>
                          void apply(() =>
                            generateGreetingReferenceFrame(sessionId, setting)
                          )
                        }
                      >
                        {setting}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {adding && !disabled && (
            <ReferenceUploader
              sessionId={sessionId}
              voiceActive={referenceForms === 'one'}
              onDone={(next) => {
                setAdding(false);
                setImages(next);
              }}
              onCancel={() => setAdding(false)}
              onError={setError}
            />
          )}

          {images.length === 0 ? (
            <p className="rounded-xl border border-dashed border-silver-300 p-3 text-xs text-silver-400 dark:border-silver-700">
              {w.referencesEmpty}
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 mt-3">
              {images.map((img) => (
                <li key={img.id} className="relative">
                  <div className="overflow-hidden rounded-xl border border-silver-200/70 dark:border-silver-800">
                    <div className="relative aspect-square w-full bg-silver-200/60 dark:bg-silver-800/60">
                      <img
                        src={img.photoUrl}
                        alt=""
                        data-qa-mask="reference-thumbnail"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    {editingId === img.id && !disabled ? (
                      <ReferenceEditor
                        sessionId={sessionId}
                        image={img}
                        voiceActive={referenceForms === 'one'}
                        onDone={(next) => {
                          setEditingId(null);
                          setImages(next);
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      <div className="p-2">
                        <p className="truncate text-xs font-medium">
                          {img.label}
                        </p>
                        {img.description && (
                          <p className="line-clamp-2 text-[11px] text-silver-400">
                            {img.description}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  {!disabled && editingId !== img.id && (
                    <div className="absolute right-1.5 top-1.5 flex gap-1">
                      <button
                        type="button"
                        aria-label={w.editReferenceAria}
                        disabled={saving}
                        onClick={() => setEditingId(img.id)}
                        className="rounded-full bg-silver-950/70 p-1 text-white hover:bg-accent"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        aria-label={w.deleteReferenceAria}
                        disabled={saving}
                        onClick={() => {
                          if (
                            !window.confirm(
                              w.deleteReferenceConfirm.replace(
                                '{{label}}',
                                img.label
                              )
                            )
                          )
                            return;
                          void apply(() =>
                            deleteGreetingReference(sessionId, img.id)
                          );
                        }}
                        className="rounded-full bg-silver-950/70 p-1 text-white hover:bg-rose-500"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )}
                  <SketchSlotActions
                    className="mt-1"
                    target={{
                      type: 'session-greeting-reference',
                      id: sessionId,
                      subId: img.id,
                    }}
                    hasImage
                    originalUrl={img.originalPhotoUrl}
                    activeUrl={img.photoUrl}
                    variant={img.variant}
                    originalDeleted={img.originalDeleted}
                    description={img.description ?? img.label}
                    disabled={saving || disabled}
                    onSlot={() => void load()}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Голос в открытую форму кадра (K5): те же `setLabel`/`setDescription`,
 * что `onChange` полей, с теми же потолками (`planReferenceVoice`).
 * Сохраняет человек той же кнопкой — голос форму не отправляет, а
 * строка после «Да» называет эту кнопку (`button`).
 */
function useReferenceFormVoice(
  active: boolean,
  busy: boolean,
  button: string,
  setLabel: (v: string) => void,
  setDescription: (v: string) => void
): void {
  const { dict } = useI18n();
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets: active
      ? [
          SESSION_VOICE_TARGETS.referenceLabel,
          SESSION_VOICE_TARGETS.referenceDescription,
        ]
      : [],
    describe: (f) => describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      const plan = planReferenceVoice(active ? 'one' : 'none', busy, fields);
      if (plan.label !== undefined) setLabel(plan.label);
      if (plan.description !== undefined) setDescription(plan.description);
      const filled = plan.label !== undefined || plan.description !== undefined;
      return {
        refusals: refusalLines(plan.refused, fields, voiceTexts),
        effects: filled ? [needsSave(button)] : [],
      };
    },
  });
}

function ReferenceUploader({
  sessionId,
  voiceActive,
  onDone,
  onCancel,
  onError,
}: {
  sessionId: string;
  /** Единственная открытая форма кадра — голос пишет в неё (K5). */
  voiceActive: boolean;
  onDone: (images: GreetingReferenceImageView[]) => void;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => revokeObjectUrl(preview), [preview]);

  useReferenceFormVoice(
    voiceActive,
    uploading,
    w.addReference,
    setLabel,
    setDescription
  );

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!REFERENCE_PHOTO_MIME.includes(f.type)) {
      onError(w.referencePngJpegOnly);
      return;
    }
    if (f.size > REFERENCE_PHOTO_MAX_BYTES) {
      onError(w.fileTooLarge);
      return;
    }
    onError(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    if (!label) setLabel(f.name.replace(/\.[^.]+$/, '').slice(0, 80));
  };

  const submit = async () => {
    if (!file || !label.trim()) return;
    setUploading(true);
    setProgress(0);
    onError(null);
    try {
      const next = await uploadGreetingReference(
        sessionId,
        file,
        label.trim(),
        description.trim() || null,
        setProgress
      );
      onDone(next);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <form
      className="space-y-2 rounded-xl border border-accent/30 bg-accent/5 p-3 mb-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="relative grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-lg border border-dashed border-silver-300 text-silver-400 hover:border-accent dark:border-silver-700"
        >
          {preview ? (
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <Camera size={20} />
          )}
          {uploading && (
            <span className="absolute inset-0 grid place-items-center bg-silver-950/60 font-mono text-xs text-white tabular">
              {progress}%
            </span>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <Field label={w.referenceLabelLabel}>
            <Input
              data-qa="greeting-references-label"
              value={label}
              maxLength={80}
              placeholder={w.referenceLabelPlaceholder}
              onChange={(e) => setLabel(e.target.value)}
              disabled={uploading}
            />
          </Field>
        </div>
      </div>
      <Field
        label={w.referenceDescLabel}
        counter={`${description.length}/2000`}
      >
        <Textarea
          data-qa="greeting-references-description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
          placeholder={w.referenceDescPlaceholder}
          disabled={uploading}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={uploading}
        >
          {w.cancel}
        </Button>
        <Button
          type="submit"
          size="sm"
          icon={<Check size={14} />}
          loading={uploading}
          disabled={!file || !label.trim()}
        >
          {w.addReference}
        </Button>
      </div>
    </form>
  );
}

/**
 * Инлайн-редактирование подписи/описания уже загруженного референса —
 * тем же приёмом, что `ReferenceUploader` (форма прямо в карточке, без
 * отдельного экрана), но без файла: `updateGreetingReference` меняет
 * только текстовые поля, само изображение неизменно (заменить фото —
 * это удалить и загрузить заново, отдельного флоу не требуется).
 */
function ReferenceEditor({
  sessionId,
  image,
  voiceActive,
  onDone,
  onCancel,
}: {
  sessionId: string;
  image: GreetingReferenceImageView;
  /** Единственная открытая форма кадра — голос пишет в неё (K5). */
  voiceActive: boolean;
  onDone: (images: GreetingReferenceImageView[]) => void;
  onCancel: () => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [label, setLabel] = useState(image.label);
  const [description, setDescription] = useState(image.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useReferenceFormVoice(
    voiceActive,
    saving,
    w.saveReferenceButton,
    setLabel,
    setDescription
  );

  const submit = async () => {
    if (!label.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const next = await updateGreetingReference(sessionId, image.id, {
        label: label.trim(),
        description: description.trim() || null,
      });
      onDone(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label={w.referenceLabelLabel}>
        <Input
          data-qa="greeting-references-label"
          value={label}
          maxLength={80}
          placeholder={w.referenceLabelPlaceholder}
          onChange={(e) => setLabel(e.target.value)}
          disabled={saving}
          autoFocus
        />
      </Field>
      <Field
        label={w.referenceDescLabel}
        counter={`${description.length}/2000`}
      >
        <Textarea
          data-qa="greeting-references-description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
          placeholder={w.referenceDescPlaceholder}
          disabled={saving}
        />
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          {w.cancel}
        </Button>
        <Button
          type="submit"
          size="sm"
          icon={<Check size={14} />}
          loading={saving}
          disabled={!label.trim()}
        >
          {w.saveReferenceButton}
        </Button>
      </div>
    </form>
  );
}

// ── Шаг 3: сценарий ───────────────────────────────────────────────────────

function ScriptStep({
  sessionId,
  prompt,
  onGenerated,
  onEdited,
  videoDone,
}: {
  sessionId: string;
  prompt: GenerationPrompt | undefined;
  onGenerated: (p: GenerationPrompt) => void;
  onEdited: (r: SessionScriptEditResult) => void;
  /**
   * Ролик готов — «Пересобрать» скрыта: сценарий готового ролика на
   * месте не переписывается (сервер ответил бы 409). Правка текста при
   * этом доступна — она заводит новую версию.
   */
  videoDone: boolean;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Этап C (§3.6 п.3): текст сообщения правится здесь же. Уходит только
   * реплика — сцену сервер пересобирает из неё сам, поэтому сцена и
   * озвучка не расходятся (Г-4).
   */
  const current = prompt?.finalVoiceoverScript ?? prompt?.voiceoverScript ?? '';
  const [text, setText] = useState(current);
  const [savingText, setSavingText] = useState(false);
  const [savedText, setSavedText] = useState(false);
  const [warning, setWarning] = useState(false);
  useEffect(() => {
    setText(current);
  }, [current]);

  const saveText = async () => {
    setSavingText(true);
    setError(null);
    setSavedText(false);
    setWarning(false);
    try {
      const r = await updateGreetingScript(sessionId, text.trim());
      // Своё переведённое предупреждение, а не русская строка сервера.
      setWarning(r.registerMismatch);
      setSavedText(true);
      onEdited(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSavingText(false);
    }
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      onGenerated(await generateGreetingPrompt(sessionId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  // Голос в поле правки (K5): ПОЛНЫЙ текст в то же поле, что `onChange`,
  // с тем же потолком; сохраняет человек той же кнопкой — сервер
  // проверит текст тем же путём правки (модерация, регистр, версия).
  // Во время пересборки — отказ: ответ сервера перезапишет поле.
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets: [SESSION_VOICE_TARGETS.scriptText],
    describe: (f) => String(f.value),
    apply: (fields) => {
      const plan = planScriptVoice(!!prompt, loading || savingText, fields);
      if (plan.text !== undefined) {
        setText(plan.text);
        setSavedText(false);
      }
      return {
        refusals: refusalLines(plan.refused, fields, voiceTexts),
        effects: plan.text !== undefined ? [needsSave(w.saveScriptButton)] : [],
      };
    },
  });

  // Голосом «пересобери сценарий» (этап K3) — та же кнопка, что на
  // экране: карточка «я понял так» с действием, по «Да» — `generate`.
  // Сборка платная, поэтому молча не запускается. У готового ролика
  // кнопки нет — нет и команды (сервер ответил бы 409).
  useVoiceCommand(
    'regenerate-script',
    videoDone || loading
      ? null
      : {
          propose: () => ({
            kind: 'propose',
            card: {
              kind: 'action',
              command: 'regenerate-script',
              label: prompt ? w.regenerateScriptButton : w.generateScriptButton,
            },
          }),
          run: () => void generate(),
        }
  );

  return (
    <Card className="p-5" data-qa="greeting-script-card">
      <CardHeader
        title={w.scriptHeading}
        action={<HelpButton cardHook="greeting-script-card" />}
      />
      {error && <Alert tone="error">{error}</Alert>}
      {prompt ? (
        <div className="space-y-3">
          <Field
            label={w.editScriptLabel}
            hint={w.editScriptHint}
            counter={`${text.length}/2000`}
          >
            <Textarea
              data-qa="greeting-script-edit"
              rows={4}
              value={text}
              onChange={(e) => {
                setText(e.target.value.slice(0, 2000));
                setSavedText(false);
              }}
            />
          </Field>
          {prompt.moderationStatus === ModerationStatus.FLAGGED && (
            <Alert tone="error">{w.scriptFlaggedNote}</Alert>
          )}
          {warning && <Alert tone="warning">{w.scriptRegisterWarning}</Alert>}
          {savedText && !warning && (
            <Alert tone="success">
              <Check size={14} className="inline mr-1" />
              {w.scriptSavedNote}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<Pencil size={14} />}
              loading={savingText}
              disabled={
                !text.trim() || text.trim() === current.trim() || loading
              }
              onClick={() => void saveText()}
            >
              {w.saveScriptButton}
            </Button>
            {!videoDone && (
              <Button
                variant="outline"
                size="sm"
                icon={<RefreshCw size={14} />}
                loading={loading}
                disabled={savingText}
                onClick={() => void generate()}
              >
                {w.regenerateScriptButton}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-silver-400">{w.scriptEmpty}</p>
          <Button
            data-qa="greeting-script-generate"
            loading={loading}
            onClick={() => void generate()}
          >
            {w.generateScriptButton}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ── Характер ролика: пять карточек одной группой (этап D, §3.3) ──────────

/**
 * Голос, музыка, титры, наклейка и сцены — одна группа «настройте
 * ролик»: у них и тема справки одна (`greeting-help.ts`). Сводка сверху
 * отвечает «что уже выбрано», не заставляя листать пять карточек.
 *
 * Карточки НЕ сворачиваются: их `data-qa` — хуки сценариев обучалки,
 * и хук, спрятанный за раскрытием, упал бы на `assertVisible`. Шагом
 * степпера блок тоже не становится — степпер остаётся из четырёх.
 *
 * Правила регистра (предупреждение о своей музыке) — по серверной
 * таблице `GET /greeting/policy`; не загрузилась — предупреждений нет,
 * своих правил интерфейс не выдумывает.
 */
function CharacterBlock({
  sessionId,
  stepKey,
  brief,
}: {
  sessionId: string;
  /** Ключ пересоздания карточек: новая версия сессии — новое состояние. */
  stepKey: string;
  brief: Pick<GreetingBriefView, 'occasion' | 'occasionRegister'>;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  // Та же таблица, что у брифа, через общий хук: второй копии загрузки
  // (и второго толкования «не загрузилась») у экрана быть не должно.
  const policy = useGreetingPolicy();
  const [summary, setSummary] = useState<CharacterSummary>({});

  // Колбэки стабильны: карточки сообщают сводку из эффекта, и новая
  // функция на каждый рендер гоняла бы этот эффект впустую.
  const report = useMemo(() => {
    const one = (part: CharacterPart) => (value: string | null) =>
      setSummary((prev) =>
        prev[part] === value ? prev : { ...prev, [part]: value }
      );
    return {
      voice: one('voice'),
      music: one('music'),
      cards: one('cards'),
      sticker: one('sticker'),
      scenes: one('scenes'),
    };
  }, []);

  const rules = rulesOf(policy, characterRegister(policy, brief));
  const line = characterSummaryLine(summary, w);

  return (
    <section className="space-y-4" data-qa="greeting-character-block">
      <div>
        <h2 className="text-base font-semibold">{w.characterHeading}</h2>
        <p className="mt-0.5 text-xs text-silver-400">{w.characterHint}</p>
        {line && <p className="mt-2 text-sm">{line}</p>}
      </div>
      {/* Ключ у каждой карточки свой, с общим префиксом версии сессии:
          пять братьев с ОДНИМ ключом — это дубликат, на который React
          ругается и при смене версии может потерять или задвоить
          карточку, а её `data-qa` — хук сценария обучалки. */}
      <SenderVoiceStep
        key={`${stepKey}:voice`}
        sessionId={sessionId}
        onSummary={report.voice}
      />
      <MusicThemeStep
        key={`${stepKey}:music`}
        sessionId={sessionId}
        rules={rules}
        onSummary={report.music}
      />
      <CardsStep
        key={`${stepKey}:cards`}
        sessionId={sessionId}
        onSummary={report.cards}
      />
      <StickerStep
        key={`${stepKey}:sticker`}
        sessionId={sessionId}
        onSummary={report.sticker}
      />
      <ScenesStep
        key={`${stepKey}:scenes`}
        sessionId={sessionId}
        onSummary={report.scenes}
      />
    </section>
  );
}

// ── Голос отправителя (фича №34) ─────────────────────────────────────────

/**
 * Чьим голосом прочитать уже написанный текст.
 *
 * Стоит после сценария и до рендера, потому что смысл у него ровно
 * такой: текст есть — осталось решить, чей это голос. Отдельной
 * ступенью в шагомере не становится: шаг можно пропустить целиком, и
 * ролик получится, просто с голосом по умолчанию.
 *
 * Список клонов, запись образца, согласие и лимит — `MyVoicesSection`
 * из редактора бренда: второй реализации у этой механики быть не
 * должно.
 */
function SenderVoiceStep({
  sessionId,
  onSummary,
}: {
  sessionId: string;
  /** Значение для сводки блока «Характер ролика». */
  onSummary?: (value: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [voice, setVoice] = useState<GreetingVoiceView>({
    senderVoice: null,
    presetVoiceId: null,
  });
  const [presets, setPresets] = useState<GrokPresetVoice[] | null>(null);
  // Прочитан ли выбор с сервера. Начальное `voice` выше — заглушка для
  // экрана («голос по умолчанию»), а не знание: до ответа и после
  // ошибки сводка о голосе молчит, иначе «по умолчанию» могло бы
  // оказаться неправдой про уже выбранный клон (аудит этапа D).
  const [voiceLoaded, setVoiceLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Роестр грузится вместе с выбором: он не стоит денег (обычный
    // GET у провайдера) и нужен сразу — без него второй вариант
    // выглядел бы пустым местом.
    void Promise.all([
      getGreetingVoice(sessionId).catch(() => null),
      listGreetingPresetVoices(sessionId).catch(() => [] as GrokPresetVoice[]),
    ]).then(([v, list]) => {
      if (!alive) return;
      if (v) {
        setVoice(v);
        setVoiceLoaded(true);
      }
      setPresets(list);
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  /** @returns ошибку, показанную на экране, или `null` — сохранено (K5). */
  const apply = async (
    fn: () => Promise<GreetingVoiceView>
  ): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      setVoice(await fn());
      // Ответ на выбор — тоже прочитанное состояние, даже если первое
      // чтение не прошло.
      setVoiceLoaded(true);
      return null;
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  const chosen = voice.senderVoice || voice.presetVoiceId;
  const presetName =
    presets?.find((p) => p.voiceId === voice.presetVoiceId)?.name ??
    voice.presetVoiceId;

  // Кнопки карточки и голос (K5) — одни и те же три обработчика.
  const clear = () =>
    apply(() =>
      voice.presetVoiceId
        ? selectGreetingPresetVoice(sessionId, null)
        : selectGreetingSenderVoice(sessionId, null)
    );
  const pickClone = (voiceId: string) =>
    apply(() => selectGreetingSenderVoice(sessionId, voiceId));
  const pickPreset = (voiceId: string) =>
    apply(() => selectGreetingPresetVoice(sessionId, voiceId));

  // Готовые клоны — тот же список, что показывает `MyVoicesSection` (и тот
  // же гейт тарифа): голос выбирает только клон, который виден на экране.
  // Перечитывается после каждого выбора — новый клон, дообученный рядом,
  // станет доступен голосу со следующей реплики.
  const cloning = useFeature('voiceCloning');
  const [clones, setClones] = useState<
    Array<{ voiceId: string; label: string }>
  >([]);
  useEffect(() => {
    if (!cloning.allowed) {
      setClones([]);
      return;
    }
    let alive = true;
    listUserVoices()
      .then(
        (list) =>
          alive &&
          setClones(
            list
              .filter((v) => v.status === 'ready' && v.resembleVoiceId)
              .map((v) => ({ voiceId: v.resembleVoiceId!, label: v.label }))
          )
      )
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [cloning.allowed, voice]);

  const voiceTexts = useSessionVoiceTexts();
  const presetList = presets ?? [];
  useVoiceFieldApplier({
    targets: [
      SESSION_VOICE_TARGETS.voicePreset,
      SESSION_VOICE_TARGETS.voiceClone,
      SESSION_VOICE_TARGETS.voiceCustom,
    ],
    describe: (f) =>
      (f.target === SESSION_VOICE_TARGETS.voicePreset
        ? presetList.find((p) => p.voiceId === f.value)?.name
        : f.target === SESSION_VOICE_TARGETS.voiceClone
          ? clones.find((c) => c.voiceId === f.value)?.label
          : undefined) ?? describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      const plan = planVoiceChoice(
        {
          presets: presetList,
          clones,
          presetVoiceId: voice.presetVoiceId,
          cloneVoiceId: voice.senderVoice?.resembleVoiceId ?? null,
        },
        busy,
        fields
      );
      const a = plan.action;
      const refusals = refusalLines(plan.refused, fields, voiceTexts);
      const saving =
        a?.kind === 'clear'
          ? clear()
          : a?.kind === 'preset'
            ? pickPreset(a.voiceId)
            : a?.kind === 'clone'
              ? pickClone(a.voiceId)
              : null;
      if (!saving) return { refusals, effects: [] };
      // «Готово» — после ответа сервера, а не до него.
      return saving.then((err) => ({ refusals, effects: [saveEffect(err)] }));
    },
  });

  const summary = voiceSummary(
    voiceLoaded
      ? { senderLabel: voice.senderVoice?.label ?? null, presetName }
      : null,
    w
  );
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);

  return (
    <Card className="p-5" data-qa="greeting-voice-card">
      <CardHeader
        icon={<Mic size={18} />}
        title={w.senderVoiceHeading}
        hint={w.senderVoiceHint}
        action={
          <>
            <HelpButton cardHook="greeting-voice-card" />
            {chosen && (
              // Галочка «свой голос» (K5): «выключить» — эта же кнопка.
              <Button
                data-qa="greeting-voice-custom"
                size="sm"
                variant="ghost"
                loading={busy}
                onClick={() => void clear()}
              >
                {w.senderVoiceClear}
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <p className="text-xs text-silver-400">
        {voice.senderVoice
          ? w.senderVoicePicked.replace('{label}', voice.senderVoice.label)
          : voice.presetVoiceId
            ? w.presetVoicePicked.replace('{label}', presetName ?? '')
            : w.senderVoiceDefault}
      </p>

      <div className="mt-3" data-qa="greeting-voice-clone">
        <MyVoicesSection
          onPick={(voiceId) => void pickClone(voiceId)}
          disabled={busy}
          pickedVoiceId={voice.senderVoice?.resembleVoiceId ?? null}
        />
      </div>

      {/* Второй путь: реплику произносит сама модель. Ниже своих
          голосов, а не выше, потому что клон отправителя — то, ради
          чего эту карточку и открывают; пресет нужен тем, у кого
          клона нет. */}
      {presets !== null && presets.length > 0 && (
        <div className="mt-4 border-t border-silver-200/60 pt-3 dark:border-silver-800">
          <p className="text-sm font-medium">{w.presetVoiceHeading}</p>
          <p className="mt-0.5 text-xs text-silver-400">{w.presetVoiceHint}</p>
          {/* Оговорка про язык — не мелкий шрифт ради приличия:
              украинского нет в списке поддерживаемых языков xAI, а
              для этого продукта это основной язык половины
              аудитории. */}
          <p className="mt-1 text-xs text-silver-400">
            {w.presetVoiceLanguageNote}
          </p>
          <ul
            className="mt-2 flex flex-wrap gap-2"
            data-qa="greeting-voice-preset"
          >
            {presets.map((preset) => (
              <li key={preset.voiceId}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  active={voice.presetVoiceId === preset.voiceId}
                  onClick={() => void pickPreset(preset.voiceId)}
                >
                  {preset.name}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ── Сколько сцен снимать (фича №7) ───────────────────────────────────────

/**
 * Один непрерывный кадр или несколько склеенных встык.
 *
 * Сцены описываются раскадровкой в одном промпте, и модель рендерит
 * их одним клипом с монтажными склейками — ровно так же, как это уже
 * делает товарная ветка. Ни цена, ни время ожидания от числа сцен не
 * меняются: вызов по-прежнему один.
 *
 * Показываем длительности: выбирая число сцен, человек вправе видеть
 * последствие выбора, а не узнавать его из готового ролика.
 */
function ScenesStep({
  sessionId,
  onSummary,
}: {
  sessionId: string;
  onSummary?: (value: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [view, setView] = useState<GreetingScenesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getGreetingScenes(sessionId)
      .then((v) => alive && setView(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // Карточки нет, пока не загрузилась, — и в сводке её тоже нет.
  const summary = scenesSummary(view);
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);

  /** @returns ошибку, показанную на экране, или `null` — сохранено (K5). */
  const choose = async (sceneCount: number): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      setView(await setGreetingScenes(sessionId, sceneCount));
      return null;
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  // Голос (K5): число сцен — тот же `choose(n)`, что у кнопки; число вне
  // 1…maxScenes — отказ (других кнопок на экране нет). Хук — до раннего
  // выхода: правило хуков; пока карточки нет, целей нет.
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets: view ? [SESSION_VOICE_TARGETS.scenesCount] : [],
    describe: (f) =>
      typeof f.value !== 'string' || !/^\d+$/.test(f.value)
        ? String(f.value)
        : Number(f.value) === 1
          ? w.scenesOne
          : w.scenesMany.replace('{n}', String(Number(f.value))),
    apply: (fields) => {
      const plan = planScenesVoice(view, busy, fields);
      const refusals = refusalLines(plan.refused, fields, voiceTexts);
      if (plan.count === null) return { refusals, effects: [] };
      return choose(plan.count).then((err) => ({
        refusals,
        effects: [saveEffect(err)],
      }));
    },
  });

  if (!view) return null;

  const counts = Array.from({ length: view.maxScenes }, (_, i) => i + 1);

  return (
    <Card className="p-5" data-qa="greeting-scenes-card">
      <CardHeader
        icon={<Film size={18} />}
        title={w.scenesHeading}
        hint={w.scenesHint}
        action={<HelpButton cardHook="greeting-scenes-card" />}
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <ul className="flex flex-wrap gap-2" data-qa="greeting-scenes-count">
        {counts.map((n) => (
          <li key={n}>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              active={view.sceneCount === n}
              onClick={() => void choose(n)}
            >
              {n === 1 ? w.scenesOne : w.scenesMany.replace('{n}', String(n))}
            </Button>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs text-silver-400">
        {view.sceneCount === 1
          ? w.scenesSingleNote
          : w.scenesSplitNote.replace(
              '{parts}',
              view.durations
                .map((d) => `${d}${w.musicSecondsSuffix}`)
                .join(' + ')
            )}
      </p>
    </Card>
  );
}

// ── Наклейка поверх кадра (фича №8) ──────────────────────────────────────

/**
 * Поиск наклейки на Pixabay и её положение в кадре.
 *
 * Ссылка на источник показана у каждой находки не из вежливости:
 * условия API Pixabay требуют показывать, откуда картинки, всякий раз,
 * когда выдача отображается. Сама лицензия атрибуции не требует — это
 * разные документы, и обязывает нас первый.
 *
 * Скачивает картинку сервер, а не браузер: те же условия запрещают
 * постоянный хотлинк, поэтому в ролик уходит уже наша копия.
 */
function StickerStep({
  sessionId,
  onSummary,
}: {
  sessionId: string;
  onSummary?: (value: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [view, setView] = useState<GreetingStickerView | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    searchGreetingStickers(sessionId, '')
      .then((v) => alive && setView(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sessionId]);

  /** @returns ошибку, показанную на экране, или `null` — сохранено (K5). */
  const run = async (
    fn: () => Promise<GreetingStickerView>
  ): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      setView(await fn());
      return null;
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  // Нет ключа Pixabay и нечего снимать — карточки нет вовсе (хук
  // `greeting-sticker-card` объявляет это как `absentWhen`), и в сводке
  // её тоже нет: правило одно, `stickerCardHidden`. Запрос не прошёл —
  // `view` остаётся `null`, и сводка молчит, а не говорит «нет».
  const hidden = stickerCardHidden(view);
  const summary = stickerSummary(view, w);
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);

  const placementLabels: Record<string, string> = {
    'top-left': w.stickerTopLeft,
    'top-right': w.stickerTopRight,
    'bottom-left': w.stickerBottomLeft,
    'bottom-right': w.stickerBottomRight,
    center: w.stickerCenter,
    full: w.stickerFull,
  };

  // Кнопки карточки и голос (K5) — одни и те же обработчики.
  const clear = () => run(() => clearGreetingSticker(sessionId));
  const move = (placement: string) =>
    run(() => moveGreetingSticker(sessionId, placement));

  // Голос (K5): место — тот же `move`, «без наклейки» — тот же `clear`,
  // строка поиска — то же поле (без запуска поиска: выдачу сервер разбора
  // не видит, картинку выбирают руками). Под запретом регистра — отказ
  // той же строкой, что на экране. Хук — до раннего выхода.
  const voiceTexts = useSessionVoiceTexts();
  const onScreen = !!view && !hidden;
  useVoiceFieldApplier({
    targets: onScreen
      ? [
          SESSION_VOICE_TARGETS.stickerQuery,
          SESSION_VOICE_TARGETS.stickerPlacement,
          SESSION_VOICE_TARGETS.stickerEnabled,
        ]
      : [],
    describe: (f) =>
      f.target === SESSION_VOICE_TARGETS.stickerPlacement &&
      typeof f.value === 'string'
        ? (placementLabels[f.value] ?? f.value)
        : describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      const plan = planStickerVoice(
        onScreen && view
          ? {
              selected: view.selected,
              configured: view.configured,
              allowed: view.allowed !== false,
            }
          : null,
        busy,
        fields
      );
      if (plan.query !== undefined) setQuery(plan.query);
      const refusals = refusalLines(plan.refused, fields, voiceTexts);
      // Строка поиска ждёт кнопку «Найти»; место и «убрать» сохраняет
      // тот же обработчик, что у кнопок, — ждём его ответа.
      const typed =
        plan.query !== undefined ? [needsSave(w.stickerSearch)] : [];
      const saving =
        plan.action?.kind === 'clear'
          ? clear()
          : plan.action?.kind === 'move'
            ? move(plan.action.placement)
            : null;
      if (!saving) return { refusals, effects: typed };
      return saving.then((err) => ({
        refusals,
        effects: [saveEffect(err), ...typed],
      }));
    },
  });

  if (!view || hidden) return null;
  // У торжественных, деликатных и траурных поводов наклеек нет (сервер
  // откажет в выборе): поиск картинок нельзя ограничить настроением.
  // Этап D: карточка не пропадает молча, а объясняет почему — пустое
  // место на месте знакомой секции выглядит поломкой. Уже выбранную
  // раньше наклейку показываем — её нужно иметь возможность снять.
  const stickersAllowed = view.allowed !== false;

  return (
    <Card className="p-5" data-qa="greeting-sticker-card">
      <CardHeader
        icon={<Sticker size={18} />}
        title={w.stickerHeading}
        hint={w.stickerHint}
        action={
          <>
            <HelpButton cardHook="greeting-sticker-card" />
            {view.selected && (
              // Галочка «наклейка» (K5): «выключить» — эта же кнопка.
              <Button
                data-qa="greeting-sticker-enabled"
                size="sm"
                variant="ghost"
                loading={busy}
                onClick={() => void clear()}
              >
                {w.stickerClear}
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {view.selected && (
        <div className="mb-3 flex items-center gap-3 rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
          <img
            src={view.selected.url}
            alt=""
            className="h-14 w-14 shrink-0 object-contain"
          />
          <div className="min-w-0">
            <p className="text-xs text-silver-400">{w.stickerPicked}</p>
            <ul
              className="mt-1.5 flex flex-wrap gap-1.5"
              data-qa="greeting-sticker-placement"
            >
              {STICKER_PLACEMENTS.map((placement) => (
                <li key={placement}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    active={view.selected?.placement === placement}
                    onClick={() => void move(placement)}
                  >
                    {placementLabels[placement]}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {!stickersAllowed && (
        <p className="text-xs text-silver-400">{w.stickerUnavailable}</p>
      )}

      {view.configured && stickersAllowed && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              data-qa="greeting-sticker-query"
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, 100))}
              placeholder={w.stickerSearchPlaceholder}
              disabled={busy}
            />
            <Button
              size="sm"
              loading={busy}
              disabled={!query.trim()}
              onClick={() =>
                void run(() => searchGreetingStickers(sessionId, query.trim()))
              }
            >
              {w.stickerSearch}
            </Button>
          </div>

          {view.results.length > 0 && (
            <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {view.results.map((r) => (
                <li key={r.id} className="text-center">
                  <button
                    type="button"
                    disabled={busy}
                    className="block w-full rounded-xl border border-silver-200/70 p-2 hover:border-sky-400 disabled:opacity-50 dark:border-silver-800"
                    onClick={() =>
                      void run(() =>
                        selectGreetingSticker(sessionId, query.trim(), r.id)
                      )
                    }
                  >
                    <img
                      src={r.previewUrl}
                      alt={r.tags}
                      className="mx-auto h-16 w-16 object-contain"
                    />
                  </button>
                  {/* Требование условий API, а не вежливость. */}
                  <a
                    href={r.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block text-[10px] text-silver-400 underline"
                  >
                    Pixabay
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

// ── Карточки: титульная и закрывающая (фичи №38/№39) ─────────────────────

/**
 * Две подписи поверх кадра: в начале и в конце.
 *
 * Титульная НЕ подставляется сама, хотя имя получателя у нас есть:
 * она называет его в первую же секунду, а половина поздравлений —
 * сюрприз. Предупреждение стоит рядом, подставить заготовку можно в
 * один клик — но это решение отправителя, а не наше.
 */
function CardsStep({
  sessionId,
  onSummary,
}: {
  sessionId: string;
  onSummary?: (value: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [view, setView] = useState<GreetingCardsView | null>(null);
  const [title, setTitle] = useState('');
  const [closing, setClosing] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getGreetingCards(sessionId)
      .then((v) => {
        if (!alive) return;
        setView(v);
        setTitle(v.cards.title ?? '');
        setClosing(v.cards.closing ?? '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sessionId]);

  /**
   * Значения — явным аргументом, а не из замыкания: голос (K5) кладёт
   * текст в поле и сразу сохраняет, а `setTitle` до следующего рендера
   * замыкание не обновит. Кнопка зовёт с текущими полями.
   *
   * `keep` — поле, набранное руками и НЕ сохранённое, которое голос не
   * трогал: ответ сервера его не перезаписывает (в сервер ушло прежнее
   * сохранённое значение, `cardsVoiceSave`).
   *
   * @returns ошибку, показанную на экране, или `null` — сохранено (K5).
   */
  const save = async (
    values = { title, closing },
    keep: { title: boolean; closing: boolean } = {
      title: false,
      closing: false,
    }
  ): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      const next = await updateGreetingCards(sessionId, {
        title: values.title.trim() || null,
        closing: values.closing.trim() || null,
      });
      setView(next);
      if (!keep.title) setTitle(next.cards.title ?? '');
      if (!keep.closing) setClosing(next.cards.closing ?? '');
      setSaved(true);
      return null;
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  // Голос (K5): текст — в те же поля, что `onChange` (тот же потолок),
  // затем то же «Сохранить». Пустая строка — убрать титр, как стёртое
  // руками поле. Хук — до раннего выхода.
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets: view
      ? [SESSION_VOICE_TARGETS.cardsTitle, SESSION_VOICE_TARGETS.cardsClosing]
      : [],
    describe: (f) => describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      const plan = planCardsVoice(!!view, busy, fields);
      const refusals = refusalLines(plan.refused, fields, voiceTexts);
      const s = cardsVoiceSave(plan, view?.cards ?? null);
      if (!s) return { refusals, effects: [] };
      // В поле — только продиктованное; второе поле остаётся как набрано
      // руками, а в сервер уходит его СОХРАНЁННОЕ значение.
      if (plan.title !== undefined) setTitle(plan.title);
      if (plan.closing !== undefined) setClosing(plan.closing);
      setSaved(false);
      return save(s.values, s.keep).then((err) => ({
        refusals,
        effects: [saveEffect(err)],
      }));
    },
  });

  // По сохранённому, а не по набранному: сводка — о том, что уйдёт в ролик.
  const summary = cardsSummary(view?.cards ?? null, w);
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);

  if (!view) return null;

  const dirty =
    title.trim() !== (view.cards.title ?? '') ||
    closing.trim() !== (view.cards.closing ?? '');

  return (
    <Card className="p-5" data-qa="greeting-cards-card">
      <CardHeader
        icon={<Type size={18} />}
        title={w.cardsHeading}
        hint={w.cardsHint}
        action={<HelpButton cardHook="greeting-cards-card" />}
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className="space-y-3">
        <Field label={w.cardsTitleLabel} hint={w.cardsTitleHint}>
          <Input
            data-qa="greeting-cards-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value.slice(0, MAX_GREETING_CARD_LENGTH));
              setSaved(false);
            }}
            placeholder={view.suggested.title ?? ''}
            disabled={busy}
          />
        </Field>
        {!title && view.suggested.title && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setTitle(view.suggested.title ?? '');
              setSaved(false);
            }}
          >
            {w.cardsUseSuggestion.replace('{text}', view.suggested.title)}
          </Button>
        )}

        <Field label={w.cardsClosingLabel} hint={w.cardsClosingHint}>
          <Input
            data-qa="greeting-cards-closing"
            value={closing}
            onChange={(e) => {
              setClosing(e.target.value.slice(0, MAX_GREETING_CARD_LENGTH));
              setSaved(false);
            }}
            placeholder={view.suggested.closing ?? ''}
            disabled={busy}
          />
        </Field>
        {!closing && view.suggested.closing && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setClosing(view.suggested.closing ?? '');
              setSaved(false);
            }}
          >
            {w.cardsUseSuggestion.replace('{text}', view.suggested.closing)}
          </Button>
        )}

        <Button
          size="sm"
          loading={busy}
          disabled={!dirty}
          onClick={() => void save()}
        >
          {saved && !dirty ? w.cardsSaved : w.cardsSave}
        </Button>
      </div>
    </Card>
  );
}

// ── Музыкальная подложка (фича №4) ───────────────────────────────────────

/**
 * Музыка под поздравление.
 *
 * Секции нет вовсе, пока каталог пуст: темы — лицензированные файлы,
 * их загружает владелец продукта, и до первой загруженной темы
 * показывать тут нечего. Это же и путь выката — код уезжает в прод
 * тёмным.
 *
 * Список тем приходит уже отфильтрованным по поводу сессии: у
 * соболезнования и дня рождения общей подложки не бывает ни при каком
 * тоне.
 */
function MusicThemeStep({
  sessionId,
  rules = null,
  onSummary,
}: {
  sessionId: string;
  /** Правила регистра брифа; `null` — таблица не загрузилась. */
  rules?: GreetingRegisterRules | null;
  onSummary?: (value: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [music, setMusic] = useState<GreetingMusicView | null>(null);
  // Прочитано ли состояние с сервера. После ошибки `music` — запасная
  // пустая витрина для экрана, и «Музыка: нет» по ней было бы
  // выдумкой: тема могла быть выбрана (аудит этапа D).
  const [musicLoaded, setMusicLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getGreetingMusic(sessionId)
      .then((m) => {
        if (!alive) return;
        setMusic(m);
        setMusicLoaded(true);
      })
      // Запрос не прошёл — показываем пустую витрину, но БЕЗ блока
      // поиска: настроена библиотека или нет, мы в этот момент не
      // знаем, а рисовать поиск «на всякий случай» — ровно та ложь,
      // из-за которой признак и стал обязательным.
      .catch(
        () =>
          alive &&
          setMusic({ themes: [], selected: null, libraryEnabled: false })
      );
    return () => {
      alive = false;
    };
  }, [sessionId]);

  /** @returns ошибку, показанную на экране, или `null` — сохранено (K5). */
  const apply = async (
    fn: () => Promise<GreetingMusicView>
  ): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      setMusic(await fn());
      setMusicLoaded(true);
      return null;
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  const choose = (themeId: string | null) =>
    apply(() => selectGreetingMusic(sessionId, themeId));

  // Раньше секции не было вовсе, пока каталог пуст. Со своей музыкой
  // это перестало быть верным: загрузить трек можно и без каталога —
  // ждём только первой загрузки состояния.
  const summary = musicSummary(musicLoaded ? music : null, w);
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);

  // Голос (K5): тема — тот же `choose(id)`, «без музыки» — тот же
  // `choose(null)`, что «Убрать»; тема — только из списка на экране (он
  // уже отфильтрован поводом). Строка поиска библиотеки — то же поле, без
  // запуска поиска. Хук — до раннего выхода.
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets: music
      ? [
          SESSION_VOICE_TARGETS.musicTheme,
          SESSION_VOICE_TARGETS.musicEnabled,
          SESSION_VOICE_TARGETS.musicQuery,
        ]
      : [],
    describe: (f) =>
      (f.target === SESSION_VOICE_TARGETS.musicTheme
        ? music?.themes.find((t) => t.id === f.value)?.title
        : undefined) ?? describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      const plan = planMusicVoice(music, busy, fields);
      if (plan.query !== undefined) setQuery(plan.query);
      const refusals = refusalLines(plan.refused, fields, voiceTexts);
      // Строка поиска ждёт кнопку «Искать»; тему и «без музыки» сохраняет
      // тот же `choose`, что у кнопок, — ждём его ответа.
      const typed =
        plan.query !== undefined ? [needsSave(w.musicLibrarySearch)] : [];
      if (plan.choose === undefined) return { refusals, effects: typed };
      return choose(plan.choose).then((err) => ({
        refusals,
        effects: [saveEffect(err), ...typed],
      }));
    },
  });

  if (!music) return null;

  // §3.5: у деликатного и траурного регистров своя музыка разрешена «с
  // предупреждением». Каталог сервер уже отфильтровал по поводу, а
  // загрузку, ссылку и библиотеку — нет: за уместность трека отвечает
  // человек, и сказать ему об этом нужно до выбора, а не после ролика.
  // Выдача библиотеки на экране — тоже «добавляю своё»: выбор из неё
  // делается в один клик, и предупреждение после клика опоздало бы.
  const ownMusicWarning = showOwnMusicWarning(rules, {
    adding: adding || (music.library?.length ?? 0) > 0,
    selected: music.selected,
  });

  return (
    <Card className="p-5" data-qa="greeting-music-card">
      <CardHeader
        icon={<Music size={18} />}
        title={w.musicHeading}
        hint={w.musicHint}
        action={
          <>
            <HelpButton cardHook="greeting-music-card" />
            {music.selected && (
              // Галочка «музыка» (K5): «выключить» — эта же кнопка.
              <Button
                data-qa="greeting-music-enabled"
                size="sm"
                variant="ghost"
                loading={busy}
                onClick={() => void choose(null)}
              >
                {w.musicClear}
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <p className="text-xs text-silver-400">
        {music.selected
          ? w.musicPicked.replace('{title}', music.selected.title)
          : w.musicEmpty}
      </p>
      {/* Упоминание автора не спрятано в мелкий шрифт: оно поедет в
          сам ролик, и человек должен это знать заранее. */}
      {music.selected?.attribution && (
        <p className="mt-1 text-xs text-silver-400">
          {w.musicCreditNote.replace('{credit}', music.selected.attribution)}
        </p>
      )}

      {ownMusicWarning && (
        <Alert tone="info" className="mt-3">
          {w.ownMusicWarning}
        </Alert>
      )}

      {music.themes.length > 0 && (
        <ul
          className="mt-3 flex flex-wrap gap-2"
          data-qa="greeting-music-theme"
        >
          {music.themes.map((theme) => (
            <li key={theme.id}>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                active={
                  music.selected?.source !== 'upload' &&
                  music.selected?.id === theme.id
                }
                onClick={() => void choose(theme.id)}
              >
                {theme.title}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Библиотека со свободной лицензией. Показывается только когда
          хоть один источник настроен: без ключей искать негде.
          Условие прямое, а не `!== false`: признак приходит с первым
          же GET, и «поля нет» больше не значит «наверное, есть». */}
      {music.libraryEnabled && (
        <div className="mt-3 border-t border-silver-200/60 pt-3 dark:border-silver-800">
          <p className="text-xs text-silver-400">{w.musicLibraryHint}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              data-qa="greeting-music-query"
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, 100))}
              placeholder={w.musicLibraryPlaceholder}
              disabled={busy}
            />
            <Button
              size="sm"
              loading={busy}
              disabled={!query.trim()}
              onClick={() =>
                void apply(() =>
                  searchGreetingMusicLibrary(sessionId, query.trim())
                )
              }
            >
              {w.musicLibrarySearch}
            </Button>
          </div>

          {music.library && music.library.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {music.library.map((t) => (
                <li
                  key={`${t.provider}:${t.providerTrackId}`}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-silver-200/70 p-2 dark:border-silver-800"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {t.title}
                      {t.artist ? ` — ${t.artist}` : ''}
                    </p>
                    {/* Лицензия видна ДО выбора: человек должен
                        понимать, что берёт и на каких условиях. */}
                    <p className="text-[11px] text-silver-400">
                      {t.licenseType} · {Math.round(t.durationSec)}
                      {w.musicSecondsSuffix}
                      {t.attribution ? ` · ${w.musicAttributionRequired}` : ''}
                    </p>
                  </div>
                  {t.previewUrl && (
                    <audio
                      controls
                      preload="none"
                      src={t.previewUrl}
                      className="h-8 max-w-[180px]"
                    />
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void apply(() =>
                        selectGreetingMusicFromLibrary(
                          sessionId,
                          query.trim(),
                          t.provider,
                          t.providerTrackId
                        )
                      )
                    }
                  >
                    {w.musicLibraryPick}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-3 border-t border-silver-200/60 pt-3 dark:border-silver-800">
        {adding ? (
          <MusicUploader
            sessionId={sessionId}
            onDone={(next) => {
              setAdding(false);
              setMusic(next);
            }}
            onCancel={() => setAdding(false)}
            onError={setError}
          />
        ) : (
          <Button
            size="sm"
            variant="outline"
            icon={<Upload size={14} />}
            disabled={busy}
            onClick={() => setAdding(true)}
          >
            {w.musicUploadButton}
          </Button>
        )}
      </div>
    </Card>
  );
}

/**
 * Загрузка своей музыки.
 *
 * Подтверждение прав — не формальность: готовый ролик человек
 * отправляет другому человеку, и чужая фонограмма в нём это
 * распространение, а не личное прослушивание. Тот же гейт и та же
 * форма, что у согласия на клонирование голоса.
 */
function MusicUploader({
  sessionId,
  onDone,
  onCancel,
  onError,
}: {
  sessionId: string;
  onDone: (music: GreetingMusicView) => void;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [rights, setRights] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!GREETING_MUSIC_ACCEPT.split(',').includes(f.type)) {
      onError(w.musicFormatOnly);
      return;
    }
    if (f.size > MAX_GREETING_MUSIC_BYTES) {
      onError(w.fileTooLarge);
      return;
    }
    onError(null);
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').slice(0, 80));
  };

  // Два способа дать трек — файл или ссылка. Оба ведут в одно и то же
  // место и оба требуют подтверждения прав: разница только в том, у
  // кого лежит файл.
  const ready = (file || url.trim()) && rights;

  const submit = async () => {
    if (!ready) return;
    setUploading(true);
    setProgress(0);
    onError(null);
    try {
      onDone(
        file
          ? await uploadGreetingMusic(
              sessionId,
              file,
              title.trim(),
              rights,
              setProgress
            )
          : await linkGreetingMusic(sessionId, url.trim(), title.trim(), rights)
      );
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <input
        ref={fileRef}
        type="file"
        accept={GREETING_MUSIC_ACCEPT}
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={uploading || !!url.trim()}
          onClick={() => fileRef.current?.click()}
        >
          {file ? file.name : w.musicPickFile}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={uploading}
          onClick={onCancel}
        >
          {w.cancelButton}
        </Button>
      </div>

      {!file && (
        <Field label={w.musicLinkLabel} hint={w.musicLinkHint}>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value.trim())}
            placeholder="https://…"
            disabled={uploading}
          />
        </Field>
      )}

      {(file || url.trim()) && (
        <>
          <Field label={w.musicTitleLabel}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 80))}
              disabled={uploading}
            />
          </Field>
          <label className="flex cursor-pointer gap-2 text-xs leading-relaxed">
            <input
              type="checkbox"
              checked={rights}
              onChange={(e) => setRights(e.target.checked)}
              disabled={uploading}
              className="mt-0.5 h-4 w-4 shrink-0 accent-sky-400"
            />
            <span>{w.musicRightsLabel}</span>
          </label>
          <Button
            size="sm"
            loading={uploading}
            disabled={!ready || uploading}
            onClick={() => void submit()}
          >
            {uploading && file ? `${progress}%` : w.musicUploadSubmit}
          </Button>
        </>
      )}
    </div>
  );
}

// ── Шаг 4: видео ──────────────────────────────────────────────────────────

function isTerminal(video: GeneratedVideo | undefined): boolean {
  return (
    !!video &&
    video.status !== GenerationStatus.PENDING &&
    video.status !== GenerationStatus.PROCESSING
  );
}

function VideoStep({
  sessionId,
  video,
  onVideo,
  recipientName,
  senderName,
  consentBrief,
  prompt,
}: {
  sessionId: string;
  video: GeneratedVideo | undefined;
  onVideo: (v: GeneratedVideo | undefined) => void;
  /** Имена из брифа — только для текста сообщения при вручении (№26). */
  recipientName: string;
  senderName?: string | null;
  /** K7: бриф и сценарий — для сводки перед согласием голосом (§4А.7.4). */
  consentBrief: GreetingBriefView;
  prompt: GenerationPrompt | undefined;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [starting, setStarting] = useState(false);
  // Стена бесплатного (этап 132) — отдельно от `error`: это не ошибка,
  // а состояние «нужен доступ», и рисуется оно по-другому.
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlight = useRef(false);
  const startingRef = useRef(false);
  // Готовый ролик, играющий вслух, микрофон помощника не пишет как речь
  // (`media-playback.ts`, аудит волны 2). Один реф на компонент.
  const [videoPlaybackRef] = useState(() => mediaPlaybackRef());

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    inFlight.current = false;
    pollRef.current = setInterval(async () => {
      if (inFlight.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      inFlight.current = true;
      try {
        const status = await getGreetingVideoStatus(sessionId);
        if (status) onVideo(status);
        if (isTerminal(status)) stopPolling();
      } catch {
        stopPolling();
      } finally {
        inFlight.current = false;
      }
    }, POLL_INTERVAL_MS);
  }, [sessionId, stopPolling, onVideo]);

  useEffect(() => {
    if (video && !isTerminal(video)) startPolling();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- запуск только по смене sessionId
  }, [sessionId]);

  const start = async () => {
    // Повторный вход — двойное нажатие или нажатие поверх голосового
    // старта: `starting` из замыкания ещё прежний, ref — уже нет (K7).
    if (startingRef.current) return;
    startingRef.current = true;
    // Нажали сами — сводка для голоса больше не нужна (K7).
    consent.cancel();
    setStarting(true);
    setError(null);
    setLocked(false);
    try {
      const v = await startGreetingVideo(sessionId);
      onVideo(v);
      if (!isTerminal(v)) startPolling();
    } catch (e) {
      // Стена бесплатного (этап 132) — не поломка, и красной строкой её
      // показывать нельзя: человеку нужно «чем открывается», а не «что
      // сломалось». Тот же разбор, что в мастере товарки.
      if (isGenerationLocked(e)) {
        setLocked(true);
        // Четвёртое событие §12.2: стена стоит в ТРЁХ стартах рендера,
        // и считать её только в товарке значило бы недосчитать ровно
        // тех, кто пришёл за поздравлением.
        recordInviteEvent('wall');
      } else setError(errorMessage(e));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  // K7 (§4А.7.4): согласие голосом нажимает ЭТУ ЖЕ кнопку — `start`, —
  // но только после сводки с ценой. Кнопка при этом остаётся: голос —
  // второй путь к ней, а не замена.
  const consent = useRenderVoiceConsent({
    facts: {
      sessionId,
      promptId: prompt?.promptId ?? null,
      scriptText: prompt?.finalText ?? '',
      recipient: consentBrief.recipientName,
      occasion: consentBrief.occasion,
      customOccasion: consentBrief.customOccasionText,
      resolution: consentBrief.resolution,
      presenter: consentBrief.presenterProvider,
    },
    occasionLabel:
      consentBrief.occasion === 'OTHER' && consentBrief.customOccasionText
        ? consentBrief.customOccasionText
        : w.occasion[consentBrief.occasion],
    qualityLabel: `${consentBrief.resolution} · ${
      consentBrief.presenterProvider === 'hedra'
        ? w.providerHedra
        : w.providerGrok
    }`,
    block: starting
      ? 'busy'
      : !video || video.status === GenerationStatus.FAILED
        ? null
        : video.status === GenerationStatus.COMPLETE
          ? 'done'
          : 'in-progress',
    start: () => void start(),
  });

  return (
    <>
      <Card className="p-5" data-qa="greeting-video-card">
        <CardHeader
          title={w.videoHeading}
          action={<HelpButton cardHook="greeting-video-card" />}
        />
        {error && <Alert tone="error">{error}</Alert>}

        {consent.summary && (
          <VoiceConsentCard
            summary={consent.summary}
            buttonLabel={
              video?.status === GenerationStatus.FAILED
                ? w.retryButton
                : w.generateVideoButton
            }
            onCancel={consent.cancel}
          />
        )}

        {!video && (
          <Button
            data-qa="greeting-render"
            loading={starting}
            onClick={() => void start()}
          >
            {w.generateVideoButton}
          </Button>
        )}

        {locked && (
          <Alert tone="info" className="mt-3">
            <p className="font-medium">{dict.generationLocked.title}</p>
            <p className="mt-1">{dict.generationLocked.body}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => navigate(routes.invite())}>
                {dict.generationLocked.invite}
              </Button>
              <Button
                variant="outline"
                onClick={() => navigate(routes.credits())}
              >
                {dict.generationLocked.buy}
              </Button>
            </div>
          </Alert>
        )}

        {video && video.status === GenerationStatus.PENDING && (
          <Alert tone="info">
            <Spinner size={14} className="inline mr-2" />
            {w.videoPending}
          </Alert>
        )}
        {video && video.status === GenerationStatus.PROCESSING && (
          <Alert tone="info">
            <Spinner size={14} className="inline mr-2" />
            {w.videoProcessing}
          </Alert>
        )}
        {video && video.status === GenerationStatus.FAILED && (
          <div className="space-y-2">
            <Alert tone="error">{video.error?.message ?? w.videoFailed}</Alert>
            <Button loading={starting} onClick={() => void start()}>
              {w.retryButton}
            </Button>
          </div>
        )}
        {video && video.status === GenerationStatus.COMPLETE && (
          <div className="space-y-3">
            <Badge tone="success">{w.videoReady}</Badge>
            {video.downloadUrl && (
              <video
                ref={videoPlaybackRef}
                src={video.downloadUrl}
                controls
                className="w-full rounded-xl border border-silver-200/70 dark:border-silver-800"
              />
            )}
            {video.downloadUrl && (
              <a
                href={video.downloadUrl}
                download
                target="_blank"
                rel="noreferrer"
              >
                <Button icon={<Download size={14} />}>
                  {w.downloadButton}
                </Button>
              </a>
            )}
          </div>
        )}
      </Card>

      {/* Фича №26 — вручение. Отдельной карточкой под роликом, а не
          кнопкой в ряду со «Скачать»: скачивание — про файл у себя,
          вручение — про другого человека, и путать их не стоит. */}
      {video &&
        video.status === GenerationStatus.COMPLETE &&
        video.downloadUrl && (
          <GreetingDeliveryPanel
            dict={dict}
            videoUrl={video.downloadUrl}
            recipientName={recipientName}
            senderName={senderName}
          />
        )}

      {/* Переозвучка/экспорт/публикация — общий постпродакшен-пайплайн,
        тот же, что у SINGLE/LINE (`GenerationWizard.tsx`): отдельная
        сессия сама по себе достаточна для `/postprod/:sessionId` —
        `PostprodVideoScreen`/`PublishPanel`/`ExportPanel` уже
        product-агностичны (`session.productInformation` читается только
        как необязательный fallback для названия/описания при публикации,
        см. `publication.service.ts`) и не требуют `ProductItem`. */}
      {video && video.status === GenerationStatus.COMPLETE && (
        <Card className="p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">
                {dict.generationWizard.postprodCtaTitle}
              </h3>
              <p className="mt-0.5 text-xs text-silver-400">
                {dict.generationWizard.postprodCtaHint}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => navigate(routes.postprodVideo(sessionId))}
            >
              {dict.generationWizard.postprodCtaButton}
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}
