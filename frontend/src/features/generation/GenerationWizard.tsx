/**
 * GenerationWizard — the existing Session-based ad-generation flow
 * (upload → analysis → product → prompt → video), extracted verbatim from
 * the old App.tsx body and restyled. Business logic lives in
 * hooks/useWorkflow.ts and is untouched. Route: #/generate.
 *
 * Entered either anonymously ("quick generation") or from a ProductItem
 * (ProjectScreen → createSessionFromItem, the session then carries the
 * product + brand-manifest snapshots, spec §7.8/§12). Later stages added
 * the character casting + manifest copy (analysis step), reference slots
 * + aspect ratio (generation step), audit and publication (result step).
 */

import { useReportHere } from '../../lib/report-location';
import { useState, useEffect, useRef } from 'react';
import {
  Clapperboard,
  Download,
  ImagePlus,
  Lock,
  Palette,
  Sparkles,
  Type as TypeIcon,
  Video,
} from 'lucide-react';
import { useWorkflow } from '../../hooks/useWorkflow';
import { toStepsView } from '../../lib/wizard-steps';
import { ReadinessPanel } from '../../components/ReadinessPanel';
import { HintLine } from '../../components/HintLine';
import { useWizardEvents } from '../../lib/useWizardEvents';
import { getSessionReadiness } from '../../services/api';
import { recordInviteEvent } from '../../services/invite-api';
import {
  getWizardGuide,
  setWizardGuide,
} from '../../services/wizard-guide-api';
import type { Readiness, WizardGuideState } from '../../types';
import {
  STEPPER_IDS,
  stepperIdOf,
  stepperIdsFor,
  stepperLabels,
} from '../../lib/session-step';
import { VideoUpload } from '../../components/VideoUpload';
import { AnalysisDisplay } from '../../components/AnalysisDisplay';
import { ProgressIndicator } from '../../components/ProgressIndicator';
import { ProductInput } from '../../components/ProductInput';
import { PromptEditor } from '../../components/PromptEditor';
import { ImageUpload } from '../../components/ImageUpload';
import { VideoPlayer } from '../../components/VideoPlayer';
import { VideoProcessingStatus } from '../../components/VideoProcessingStatus';
import { CharacterCasting } from './CharacterCasting';
import { AnalysisInsights } from './AnalysisInsights';
import { RelevancePanel } from './RelevancePanel';
import { SceneCasting, type HighlightFocus } from './SceneCasting';
import { TermsGate } from '../../components/TermsGate';
import {
  BrandSnapshotEditor,
  type BrandSnapshotEditorHandle,
} from './BrandSnapshotEditor';
import { AuditPanel } from './AuditPanel';
import { SoundCheckPanel } from './SoundCheckPanel';
import { CatalogBatchPanel } from './CatalogBatchPanel';
import { AbTestPanel } from './AbTestPanel';
import { AspectRatioPicker } from './AspectRatioPicker';
import { ReferenceSlotsPanel } from './ReferenceSlotsPanel';
import {
  Alert,
  Busy,
  Button,
  Card,
  CardHeader,
  FeaturePanel,
  LockedNote,
  Pills,
} from '../../components/ui';
import type { VideoQuality } from '../../services/api';
import {
  getCostEstimate,
  getDefaultVideoProvider,
  ensureTextCards,
  type OnScreenTextMoment,
} from '../../services/api';
import { navigate, routes } from '../../lib/router';
import { voiceModeHint } from '../../lib/voice-mode';
import type { VoiceMode } from '../../types';
import { useFeature } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';

export function GenerationWizard() {
  const { dict, locale } = useI18n();
  const [videoQuality, setVideoQuality] = useState<VideoQuality>('fast');
  // Доп. запрос владельца продукта: Grok как второй провайдер видео
  // (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §10–11, этап 1 плана
  // реализации, §14). У Grok нет понятия `quality` — своя ось,
  // разрешение (§11.2 ТЗ) — переключатель качества заменяется
  // переключателем разрешения, когда выбран Grok, а не добавляется
  // третьим полем.
  // Доп. запрос владельца продукта: Grok — фолбэк на время загрузки
  // настройки оператора ниже (useEffect, ТЗ §11.1/§20) — больше слотов
  // для референсов (7 против 3 у Veo), значит и для text-card из §20,
  // и для персонажей одновременно, без риска 400 при их сумме.
  const [videoProvider, setVideoProvider] = useState<'veo' | 'grok'>('grok');
  const [grokResolution, setGrokResolution] = useState<
    '480p' | '720p' | '1080p'
  >('480p');
  // Доп. запрос владельца продукта: ролик длиннее 8 секунд через Scene
  // Extension (ТЗ §9, этап 4 плана §14). `8` = обычная генерация, как
  // раньше — сервер игнорирует значения не больше базовой длительности.
  const [targetDuration, setTargetDuration] = useState(8);
  // Доп. запрос владельца продукта: поле «Чего избежать» (ТЗ §1/§6,
  // этап 5 плана §14) — найдено при аудите: бекенд был готов, но поле
  // ввода в интерфейсе отсутствовало вовсе, фича была недостижима.
  const [avoidText, setAvoidText] = useState('');
  const [costEstimate, setCostEstimate] = useState<{
    costUsd: number;
    unpriced: boolean;
    segments: number;
    targetDurationSeconds: number;
    wasCapped: boolean;
  } | null>(null);

  // Spec §16: the ad's picture format — starts from the reference's frame
  // once detected; the user can pick any standard ratio or a custom W:H.
  const [aspectRatio, setAspectRatio] = useState<string | null>(null);

  const {
    currentStep,
    isInitializing,
    isUploading,
    isAnalyzing,
    analysis,
    isSubmittingProduct,
    prompt,
    isGeneratingPrompt,
    isUpdatingPrompt,
    isApprovingPrompt,
    productImagePreview,
    productSketchUrl,
    productOriginalPhotoUrl,
    isUploadingImage,
    imageUploadProgress,
    generatedVideo,
    videoHistory,
    isGeneratingVideo,
    generationLocked,
    originalVideoUrl,
    error,
    prefilledFromProject,
    projectId,
    productName,
    productDescription,
    marketLanguage,
    dialogueLanguage,
    referenceAspectRatio,
    referenceFrameSource,
    previewsStatus,
    brandManifest,
    searchDefaults,
    sessionId,
    uploadVideo,
    submitYoutubeUrl,
    pickLibraryEntry,
    onTemplate,
    sceneTemplateChanged,
    updateAnalysis,
    proceedToProduct,
    goToStep,
    selectableSteps,
    setBrandManifest,
    changeVoiceMode,
    startRevision,
    submitProductInfo,
    generatePrompt,
    updatePrompt,
    approvePrompt,
    selectProductImage,
    uploadProductImage,
    generateVideo: startGenerateVideo,
    clearError,
    showError,
  } = useWorkflow();

  // Уход с шага разбора размонтирует карточку бренда — несохранённый
  // выбор голоса/режима раньше пропадал молча. Сохраняем его ДО смены
  // шага; не вышло — остаёмся, причина видна в самой карточке.
  const brandEditorRef = useRef<BrandSnapshotEditorHandle>(null);
  const flushBrandEdits = async (): Promise<boolean> =>
    (await brandEditorRef.current?.flush()) ?? true;
  const leaveAnalysisStep = async (): Promise<void> => {
    if (await flushBrandEdits()) proceedToProduct();
  };
  const saveAnalysisEdit = async (text: string): Promise<void> => {
    if (await flushBrandEdits()) await updateAnalysis(text);
  };
  /**
   * Клик по степперу. Компонент сообщает НОМЕР позиции, а хук ждёт
   * идентификатор: у сессии на приёме позиций четыре, и номер там
   * означает уже другой шаг (этап 151).
   */
  const selectStep = (index: number): void => {
    const id = stepperIdsFor(onTemplate)[index];
    if (!id) return;
    void flushBrandEdits().then((ok) => {
      if (ok) goToStep(id);
    });
  };

  // Доп. запрос владельца продукта (ТЗ §11.1/§20 — админская половина
  // решения о провайдере по умолчанию, найденная недостающей при
  // аудите): при открытии экрана читаем настройку оператора, а не
  // держим Grok зашитым в коде фронтенда — `useState('grok')` выше
  // остаётся как фолбэк на время, пока этот запрос не ответил (или не
  // смог), не как единственный источник дефолта.
  // «Упёрся в стену» (§12.2 ТЗ «Условно бесплатный Lite») — четвёртое из
  // четырёх событий кабинета и единственное, которое случается ВНЕ его:
  // отказ рисуется здесь, у самой кнопки. Зависимость одна, поэтому
  // событие уходит на переходе false → true, а не на каждый рендер
  // экрана с отказом.
  useEffect(() => {
    if (generationLocked) recordInviteEvent('wall');
  }, [generationLocked]);

  useEffect(() => {
    let cancelled = false;
    getDefaultVideoProvider()
      .then(({ provider }) => {
        if (!cancelled) setVideoProvider(provider);
      })
      .catch(() => {
        // Молча остаёмся на фолбэке из useState — экран не должен
        // блокироваться или ломаться из-за одного диагностического
        // запроса.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Доп. запрос владельца продукта: расчёт цены сразу при выборе, до
  // кнопки «Сгенерировать» (ТЗ §11.3) — общий принцип, не только для
  // Grok: любой выбор, меняющий стоимость, сразу показывает
  // пересчитанную цену.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    getCostEstimate(
      sessionId,
      videoProvider,
      videoProvider === 'veo' ? videoQuality : undefined,
      videoProvider === 'grok' ? grokResolution : undefined,
      targetDuration > 8 ? targetDuration : undefined
    )
      .then((est) => {
        if (!cancelled) setCostEstimate(est);
      })
      .catch(() => {
        if (!cancelled) setCostEstimate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, videoProvider, videoQuality, grokResolution, targetDuration]);

  /**
   * Spec §19: активный фильтр — персонаж, сцена или массовка. Живёт здесь,
   * потому что чипы в двух карточках, а подсвечивается один текст разбора.
   */
  const [focus, setFocus] = useState<HighlightFocus | null>(null);
  /** Spec §20: согласие с офертой спрашивается ровно перед первым разбором. */
  const [termsAccepted, setTermsAccepted] = useState(false);

  /**
   * ТЗ §23: что из мастера доступно в текущем режиме. Замки нарисованы на
   * месте самих панелей — так видно, чего именно лишает Lite, а не «здесь
   * когда-то что-то было».
   */
  const relevance = useFeature('relevance');
  const audit = useFeature('audit');
  // Тот же гейт, что у BrandSnapshotEditor: дубляж — премиальный
  // уровень озвучки, сервер это тоже проверяет (updateSnapshot).
  const dub = useFeature('voiceDub');
  const referenceAssets = useFeature('referenceAssets');
  // Ж-1: замок полной модели Veo существовал только на сервере. Человек
  // выбирал «Кинематографичное», жал «Сгенерировать» — и получал 403
  // после всех предыдущих шагов. Обучалка на лендинге честно рисовала
  // тут бейдж «Standard+», то есть лендинг был точнее самого продукта.
  const fullQuality = useFeature('fullQualityVideo');
  // Матрица режимов приходит отдельным запросом, и до её ответа замка на
  // пилюле нет (мигнуть им у Premium хуже, чем показать секундой позже).
  // Значит, есть окно, в котором «Кинематографичное» можно успеть
  // выбрать — и упереться в 403 уже на «Сгенерировать». Возвращаем
  // выбор в доступное значение, когда ответ приходит.
  useEffect(() => {
    if (fullQuality.loading || fullQuality.allowed) return;
    setVideoQuality((q) => (q === 'standard' ? 'fast' : q));
  }, [fullQuality.loading, fullQuality.allowed]);

  const effectiveAspectRatio = aspectRatio ?? referenceAspectRatio ?? '9:16';

  // Доп. запрос владельца продукта (ТЗ §20.4 п.3 — исправлено при
  // аудите собственной реализации): изначально text-card планировались
  // на экране кастинга персонажей, ДО генерации промпта — но
  // `extractLiteralTexts()` извлекает моменты ИЗ уже готового текста
  // промпта (`prompt.service.ts`), которого на экране кастинга ещё не
  // существует (кастинг — шаг `analysis-complete`, промпт — шаг
  // `prompt-generation`, позже). Показывается ниже, рядом с
  // `PromptEditor`, где `prompt` уже реально существует. Объявлено
  // здесь, ПОСЛЕ `effectiveAspectRatio` — тот же класс сбоя (TS2448,
  // использование до объявления в той же области видимости), что уже
  // ловился в этом файле раньше.
  const [textCards, setTextCards] = useState<OnScreenTextMoment[] | null>(null);
  const [textCardsError, setTextCardsError] = useState<string | null>(null);
  const [textCardsRefreshing, setTextCardsRefreshing] = useState(false);

  const loadTextCards = () => {
    if (!sessionId) return;
    setTextCardsError(null);
    setTextCardsRefreshing(true);
    ensureTextCards(sessionId, effectiveAspectRatio)
      .then(setTextCards)
      .catch(() =>
        // Best-effort — тот же принцип, что и на бекенде
        // (`extractLiteralTexts`/рендер карточки): сбой здесь не
        // должен мешать работе с уже готовым и оплаченным промптом.
        setTextCardsError(dict.generationWizard.textCardLoadError)
      )
      .finally(() => setTextCardsRefreshing(false));
  };

  useEffect(() => {
    if (prompt?.promptId) loadTextCards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.promptId]);

  /**
   * Готовность и советник — «Тонкая красная линия», волна D, этап 13.
   *
   * Готовность считает СЕРВЕР той же функцией, которой проверяет
   * барьеры генерации: два независимых списка условий расходятся, и
   * человек начинает видеть «всё готово» там, где сервер откажет.
   */
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [guide, setGuide] = useState<WizardGuideState | null>(null);
  const track = useWizardEvents(projectId ?? '');
  const stepId = stepperIdOf(currentStep);
  // Мастер сообщает, где человек, — для кнопки «Сообщить о проблеме» в
  // подвале (этап 160). Подвал снаружи мастера и сам о сессии не
  // знает: у маршрута `#/generate` нет ни одного параметра.
  useReportHere(sessionId, stepId);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void getSessionReadiness(sessionId).then((r) => {
      if (!cancelled) setReadiness(r);
    });
    return () => {
      cancelled = true;
    };
    // Перечитываем на КАЖДОЙ смене шага: между ними меняется ровно то,
    // из чего готовность и собрана.
  }, [sessionId, currentStep]);

  useEffect(() => {
    if (!projectId) return;
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

  useEffect(() => {
    if (!stepId || !projectId) return;
    track('enter', stepId);
    return () => track('leave', stepId);
  }, [stepId, projectId, track]);

  const toggleGuide = async (next: boolean): Promise<void> => {
    if (!projectId) return;
    if (!next && !window.confirm(dict.wizardGuide.disableConfirm)) return;
    const updated = await setWizardGuide(projectId, next).catch(() => null);
    if (updated) setGuide(updated);
  };

  // Позиции и подписи — по тому, чем сессия идёт (этап 151). У сессии
  // на приёме позиции «Анализ» нет вовсе, а первая называется «Сцена»:
  // «Видео» там, где видео нет, и серый «Анализ», которого не будет
  // никогда, — два обещания подряд, которых продукт не выполнит.
  const stepperIds = stepperIdsFor(onTemplate);
  const stepperTexts = stepperLabels(
    onTemplate,
    dict.generationWizard.steps,
    dict.generationWizard.stepSource
  );
  // Кликабельность по-прежнему решает `stepTargets` внутри хука — она
  // считается по ПОЛНОМУ списку, поэтому берём её по идентификатору, а
  // не по позиции: у укороченного списка индексы уже другие.
  const selectableById = new Map(
    STEPPER_IDS.map((id, i) => [id, selectableSteps[i]])
  );
  const stepsView = toStepsView(
    stepperIds.map((id, i) => ({
      id,
      label: stepperTexts[i],
      target: selectableById.get(id) ? id : null,
    })),
    stepperIdOf(currentStep)
  );

  /**
   * Куда сейчас можно — один список на строку готовности и на кнопки
   * советника. Кнопка на недостижимый шаг хуже её отсутствия: человек
   * жмёт, ничего не происходит, и виноват в этом продукт (§5.7).
   */
  const reachable = new Map<string, string>();
  stepsView.targets.forEach((target, i) => {
    if (target && i !== stepsView.current)
      reachable.set(target, stepsView.steps[i]);
  });
  const goToReadinessStep = (id: string): void => {
    const index = stepsView.targets.findIndex((x) => x === id);
    if (index >= 0) selectStep(index);
  };

  return (
    <div className="space-y-4">
      {error && (
        <Alert
          tone="error"
          title={dict.generationWizard.errorTitle}
          onDismiss={clearError}
        >
          {error}
        </Alert>
      )}

      {/* Этап 52 (В-1.5): пройденные шаги — кнопки возврата. */}
      <ProgressIndicator
        currentStep={stepsView.current}
        steps={stepsView.steps}
        onSelect={selectStep}
        selectable={stepsView.selectable}
      />

      {/* Строка «до готового ролика» и совет на шаге — волна D, этап 13.
          Оба живут под степпером и на любом шаге: человек должен видеть
          остаток пути всё время, а не узнавать о нём, нажав кнопку. */}
      {readiness && (
        <ReadinessPanel
          readiness={readiness}
          canGoToStep={(id) => reachable.has(id)}
          onGoToStep={goToReadinessStep}
          // Пункт `analysis` — это «откуда берётся сцена», и приём
          // закрывает его наравне с разбором. Но подпись у него про
          // разбор, и с галочкой она рапортовала о работе, которой не
          // было (аудит этапа 151, А-2).
          itemLabels={
            onTemplate
              ? { analysis: dict.wizardReadiness.items.sceneTemplate }
              : undefined
          }
        />
      )}

      {projectId && stepId && (
        <HintLine
          projectId={projectId}
          stepId={stepId}
          enabled={!!guide?.available && !!guide?.enabled}
          stepLabels={Object.fromEntries(reachable)}
          onGoToStep={goToReadinessStep}
          onEvent={(kind, detail) => track(kind, stepId, detail)}
        />
      )}

      {/* Чекбокс — только на первом шаге: включить советы можно ТОЛЬКО
          в начале сценария (§3.2). У товарки сессия создаётся кнопкой,
          которая открывает мастер, поэтому «начало» здесь — пока не
          начат разбор референса. */}
      {projectId && guide?.available && guide.canEnable && (
        <label className="flex items-start gap-2 rounded-lg border border-[var(--border)] p-3">
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
      )}

      {/* Выключить советы можно в ЛЮБОЙ момент (§3.2) — асимметрия
          правила: включение только в начале, выключение когда угодно.
          Без этой кнопки человек, включивший советы на первом шаге,
          остался бы с ними до конца прогона. */}
      {projectId && guide?.available && guide.enabled && !guide.canEnable && (
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

      {/* Step 1: Upload Video — за согласием с офертой (§20) */}
      {currentStep === 'upload' && !isUploading && !termsAccepted && (
        <TermsGate onAccepted={() => setTermsAccepted(true)} />
      )}
      {(currentStep === 'upload' || isUploading) && termsAccepted && (
        <VideoUpload
          // Session seeding (project-bound sessions) lands after the first
          // render — remount once so the search tab opens pre-filled.
          key={searchDefaults ? 'seeded' : 'plain'}
          onUploadStart={uploadVideo}
          onSubmitYoutubeUrl={submitYoutubeUrl}
          // §7 (этап 39, А-2.12): «формат не поддерживается» и «файл
          // больше 100 МБ» уходили в консоль, и экран выглядел
          // зависшим — пользователь жал ещё раз с тем же файлом.
          onUploadError={showError}
          isUploading={isUploading}
          isInitializing={isInitializing}
          searchDefaults={searchDefaults}
          sessionId={sessionId}
          onPickLibraryEntry={pickLibraryEntry}
          onSceneTemplateChanged={sceneTemplateChanged}
          sceneTemplateChosen={onTemplate}
          hasProduct={!!productName || !!productDescription}
        />
      )}

      {/* Step 2: Analysis — characters (spec §10) + manifest copy (§12)
          above the scene breakdown, which keeps its edit/continue controls. */}
      {(currentStep === 'analyzing' || currentStep === 'analysis-complete') && (
        <div className="space-y-4">
          {currentStep === 'analysis-complete' &&
            sessionId &&
            analysis?.characters !== undefined && (
              <CharacterCasting
                key={analysis.analysisId}
                sessionId={sessionId}
                characters={analysis.characters}
                brandManifest={brandManifest}
                productName={productName}
                productDescription={productDescription}
                previewsStatus={previewsStatus}
                onHighlight={setFocus}
              />
            )}
          {currentStep === 'analysis-complete' && sessionId && analysis && (
            <SceneCasting
              sessionId={sessionId}
              analysis={analysis}
              focus={focus}
              onFocus={setFocus}
              previewsStatus={previewsStatus}
            />
          )}
          {currentStep === 'analysis-complete' && analysis && (
            <AnalysisInsights
              analysis={analysis}
              previewsStatus={previewsStatus}
            />
          )}
          {currentStep === 'analysis-complete' &&
            sessionId &&
            brandManifest && (
              <BrandSnapshotEditor
                ref={brandEditorRef}
                sessionId={sessionId}
                snapshot={brandManifest}
                onSaved={setBrandManifest}
              />
            )}
          <AnalysisDisplay
            analysisText={analysis?.sceneBreakdown || ''}
            isAnalyzing={isAnalyzing}
            onEdit={saveAnalysisEdit}
            onSave={() => void leaveAnalysisStep()}
            fromLibrary={!!analysis?.fromLibrary}
            highlight={
              focus
                ? {
                    label: focus.label,
                    terms: focus.terms,
                    exact: focus.exact,
                    onClear: () => setFocus(null),
                  }
                : null
            }
          />
        </div>
      )}

      {/* Step 3: Product Input */}
      {currentStep === 'product-input' && (
        <div className="space-y-3">
          {prefilledFromProject && (
            <Alert tone="info">
              {dict.generationWizard.prefilledAlert}
              {projectId && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="underline hover:text-accent"
                    onClick={() => navigate(routes.project(projectId))}
                  >
                    {dict.generationWizard.openProjectCta}
                  </button>
                </>
              )}
            </Alert>
          )}
          <ProductInput
            onSubmit={(name, description, language) =>
              submitProductInfo(name, description, language)
            }
            isSubmitting={isSubmittingProduct}
            initialName={productName}
            initialDescription={productDescription}
            initialDialogueLanguage={dialogueLanguage}
            marketLanguage={marketLanguage}
          />
          {brandManifest && (
            <Card className="p-4">
              <div className="flex items-start gap-2">
                <Palette size={14} className="mt-0.5 shrink-0 text-accent" />
                <span className="text-sm font-semibold">
                  {dict.generationWizard.brandManifestTitle.replace(
                    '{{title}}',
                    brandManifest.title
                  )}
                </span>
              </div>
              <p className="mt-1 text-xs text-silver-400">
                {brandManifest.characters.length > 0
                  ? dict.generationWizard.brandManifestCharCount.replace(
                      '{{count}}',
                      String(brandManifest.characters.length)
                    )
                  : ''}
                {dict.generationWizard.brandManifestHint}
              </p>
            </Card>
          )}
        </div>
      )}

      {/* Step 4: Prompt Generation */}
      {currentStep === 'prompt-generation' && (
        <div className="space-y-4">
          {/* Spec §18.3: is this reference right for this product? Before
              the prompt is written, so its advice can feed the brief. */}
          {/* У сессии на приёме сцены референса НЕТ — а проверка
              релевантности сравнивает аудиторию товара с аудиторией
              референса и требует завершённого разбора: сервер отвечает
              400, и каждый ролик по приёму начинался с красной ошибки
              (аудит этапа 150, А-1). Замок на LITE там же был предложением
              заплатить за проверку, которая к этой сессии неприменима. */}
          {sessionId &&
            !prompt &&
            !onTemplate &&
            !relevance.allowed &&
            !relevance.loading && (
              <LockedNote
                title={dict.generationWizard.relevanceLockedTitle}
                lock={relevance.lock}
              >
                {dict.generationWizard.relevanceLockedBody}
              </LockedNote>
            )}
          {sessionId && !prompt && !onTemplate && relevance.allowed && (
            <RelevancePanel
              sessionId={sessionId}
              onChooseAnother={() => {
                if (projectId) {
                  navigate(routes.project(projectId));
                } else {
                  localStorage.removeItem('sessionId');
                  window.location.reload();
                }
              }}
            />
          )}
          {!prompt && !isGeneratingPrompt && (
            <Card className="p-5 animate-fadeIn">
              <CardHeader
                icon={<Sparkles size={18} className="text-accent" />}
                title={dict.generationWizard.promptReadyTitle}
                hint={dict.generationWizard.promptReadyHint}
              />
              <Button
                block
                size="lg"
                icon={<Sparkles size={16} />}
                onClick={generatePrompt}
              >
                {dict.generationWizard.generatePromptCta}
              </Button>
            </Card>
          )}

          {isGeneratingPrompt && (
            <Card className="p-5">
              <Busy
                title={dict.generationWizard.promptBusyTitle}
                hint={dict.generationWizard.promptBusyHint}
              />
            </Card>
          )}

          {prompt && (
            <PromptEditor
              prompt={prompt}
              onUpdate={updatePrompt}
              onApprove={approvePrompt}
              isUpdating={isUpdatingPrompt}
              isApproving={isApprovingPrompt}
              ownVoice={
                brandManifest?.voiceMode === 'voiceover' ||
                brandManifest?.voiceMode === 'dub'
              }
            />
          )}

          {/* Доп. запрос владельца продукта (ТЗ §20) — text-card:
              референс-картинка с готовым текстом вместо надежды на то,
              что модель нарисует текст сама. */}
          {(textCards?.length ?? 0) > 0 && (
            <Card className="p-5">
              <CardHeader
                icon={<TypeIcon size={18} className="text-accent" />}
                title={dict.generationWizard.textCardsTitle}
                hint={dict.generationWizard.textCardsHint}
              />
              {textCardsError && (
                <Alert tone="error" className="mb-3">
                  {textCardsError}
                </Alert>
              )}
              <div className="flex flex-wrap gap-3">
                {textCards!.map((moment) => (
                  <div key={moment.role} className="w-24">
                    <div className="overflow-hidden rounded-lg border border-silver-200 dark:border-silver-800">
                      {moment.cardUrl ? (
                        <img
                          src={moment.cardUrl}
                          alt={moment.text}
                          className="aspect-[9/16] w-full object-cover"
                        />
                      ) : (
                        <div className="flex aspect-[9/16] w-full items-center justify-center bg-silver-100 dark:bg-silver-900">
                          <Sparkles
                            size={16}
                            className="animate-pulse text-silver-400"
                          />
                        </div>
                      )}
                    </div>
                    <p className="mt-1 text-center text-[10px] text-silver-500">
                      {moment.role}
                    </p>
                  </div>
                ))}
              </div>
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                loading={textCardsRefreshing}
                onClick={loadTextCards}
              >
                {dict.generationWizard.textCardsRefresh}
              </Button>
            </Card>
          )}
        </div>
      )}

      {/* Step 5: Video Generation */}
      {currentStep === 'video-generation' && (
        <div className="space-y-4">
          <Card className="p-5 animate-fadeIn">
            <CardHeader
              icon={<ImagePlus size={18} className="text-accent" />}
              title={dict.generationWizard.productPhotoTitle}
              hint={dict.generationWizard.productPhotoHint}
            />
            <ImageUpload
              onImageSelect={selectProductImage}
              onUpload={uploadProductImage}
              uploadProgress={imageUploadProgress}
              previewUrl={productImagePreview}
              // Слот S2 для «ИИ-скетча» (doc/AI-SKETCH-SPEC.md §7.2):
              // сам компонент сессии не знает, а скетч привязан к ней.
              // Состояние слота — из сессии, чтобы после перезагрузки на
              // экране был тот же вариант, что уйдёт в ролик (аудит A-8).
              sessionId={sessionId}
              originalUrl={productOriginalPhotoUrl ?? productImagePreview}
              sketchUrl={productSketchUrl}
              sketchVariant={productSketchUrl ? 'sketch' : 'original'}
              error={
                error?.includes('image') || error?.includes('Image')
                  ? error
                  : undefined
              }
              disabled={isUploadingImage}
            />
          </Card>

          {/* Карточка запуска показывается и после ПРОВАЛА рендера (этап
              48, В-1.3): этап 42 оставлял упавший рендер на этом шаге, но
              условие `!generatedVideo` прятало единственную кнопку —
              пользователь видел красную плашку и ничего, чем повторить.
              Пока идёт запуск (`isGeneratingVideo` без `generatedVideo`,
              В-5.5), карточка сменяется на «Генерируем» ниже, а не на
              пустое место. */}
          {imageUploadProgress === 100 &&
            !isGeneratingVideo &&
            generatedVideo?.status !== 'complete' &&
            generatedVideo?.status !== 'processing' &&
            generatedVideo?.status !== 'pending' &&
            // М-7.2: во время пересборки промпта (смена режима озвучки)
            // карточка запуска скрыта — иначе можно стартовать платный
            // рендер по старому промпту параллельно с пересборкой.
            !isGeneratingPrompt && (
              <Card className="p-5 animate-fadeIn">
                <CardHeader
                  icon={<Clapperboard size={18} className="text-accent" />}
                  title={
                    generatedVideo?.status === 'failed'
                      ? dict.generationWizard.renderFailedTitle
                      : dict.generationWizard.videoReadyTitle
                  }
                  hint={
                    generatedVideo?.status === 'failed'
                      ? dict.generationWizard.renderFailedHint
                      : dict.generationWizard.videoReadyHint
                  }
                />
                {/* Доп. запрос владельца продукта (14.09.2026): режим
                    озвучки — на каждой сессии, прямо здесь, а не только
                    в редакторе снимка на шаге разбора. Модели читают
                    кириллицу с неверными ударениями, и возвращаться за
                    этим на три шага назад — верный способ забыть.
                    Смена режима пересобирает промпт и возвращает на
                    его одобрение (см. changeVoiceMode в useWorkflow). */}
                {brandManifest && (
                  <div className="mb-4">
                    <span className="label">
                      {dict.generationWizard.voiceModeLabel}
                    </span>
                    <Pills
                      value={brandManifest.voiceMode ?? 'voiceover'}
                      onChange={(mode: VoiceMode) => void changeVoiceMode(mode)}
                      disabled={isGeneratingPrompt}
                      columns={3}
                      options={[
                        {
                          value: 'veo' as VoiceMode,
                          label: dict.brandSnapshotEditor.voiceModeOptions.veo,
                        },
                        {
                          value: 'voiceover' as VoiceMode,
                          label:
                            dict.brandSnapshotEditor.voiceModeOptions.voiceover,
                        },
                        {
                          value: 'dub' as VoiceMode,
                          label: dub.allowed ? (
                            dict.brandSnapshotEditor.voiceModeOptions.dub
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <Lock size={9} />{' '}
                              {dict.brandSnapshotEditor.voiceModeOptions.dub}
                            </span>
                          ),
                          // Тот же принцип, что у качества (Ж-1, этап
                          // 123): пока матрица режимов не пришла, замок
                          // не рисуем — мигнуть им у Premium хуже.
                          disabled: !dub.loading && !dub.allowed,
                        },
                      ]}
                    />
                    <p className="hint mt-1">
                      {isGeneratingPrompt
                        ? dict.generationWizard.promptBusyTitle
                        : `${voiceModeHint(
                            brandManifest.voiceMode ?? 'voiceover',
                            dict.voiceMode.hints
                          )} ${dict.generationWizard.voiceModeSwitchNote}`}
                    </p>
                  </div>
                )}
                <div className="mb-4">
                  <span className="label">
                    {dict.generationWizard.providerLabel}
                  </span>
                  <Pills
                    value={videoProvider}
                    onChange={setVideoProvider}
                    options={[
                      {
                        value: 'grok',
                        label: dict.generationWizard.providerGrokLabel,
                      },
                      {
                        value: 'veo',
                        label: dict.generationWizard.providerVeoLabel,
                      },
                    ]}
                  />
                </div>
                <div className="mb-4">
                  {/* Названия намеренно НЕ «Lite» и «Standard»: так теперь
                      зовутся режимы сервиса (ТЗ §23), и два разных выбора
                      с одинаковыми словами на одном экране — верный способ
                      заставить человека решить, что он покупает качество
                      рендера. Здесь выбирается модель, а не режим. */}
                  {videoProvider === 'veo' ? (
                    <>
                      <span className="label">
                        {dict.generationWizard.qualityLabel}
                      </span>
                      <Pills
                        value={videoQuality}
                        onChange={setVideoQuality}
                        options={[
                          {
                            value: 'fast',
                            label: dict.generationWizard.qualityFastLabel,
                            sub: dict.generationWizard.qualityFastSub,
                          },
                          {
                            value: 'standard',
                            label: dict.generationWizard.qualityStandardLabel,
                            // Пока матрица режимов не пришла, замок не
                            // рисуем вовсе: мигнуть замком у Premium
                            // хуже, чем показать его на секунду позже
                            // (тот же принцип, что у `useFeature`).
                            sub:
                              fullQuality.loading || fullQuality.allowed
                                ? dict.generationWizard.qualityStandardSub
                                : fullQuality.lock,
                            disabled:
                              !fullQuality.loading && !fullQuality.allowed,
                          },
                        ]}
                      />
                      {!fullQuality.loading && !fullQuality.allowed && (
                        <div className="mt-2">
                          <LockedNote
                            title={dict.generationWizard.qualityLockedTitle}
                            lock={fullQuality.lock}
                            compact
                          >
                            {dict.generationWizard.qualityLockedBody}
                          </LockedNote>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="label">
                        {dict.generationWizard.resolutionLabel}
                      </span>
                      <Pills
                        value={grokResolution}
                        onChange={setGrokResolution}
                        options={[
                          { value: '480p', label: '480p' },
                          { value: '720p', label: '720p' },
                          { value: '1080p', label: '1080p' },
                        ]}
                      />
                    </>
                  )}
                  {costEstimate && !costEstimate.unpriced && (
                    <p className="hint">
                      {dict.generationWizard.estimatedCostLabel.replace(
                        '{{cost}}',
                        costEstimate.costUsd.toFixed(2)
                      )}
                      {costEstimate.segments > 1 &&
                        ` (${costEstimate.segments} ${dict.generationWizard.chainSegmentsLabel})`}
                      {costEstimate.wasCapped &&
                        ` — ${dict.generationWizard.durationCappedLabel.replace(
                          '{{seconds}}',
                          String(costEstimate.targetDurationSeconds)
                        )}`}
                    </p>
                  )}
                </div>
                <div className="mb-4">
                  {/* Доп. запрос владельца продукта: ролик длиннее 8 секунд
                      через Scene Extension (ТЗ §9, этап 4 плана §14). Explicit
                      seconds — §9.4 "Длительность в секундах — явно". */}
                  <span className="label">
                    {dict.generationWizard.durationLabel}
                  </span>
                  <input
                    type="number"
                    min={8}
                    max={60}
                    step={1}
                    value={targetDuration}
                    onChange={(e) =>
                      setTargetDuration(
                        Math.max(8, Math.min(60, Number(e.target.value) || 8))
                      )
                    }
                    className="duration-input"
                  />
                  <span className="hint">
                    {dict.generationWizard.durationHint}
                  </span>
                </div>
                <div className="mb-4">
                  {/* Доп. запрос владельца продукта: поле «Чего избежать»
                      (ТЗ §1/§6, этап 5 плана §14) — необязательное,
                      свободный текст. */}
                  <span className="label">
                    {dict.generationWizard.avoidTextLabel}
                  </span>
                  <input
                    type="text"
                    maxLength={500}
                    value={avoidText}
                    onChange={(e) => setAvoidText(e.target.value)}
                    placeholder={dict.generationWizard.avoidTextPlaceholder}
                    className="avoid-text-input"
                  />
                </div>
                {sessionId && referenceAssets.allowed && (
                  <div className="mb-4">
                    <ReferenceSlotsPanel sessionId={sessionId} />
                  </div>
                )}
                {sessionId &&
                  !referenceAssets.allowed &&
                  !referenceAssets.loading && (
                    <div className="mb-4">
                      <LockedNote
                        title={dict.generationWizard.referenceLockedTitle}
                        lock={referenceAssets.lock}
                        compact
                      >
                        {dict.generationWizard.referenceLockedBody}
                      </LockedNote>
                    </div>
                  )}
                <div className="mb-4">
                  <AspectRatioPicker
                    value={effectiveAspectRatio}
                    onChange={setAspectRatio}
                    referenceAspectRatio={referenceAspectRatio}
                    referenceSource={referenceFrameSource}
                  />
                </div>
                <Button
                  block
                  size="lg"
                  icon={<Video size={16} />}
                  onClick={() =>
                    startGenerateVideo(
                      videoQuality,
                      effectiveAspectRatio,
                      videoProvider,
                      videoProvider === 'grok' ? grokResolution : undefined,
                      targetDuration > 8 ? targetDuration : undefined,
                      avoidText.trim() || undefined
                    )
                  }
                >
                  {generatedVideo?.status === 'failed'
                    ? dict.generationWizard.retryGenerateCta
                    : dict.generationWizard.generateVideoCta}
                </Button>
                {/* Стена бесплатного (этап 132). Рисуется здесь, у самой
                    кнопки, а не отдельным экраном: человек уже пришёл
                    сюда генерировать, и увести его на другой адрес,
                    чтобы объяснить отказ, значило бы потерять контекст
                    вместе с ним. Красную строку ошибки при этом не
                    показываем — отказ не про поломку. */}
                {generationLocked && (
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
              </Card>
            )}

          {isGeneratingPrompt && (
            <Card className="p-5">
              <Busy
                title={dict.generationWizard.promptBusyTitle}
                hint={dict.generationWizard.promptBusyHint}
              />
            </Card>
          )}

          {isGeneratingVideo && (
            <Card className="p-5">
              <CardHeader
                icon={<Video size={18} className="text-accent" />}
                title={dict.generationWizard.generatingTitle}
              />
              <Busy
                title={
                  // Найдено при аудите озвучки/пайплайна (по прямому
                  // запросу): раньше это было безусловно
                  // «Veo рендерит…»/«Отправляем задачу в Veo…»,
                  // независимо от того, какой провайдер реально выбран
                  // (§10–11 ТЗ) — при Grok заголовок называл чужого
                  // провайдера на каждой генерации, не в редком крае.
                  (generatedVideo?.provider ?? videoProvider) === 'grok'
                    ? generatedVideo
                      ? dict.generationWizard.renderingBusyTitleGrok
                      : dict.generationWizard.submittingBusyTitleGrok
                    : generatedVideo
                      ? dict.generationWizard.renderingBusyTitle
                      : dict.generationWizard.submittingBusyTitle
                }
                hint={
                  // Доп. запрос владельца продукта: ролики длиннее 8
                  // секунд (§9 ТЗ, этап 4 плана §14) — найдено при
                  // аудите (§16): без этого пользователь видел бы
                  // просто «processing» на весь ланцюжок сегментов
                  // (потенциально 20+ минут), без единого признака
                  // прогресса.
                  generatedVideo?.chainSegmentsTotal &&
                  generatedVideo.chainSegmentsTotal > 1
                    ? dict.generationWizard.chainProgressHint
                        .replace(
                          '{{done}}',
                          String(generatedVideo.chainSegmentsDone ?? 1)
                        )
                        .replace(
                          '{{total}}',
                          String(generatedVideo.chainSegmentsTotal)
                        )
                    : generatedVideo
                      ? dict.generationWizard.statusHint.replace(
                          '{{status}}',
                          generatedVideo.status
                        )
                      : dict.generationWizard.preparingHint
                }
              />
              <FeaturePanel>
                <p className="text-xs text-silver-500 dark:text-silver-300">
                  {generatedVideo?.xaiBatchId
                    ? dict.generationWizard.generatingBatchNote
                    : dict.generationWizard.generatingNote}
                </p>
              </FeaturePanel>
            </Card>
          )}
        </div>
      )}

      {/* Step 6: Complete */}
      {currentStep === 'complete' && generatedVideo?.downloadUrl && (
        <div className="space-y-4 animate-fadeIn">
          <Card className="p-5">
            <CardHeader
              icon={<Sparkles size={18} className="text-emerald-500" />}
              title={dict.generationWizard.videoDoneTitle}
              hint={dict.generationWizard.videoDoneHint}
            />
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {originalVideoUrl && (
                <VideoPlayer
                  videoUrl={originalVideoUrl}
                  title={dict.generationWizard.originalLabel}
                />
              )}
              <VideoPlayer
                videoUrl={generatedVideo.downloadUrl}
                title={dict.generationWizard.generatedLabel}
                downloadUrl={generatedVideo.downloadUrl}
                // §15.5: исходник Veo остаётся доступным. Переключатель
                // рядом с плеером, а не ссылкой в новую вкладку: «до и
                // после» имеет смысл только когда их видно подряд.
                //
                // Доп. запрос владельца продукта: полная история версий —
                // тот же переключатель, просто с добавленными пунктами.
                // Раньше каждый повтор молча затирал файл предыдущей
                // попытки в Blob, посмотреть старую версию было нечем;
                // теперь путь на попытку уникален, и `videoHistory`
                // хранит их все (см. useWorkflow.ts, handleGenerateVideo).
                variants={[
                  ...(generatedVideo.postStatus === 'complete' &&
                  generatedVideo.renderedUrl
                    ? [
                        {
                          key: 'final',
                          label: dict.generationWizard.afterProcessingLabel,
                          url: generatedVideo.downloadUrl,
                        },
                        {
                          key: 'source',
                          // Найдено при доп. аудите: раньше это было
                          // безусловно «Оригинал Veo», как и busy-заголовок
                          // выше до своего фикса — при Grok подпись
                          // называла чужого провайдера на каждом готовом
                          // ролике, не в редком крае.
                          label:
                            generatedVideo.provider === 'grok'
                              ? dict.generationWizard.originalGrokLabel
                              : dict.generationWizard.originalVeoLabel,
                          url: generatedVideo.renderedUrl,
                        },
                      ]
                    : []),
                  ...videoHistory
                    .filter((v): v is typeof v & { downloadUrl: string } =>
                      Boolean(v.downloadUrl)
                    )
                    .map((v) => ({
                      key: v.generatedVideoId,
                      label: dict.generationWizard.previousAttemptLabel.replace(
                        '{{date}}',
                        new Date(v.initiatedAt).toLocaleString(locale)
                      ),
                      url: v.downloadUrl,
                    })),
                ]}
              />
            </div>
            {/* Вынесено в общий компонент (доп. аудит, этап 88, HIGH) —
                та же разметка теперь и у `PostprodVideoScreen`, см. её
                доккомментарий. */}
            <VideoProcessingStatus video={generatedVideo} dict={dict} />
            {generatedVideo.references &&
              generatedVideo.references.length > 0 && (
                <p className="mt-3 text-xs text-silver-400">
                  {dict.generationWizard.referencesLabel}{' '}
                  {generatedVideo.references
                    .map(
                      (r) =>
                        `#${r.index} ${r.label}${
                          r.kind === 'product'
                            ? ` (${dict.generationWizard.referenceKindProduct})`
                            : r.kind === 'scene'
                              ? ` (${dict.generationWizard.referenceKindScene})`
                              : ''
                        }`
                    )
                    .join(' · ')}
                  {dict.generationWizard.referencesRestNote}
                </p>
              )}
          </Card>

          {sessionId && audit.allowed && (
            <AuditPanel
              key={generatedVideo.generatedVideoId}
              sessionId={sessionId}
              generatedVideoId={generatedVideo.generatedVideoId}
              onFixApplied={(prompt) => startRevision(prompt)}
              processing={generatedVideo.postStatus === 'pending'}
            />
          )}
          {sessionId && audit.allowed && (
            // Этап 73: тот же тарифный гейт, что у AuditPanel выше — сервис
            // `VideoAuditService.runSoundCheck` проверяет ту же фичу 'audit'.
            <SoundCheckPanel
              key={`sound-${generatedVideo.generatedVideoId}`}
              sessionId={sessionId}
              processing={generatedVideo.postStatus === 'pending'}
            />
          )}
          {sessionId && !audit.allowed && !audit.loading && (
            <LockedNote
              title={dict.generationWizard.auditLockedTitle}
              lock={audit.lock}
            >
              {dict.generationWizard.auditLockedBody}
            </LockedNote>
          )}

          {/* Этап 88 (доп. запрос владельца продукта): переозвучка,
              экспорт, публикация и шаринг переехали во вкладку
              «Постпрод» (#/postprod/:sessionId) — единый список ВСЕХ
              готовых роликов пользователя, а не только текущей сессии
              мастера. Здесь — просто переход туда, с уже открытым этим
              роликом. */}
          {sessionId && (
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

          {/* Этап 65 (ТЗ §44): «Сделать так же для всей линейки» — только
              когда сессия создана из товара каталога (projectId есть).
              Панель сама решает, показываться ли (LINE, больше одного
              товара, Premium) — здесь достаточно не рендерить её вовсе
              для анонимной/быстрой генерации. */}
          {sessionId && projectId && (
            <CatalogBatchPanel
              key={`catalog-batch-${generatedVideo.generatedVideoId}`}
              sessionId={sessionId}
              projectId={projectId}
            />
          )}

          {/* Этап 66 (TODO §III.6): «Создать 3 A/B-варианта» — тот же
              признак доступа, что у пакетной генерации по каталогу, но
              своя панель (нет ограничения на LINE/число товаров — работает
              и для одиночного товара, механика не про перенос на другие
              позиции, а про хук/CTA одного и того же товара). */}
          {sessionId && projectId && (
            <AbTestPanel
              key={`ab-test-${generatedVideo.generatedVideoId}`}
              sessionId={sessionId}
              projectId={projectId}
            />
          )}

          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold">
              {dict.generationWizard.whatsNextTitle}
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="outline"
                icon={<Download size={14} />}
                onClick={() =>
                  window.open(generatedVideo.downloadUrl, '_blank')
                }
              >
                {dict.generationWizard.downloadCta}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  // Этап 48 (В-1.4): с этапа 39 перезагрузка возвращает
                  // шаг ПО СЕССИИ — без сброса идентификатора «ещё один
                  // ролик» показывал тот же готовый ролик.
                  localStorage.removeItem('sessionId');
                  window.location.reload();
                }}
              >
                {dict.generationWizard.anotherVideoCta}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
