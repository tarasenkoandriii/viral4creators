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

import { useState } from 'react';
import {
  Clapperboard,
  Download,
  ImagePlus,
  Palette,
  Sparkles,
  Video,
} from 'lucide-react';
import { useWorkflow } from '../../hooks/useWorkflow';
import { VideoUpload } from '../../components/VideoUpload';
import { AnalysisDisplay } from '../../components/AnalysisDisplay';
import { ProgressIndicator } from '../../components/ProgressIndicator';
import { ProductInput } from '../../components/ProductInput';
import { PromptEditor } from '../../components/PromptEditor';
import { ImageUpload } from '../../components/ImageUpload';
import { VideoPlayer } from '../../components/VideoPlayer';
import { CharacterCasting } from './CharacterCasting';
import { AnalysisInsights } from './AnalysisInsights';
import { RelevancePanel } from './RelevancePanel';
import { SceneCasting, type HighlightFocus } from './SceneCasting';
import { TermsGate } from '../../components/TermsGate';
import { BrandSnapshotEditor } from './BrandSnapshotEditor';
import { AuditPanel } from './AuditPanel';
import { SoundCheckPanel } from './SoundCheckPanel';
import { PublishPanel } from './PublishPanel';
import { ShareVideoPanel } from './ShareVideoPanel';
import { CatalogBatchPanel } from './CatalogBatchPanel';
import { AbTestPanel } from './AbTestPanel';
import { ExportPanel } from './ExportPanel';
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
import { navigate, routes } from '../../lib/router';
import { useFeature } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';

export function GenerationWizard() {
  const { dict, locale } = useI18n();
  const [videoQuality, setVideoQuality] = useState<VideoQuality>('fast');
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
    isUploadingImage,
    imageUploadProgress,
    generatedVideo,
    videoHistory,
    isGeneratingVideo,
    originalVideoUrl,
    error,
    prefilledFromProject,
    projectId,
    productName,
    productDescription,
    productCategory,
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
    updateAnalysis,
    proceedToProduct,
    goToStep,
    selectableSteps,
    setBrandManifest,
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
  const publication = useFeature('publication');
  const referenceAssets = useFeature('referenceAssets');

  const effectiveAspectRatio = aspectRatio ?? referenceAspectRatio ?? '9:16';

  const workflowSteps = dict.generationWizard.steps;

  const getStepIndex = () => {
    switch (currentStep) {
      case 'upload':
        return 0;
      case 'analyzing':
      case 'analysis-complete':
        return 1;
      case 'product-input':
        return 2;
      case 'prompt-generation':
        return 3;
      case 'video-generation':
        return 4;
      case 'complete':
        return 5;
      default:
        return 0;
    }
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
        currentStep={getStepIndex()}
        steps={workflowSteps}
        onSelect={goToStep}
        selectable={selectableSteps}
      />

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
                sessionId={sessionId}
                snapshot={brandManifest}
                onSaved={setBrandManifest}
              />
            )}
          <AnalysisDisplay
            analysisText={analysis?.sceneBreakdown || ''}
            isAnalyzing={isAnalyzing}
            onEdit={updateAnalysis}
            onSave={proceedToProduct}
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
          {sessionId && !prompt && !relevance.allowed && !relevance.loading && (
            <LockedNote
              title={dict.generationWizard.relevanceLockedTitle}
              lock={relevance.lock}
            >
              {dict.generationWizard.relevanceLockedBody}
            </LockedNote>
          )}
          {sessionId && !prompt && relevance.allowed && (
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
            generatedVideo?.status !== 'pending' && (
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
                <div className="mb-4">
                  {/* Названия намеренно НЕ «Lite» и «Standard»: так теперь
                      зовутся режимы сервиса (ТЗ §23), и два разных выбора
                      с одинаковыми словами на одном экране — верный способ
                      заставить человека решить, что он покупает качество
                      рендера. Здесь выбирается модель, а не режим. */}
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
                        sub: dict.generationWizard.qualityStandardSub,
                      },
                    ]}
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
                    startGenerateVideo(videoQuality, effectiveAspectRatio)
                  }
                >
                  {generatedVideo?.status === 'failed'
                    ? dict.generationWizard.retryGenerateCta
                    : dict.generationWizard.generateVideoCta}
                </Button>
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
                  generatedVideo
                    ? dict.generationWizard.renderingBusyTitle
                    : dict.generationWizard.submittingBusyTitle
                }
                hint={
                  generatedVideo
                    ? dict.generationWizard.statusHint.replace(
                        '{{status}}',
                        generatedVideo.status
                      )
                    : dict.generationWizard.preparingHint
                }
              />
              <FeaturePanel>
                <p className="text-xs text-silver-500 dark:text-silver-300">
                  {dict.generationWizard.generatingNote}
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
                          label: dict.generationWizard.originalVeoLabel,
                          url: generatedVideo.renderedUrl,
                        },
                      ]
                    : []),
                  ...videoHistory
                    .filter(
                      (v): v is typeof v & { downloadUrl: string } =>
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
            {generatedVideo.aspectRatio && (
              <p className="mt-3 text-xs text-silver-400">
                {dict.generationWizard.formatLabel.replace(
                  '{{ratio}}',
                  generatedVideo.aspectRatio
                )}
                {/* §15.4/§16.1: постобработка идёт после того, как ролик
                    уже отдан, поэтому здесь четыре разных честных
                    состояния, а не одно обещание «появится позже». */}
                {generatedVideo.postStatus === 'pending' &&
                  generatedVideo.reframePending && (
                    <>
                      {' '}
                      {dict.generationWizard.reframePendingNote
                        .replace(
                          '{{rendered}}',
                          generatedVideo.renderedAspectRatio ?? ''
                        )
                        .replace('{{target}}', generatedVideo.aspectRatio)}
                    </>
                  )}
                {generatedVideo.postStatus === 'complete' &&
                  generatedVideo.renderedAspectRatio !==
                    generatedVideo.aspectRatio && (
                    <>
                      {' '}
                      {dict.generationWizard.croppedFromNote.replace(
                        '{{rendered}}',
                        generatedVideo.renderedAspectRatio ?? ''
                      )}
                    </>
                  )}
                {generatedVideo.postStatus === 'failed' && (
                  <>
                    {' '}
                    {dict.generationWizard.postFailedNote
                      .replace(
                        '{{rendered}}',
                        generatedVideo.renderedAspectRatio ?? ''
                      )
                      .replace(
                        '{{errorSuffix}}',
                        generatedVideo.postError
                          ? ` (${generatedVideo.postError})`
                          : ''
                      )}
                  </>
                )}
                {generatedVideo.postStatus === 'skipped' &&
                  generatedVideo.reframePending &&
                  generatedVideo.renderedAspectRatio && (
                    <>
                      {' '}
                      {dict.generationWizard.reframeSkippedNote
                        .replace(
                          '{{rendered}}',
                          generatedVideo.renderedAspectRatio
                        )
                        .replace('{{target}}', generatedVideo.aspectRatio)}
                    </>
                  )}
              </p>
            )}
            {/* Б-2.7: отказ постобработки по дневному лимиту или
                блокировке приходит в `postError`, но не показывался
                НИГДЕ, если резать было нечего: при родном формате все
                ветки выше молчат, а `voiceStatus` в этом случае не
                выставляется вовсе — строка «Озвучка:» оставалась
                пустой. Человек видел ролик со звуком модели и ни слова
                о причине. */}
            {generatedVideo.postStatus === 'skipped' &&
              generatedVideo.postError &&
              !generatedVideo.reframePending && (
                <p className="mt-1 text-xs text-amber-500">
                  {dict.generationWizard.processingSkippedNote.replace(
                    '{{error}}',
                    generatedVideo.postError
                  )}
                </p>
              )}
            {/* §15: озвучка — отдельное состояние. «Не подключено» и
                «сломалось» показаны по-разному: первое не повод идти
                разбираться, второе — повод. */}
            {generatedVideo.voiceMode && generatedVideo.voiceMode !== 'veo' && (
              <p className="mt-1 text-xs text-silver-400">
                {dict.generationWizard.voiceLabel}{' '}
                {/* Постобработка могла не начаться вовсе (лимит,
                    блокировка) — тогда статуса озвучки нет, и молчать
                    здесь нельзя (Б-2.7). */}
                {!generatedVideo.voiceStatus &&
                  (generatedVideo.postStatus === 'skipped' ||
                    generatedVideo.postStatus === 'failed') &&
                  `${dict.generationWizard.voiceNotDone.replace(
                    '{{reason}}',
                    generatedVideo.postError ??
                      dict.generationWizard.noReasonDefault
                  )} ${dict.generationWizard.voiceModelSoundNote}`}
                {generatedVideo.voiceStatus === 'synthesized' &&
                  (generatedVideo.postStatus === 'pending'
                    ? dict.generationWizard.voiceRecordedApplying
                    : generatedVideo.postStatus === 'complete'
                      ? generatedVideo.voiceMode === 'dub'
                        ? dict.generationWizard.voiceOwnReplace
                        : dict.generationWizard.voiceOwnOverlay
                      : dict.generationWizard.voiceRecorded)}
                {/* Причина здесь уже готовая фраза («озвучка на этом
                    стенде не подключена», «текста озвучки нет») —
                    приписывать к ней свою значит повторяться. */}
                {generatedVideo.voiceStatus === 'skipped' &&
                  `${generatedVideo.voiceError ?? dict.generationWizard.voiceNotConnectedDefault}. ${dict.generationWizard.voiceModelSoundNote}`}
                {generatedVideo.voiceStatus === 'failed' &&
                  `${dict.generationWizard.voiceFailed.replace(
                    '{{reason}}',
                    generatedVideo.voiceError ??
                      dict.generationWizard.noReasonDefault
                  )} ${dict.generationWizard.voiceModelSoundNote}`}
              </p>
            )}
            {/* Этап 67: субтитры — третий ингредиент того же прохода
                ffmpeg, что кроп и голос, но третий, независимый статус
                (та же логика, что у голоса — провал сборки субтитров не
                отменяет ни кроп, ни звук). Абзац скрыт целиком, если
                бренд субтитры не заказывал (subtitlesMode !== 'on'). */}
            {generatedVideo.subtitlesMode === 'on' && (
              <p className="mt-1 text-xs text-silver-400">
                {dict.generationWizard.subtitlesLabel}{' '}
                {/* Постобработка могла не начаться вовсе (лимит,
                    блокировка) — тогда статуса субтитров нет, и молчать
                    здесь нельзя, по той же причине, что и у голоса. */}
                {!generatedVideo.subtitleStatus &&
                  (generatedVideo.postStatus === 'skipped' ||
                    generatedVideo.postStatus === 'failed') &&
                  dict.generationWizard.subtitlesSkipped.replace(
                    '{{reason}}',
                    generatedVideo.postError ??
                      dict.generationWizard.noReasonDefault
                  )}
                {generatedVideo.subtitleStatus === 'burned' &&
                  dict.generationWizard.subtitlesBurned}
                {generatedVideo.subtitleStatus === 'skipped' &&
                  dict.generationWizard.subtitlesSkipped.replace(
                    '{{reason}}',
                    generatedVideo.subtitleError ??
                      dict.generationWizard.noReasonDefault
                  )}
                {generatedVideo.subtitleStatus === 'failed' &&
                  dict.generationWizard.subtitlesFailed.replace(
                    '{{reason}}',
                    generatedVideo.subtitleError ??
                      dict.generationWizard.noReasonDefault
                  )}
              </p>
            )}
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
            />
          )}
          {sessionId && audit.allowed && (
            // Этап 73: тот же тарифный гейт, что у AuditPanel выше — сервис
            // `VideoAuditService.runSoundCheck` проверяет ту же фичу 'audit'.
            <SoundCheckPanel
              key={`sound-${generatedVideo.generatedVideoId}`}
              sessionId={sessionId}
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

          {sessionId && !publication.allowed && !publication.loading && (
            <LockedNote
              title={dict.generationWizard.publishLockedTitle}
              lock={publication.lock}
            >
              {dict.generationWizard.publishLockedBody}
            </LockedNote>
          )}
          {sessionId && publication.allowed && (
            <PublishPanel
              key={`pub-${generatedVideo.generatedVideoId}`}
              sessionId={sessionId}
              generatedVideoId={generatedVideo.generatedVideoId}
              productName={productName}
              productDescription={productDescription}
              category={productCategory}
            />
          )}
          {/* Этап 60 (ТЗ §40): та же тарифная граница, что и у публикации
              на YouTube/TikTok — «выпустить ролик наружу» от Standard,
              см. решение в plan-е этапа. Отдельный LockedNote не нужен —
              publication.lock уже показан панелью PublishPanel выше. */}
          {sessionId && publication.allowed && (
            <ShareVideoPanel
              key={`share-${generatedVideo.generatedVideoId}`}
              sessionId={sessionId}
              generatedVideoId={generatedVideo.generatedVideoId}
              productName={productName}
            />
          )}

          {/* Этап 75 (TODO §III, п.35): автоэкспорт под площадки — не
              привязан к проекту (в отличие от панелей ниже), доступен
              для любого готового ролика. */}
          {sessionId && (
            <ExportPanel
              key={`export-${generatedVideo.generatedVideoId}`}
              sessionId={sessionId}
              video={generatedVideo}
            />
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
