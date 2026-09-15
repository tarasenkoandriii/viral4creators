import { useState, useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import { isRenderInFlight, stepFromSession } from '../lib/session-step';
import { shouldKeepPolling } from '../lib/video-polling';

/** М-7.3: интервал опроса ролика, поданного через Batch API xAI. */
const BATCH_POLL_INTERVAL_MS = 60_000;
import {
  createSession,
  forkSharedVideo,
  uploadVideo,
  registerYoutubeVideo,
  triggerAnalysis,
  getAnalysisStatus,
  getSession,
  updateAnalysis,
  submitProductInfo,
  generatePrompt,
  updatePrompt,
  approvePrompt,
  uploadProductImage,
  generateVideo,
  getVideoStatus,
  VideoAnalysis,
  GenerationPrompt,
  GeneratedVideo,
  VideoQuality,
} from '../services/api';
import { reVoiceVideo } from '../services/postprod-api';
import type { BrandManifestSnapshot, Session, VoiceMode } from '../types';
import type { YoutubeSearchDefaults } from '../components/YoutubeSearch';
import { aspectRatioFromSize, readVideoSize } from '../lib/aspect-ratio';
import { captureFrames, previewRequests } from '../lib/frame-capture';
import {
  applyLibraryEntry,
  errorMessage,
  updateBrandSnapshot,
  uploadPreviewFrames,
} from '../services/projects-api';
import { readStoredLocale, defaultLocale } from '../lib/i18n';
import { useI18n } from '../lib/i18n-context';

type WorkflowStep =
  | 'upload'
  | 'analyzing'
  | 'analysis-complete'
  | 'product-input'
  | 'prompt-generation'
  | 'video-generation'
  | 'complete';

interface UseWorkflowState {
  currentStep: WorkflowStep;
  sessionId: string | null;
  isInitializing: boolean;
  isUploading: boolean;
  uploadProgress: number;
  isAnalyzing: boolean;
  analysis: VideoAnalysis | null;
  productName: string | null;
  productDescription: string | null;
  isSubmittingProduct: boolean;
  prompt: GenerationPrompt | null;
  isGeneratingPrompt: boolean;
  isUpdatingPrompt: boolean;
  isApprovingPrompt: boolean;
  productImage: File | null;
  productImagePreview: string | null;
  isUploadingImage: boolean;
  imageUploadProgress: number;
  generatedVideo: GeneratedVideo | null;
  /** Прошлые завершённые/проваленные попытки генерации (доп. запрос
   * владельца продукта: полная история версий) — самая свежая первая. */
  videoHistory: GeneratedVideo[];
  isGeneratingVideo: boolean;
  originalVideoUrl: string | null;
  error: string | null;
  /**
   * Set when the session was started from a project item (Stage 10 —
   * spec §7.8 snapshot): product info is already on the session, so the
   * product step shows it pre-filled instead of an empty form.
   */
  prefilledFromProject: boolean;
  projectId: string | null;
  /** Per-session copy of the Brand Manifest (spec §12), if the project had one. */
  brandManifest: BrandManifestSnapshot | null;
  /** YouTube search pre-fill from the item (spec §9.1); null on the anonymous path. */
  searchDefaults: YoutubeSearchDefaults | null;
  /** Auto-detected product category (spec §9.4) — becomes a publication tag (§8). */
  productCategory: string | null;
  /** Project market language (CLDR) from the snapshot — default for the voice-over (§13). */
  marketLanguage: string | null;
  /** Voice-over language the user confirmed on the product step (§13). */
  dialogueLanguage: string | null;
  /** Detected picture format of the reference (spec §16) — default for the ad. */
  referenceAspectRatio: string | null;
  referenceFrameSource: 'file' | 'gemini' | 'manual' | null;
  /**
   * Preview frames of characters/scenes (spec §18.1): 'capturing' while the
   * browser grabs them from the local file, 'done' after upload,
   * 'unavailable' when there is no local file (YouTube link, page reload).
   */
  previewsStatus: 'idle' | 'capturing' | 'done' | 'unavailable';
}

/**
 * Spec §9.1: the search box is pre-filled from the item's title and
 * auto-detected category — "кроссовки Pegasus 40", not just "Размер 42".
 * The category goes first (it is the generic search term); a title that
 * already contains the category isn't repeated.
 */
export function searchQueryFor(title: string, category: string | null): string {
  const t = title.trim();
  const c = (category ?? '').trim();
  if (!c) return t;
  if (!t) return c;
  return t.toLowerCase().includes(c.toLowerCase()) ? t : `${c} ${t}`;
}

/**
 * What a session created from a project item contributes to the initial
 * state (spec §7.8: the session holds a COPY of the item, so the wizard
 * reads it from the session, never from the project).
 */
/**
 * Что из сохранённой сессии возвращается в мастер (этап 39, А-2.7).
 *
 * До этого этапа возвращались только поля товара, а шаг всегда был
 * первым: свернули Mini App на время рендера — вернулись на «Видео», и
 * готовый оплаченный ролик недостижим интерфейсом никак.
 */
function restoreFromSession(
  session: Session | null
): Partial<UseWorkflowState> {
  if (!session) return {};
  return {
    currentStep: stepFromSession(session),
    analysis: session.videoAnalysis ?? null,
    prompt: session.generationPrompt ?? null,
    generatedVideo: session.generatedVideo ?? null,
    videoHistory: session.videoHistory ?? [],
    brandManifest: session.brandManifestSnapshot ?? null,
    referenceAspectRatio: session.originalVideo?.frame?.aspectRatio ?? null,
    // Кнопку «Сгенерировать» на идущем рендере показывать нельзя: это
    // прямое приглашение заплатить дважды.
    isGeneratingVideo: isRenderInFlight(session),
    ...seedFromSession(session),
  };
}

function seedFromSession(session: Session | null): Partial<UseWorkflowState> {
  const info = session?.productInformation;
  if (!session || !info) return {};
  return {
    prefilledFromProject: true,
    projectId: session.projectId ?? null,
    brandManifest: session.brandManifestSnapshot ?? null,
    productName: info.productName,
    productDescription: info.productDescription,
    productCategory: info.category ?? null,
    marketLanguage: info.languageCode ?? null,
    dialogueLanguage: info.dialogueLanguage ?? null,
    searchDefaults: {
      query: searchQueryFor(info.productName, info.category ?? null),
      regionCode: info.countryCode ?? null,
      language: info.languageCode ?? null,
    },
    // The item photo is already in Blob storage under the session's
    // productImagePathname — GenerationService downloads it from there, so
    // the image step is satisfied without a second upload.
    ...(info.productImagePathname
      ? {
          productImagePreview: info.productImageUrl ?? null,
          imageUploadProgress: 100,
        }
      : {}),
  };
}

/**
 * Шаги, на которые можно перейти по степперу (этап 52, В-1.5): только
 * то, что уже пройдено и чем можно пользоваться. Вперёд без данных нельзя;
 * пока идёт платная работа — никуда.
 */
function stepTargets(s: UseWorkflowState): Array<WorkflowStep | null> {
  if (s.isAnalyzing || s.isGeneratingVideo || s.isUploading) {
    return [null, null, null, null, null];
  }
  const analysed = s.analysis?.status === 'complete';
  return [
    'upload',
    analysed ? 'analysis-complete' : null,
    analysed ? 'product-input' : null,
    analysed && s.productName ? 'prompt-generation' : null,
    s.prompt?.approvedAt ? 'video-generation' : null,
  ];
}

/**
 * Custom hook for managing the video generation workflow
 */
export function useWorkflow() {
  // Словарь текущей локали — нужен, чтобы сообщения об ошибках (Г-5.1
  // из аудита) не были жёстко зашиты по-русски, а шли через словарь.
  const { dict } = useI18n();
  const [state, setState] = useState<UseWorkflowState>({
    currentStep: 'upload',
    sessionId: null,
    isInitializing: true,
    isUploading: false,
    uploadProgress: 0,
    isAnalyzing: false,
    analysis: null,
    productName: null,
    productDescription: null,
    isSubmittingProduct: false,
    prompt: null,
    isGeneratingPrompt: false,
    isUpdatingPrompt: false,
    isApprovingPrompt: false,
    productImage: null,
    productImagePreview: null,
    isUploadingImage: false,
    imageUploadProgress: 0,
    generatedVideo: null,
    videoHistory: [],
    isGeneratingVideo: false,
    originalVideoUrl: null,
    error: null,
    prefilledFromProject: false,
    projectId: null,
    brandManifest: null,
    searchDefaults: null,
    productCategory: null,
    marketLanguage: null,
    dialogueLanguage: null,
    referenceAspectRatio: null,
    referenceFrameSource: null,
    previewsStatus: 'idle',
  });

  const videoPollingInterval = useRef<number | null>(null);
  /** Тик опроса ещё выполняется — следующий пропускаем (этап 37, А-2.2). */
  const inFlight = useRef(false);
  /** Подряд идущие сбои опроса: после ролика они не повод для красной ошибки. */
  const pollFailures = useRef(0);
  /** М-7.3: последний реальный опрос батч-ролика (см. startVideoPolling). */
  const lastBatchPollAt = useRef(0);
  /** М-7.4: подряд идущие сбои опроса разбора — прерываем после трёх. */
  const analysisPollFailures = useRef(0);
  /**
   * Последнее состояние для чтения ВНУТРИ интервала. `setState`-колбэк
   * туда не годится: решение «показывать ошибку или молча перестать
   * ждать» принимается до и вне обновления состояния.
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  const stopVideoPolling = useCallback(() => {
    if (videoPollingInterval.current) {
      clearInterval(videoPollingInterval.current);
      videoPollingInterval.current = null;
    }
    inFlight.current = false;
  }, []);

  /**
   * Опрос разбора — в ref, а не в локальной переменной (этап 48, В-5.7):
   * локальный `setInterval` не гасился ни уходом с мастера, ни повторным
   * запуском, и тикал каждые три секунды навсегда — с `setState` в
   * размонтированный хук.
   */
  const analysisPollingInterval = useRef<number | null>(null);
  const stopAnalysisPolling = useCallback(() => {
    if (analysisPollingInterval.current) {
      clearInterval(analysisPollingInterval.current);
      analysisPollingInterval.current = null;
    }
  }, []);

  /**
   * Initialize session on mount
   */
  useEffect(() => {
    let isSubscribed = true; // Flag to prevent state updates after unmount

    const initSession = async () => {
      try {
        // §35.5 (этап 59): локаль на момент создания сессии — дальше
        // бэкенд использует её для локализации ИИ-вывода весь срок жизни сессии.
        const locale = readStoredLocale() ?? defaultLocale;

        // Этап 60 (ТЗ §40): «Сделать такой же» с публичной страницы ролика
        // приходит query-параметром, не Telegram-механизмом (start_param в
        // проекте нигде не используется) — обычная ссылка, которую
        // landing/ подставляет в TMA_URL.
        //
        // Г-1.2 (аудит round4, этап 64): раньше fromShared читался ПОСЛЕ
        // ветки восстановления сохранённой сессии, которая делает `return`
        // раньше, чем до него доходит очередь, — у любого, кто уже открывал
        // приложение (то есть у ЦЕЛЕВОЙ аудитории петли шеринга), форк
        // молча игнорировался, и человек попадал в свою старую сессию без
        // единого сообщения. Теперь fromShared разбирается ПЕРВЫМ и форкает
        // ВСЕГДА — независимо от того, есть ли уже сохранённый sessionId:
        // старый идентификатор просто заменяется новым форкнутым.
        const fromShared = new URLSearchParams(window.location.search).get(
          'fromShared'
        );
        if (fromShared) {
          const newSessionId = (await forkSharedVideo(fromShared, locale))
            .sessionId;
          localStorage.setItem('sessionId', newSessionId);
          // Ссылку убираем сразу — иначе она переживёт reload и путается с
          // новым переходом по чужой ссылке в этой же вкладке. Хеш (роут)
          // сохраняем — иначе следующий reload/back вместо мастера покажет
          // «Проекты», хотя мы только что туда осознанно перешли (App.tsx,
          // Г-1.1).
          window.history.replaceState(
            null,
            '',
            window.location.pathname + window.location.hash
          );
          if (isSubscribed) {
            // Форк мог сразу применить разбор библиотеки (§21.3) — если
            // так, сессия уже на шаге «разбор готов», и это надо
            // подхватить, а не показать пустой upload-экран поверх
            // готового разбора.
            const forked = await getSession(newSessionId);
            setState((prev) => ({
              ...prev,
              ...(forked ? restoreFromSession(forked) : {}),
              sessionId: newSessionId,
              isInitializing: false,
            }));
          }
          return;
        }

        // Try to get existing session ID from localStorage
        const storedSessionId = localStorage.getItem('sessionId');

        if (storedSessionId) {
          // Живость сессии проверяется тем, что не зависит от стадии
          // (этап 48, В-1.1). Раньше здесь звался статус разбора, а
          // сервер на сессии без разбора отвечает 400 — и сессия,
          // только что созданная из товара проекта (разбора у неё нет
          // по определению), выбрасывалась на первом же рендере вместе
          // со снимком товара и манифеста. Переход «проект → генерация»
          // не проходился вообще.
          //
          // Сбрасываем сохранённый идентификатор только когда сервер
          // прямо сказал, что сессии нет или она чужая (404/403);
          // сетевой сбой — не повод заводить новую и терять старую.
          let seeded: Session | null = null;
          try {
            seeded = await getSession(storedSessionId);
          } catch (error) {
            const status = axios.isAxiosError(error)
              ? error.response?.status
              : undefined;
            if (status === 404 || status === 403) {
              localStorage.removeItem('sessionId');
            } else {
              throw error;
            }
          }
          if (seeded && isSubscribed) {
            const restored = restoreFromSession(seeded);
            const resumeAnalysis = restored.currentStep === 'analyzing';
            setState((prev) => ({
              ...prev,
              ...restored,
              // Разбор шёл, пока приложение было свёрнуто (В-1.2): без
              // этого флага экран показывал пустой разбор без единой
              // кнопки, а опрос никто не запускал.
              isAnalyzing: resumeAnalysis,
              sessionId: storedSessionId,
              isInitializing: false,
            }));
            // Рендер шёл, пока приложение было свёрнуто: без
            // возобновления опроса пользователь смотрит на спиннер,
            // который никогда не сменится (этап 39, А-2.7).
            if (isRenderInFlight(seeded)) {
              startVideoPolling(storedSessionId);
            }
            if (resumeAnalysis) {
              startAnalysisPolling(storedSessionId);
            }
            return;
          }
        }

        // fromShared уже разобран и обработан выше (Г-1.2) — сюда доходим
        // только когда его нет: обычное создание пустой сессии.
        const newSessionId = (await createSession(locale)).sessionId;

        // Store session ID in localStorage
        localStorage.setItem('sessionId', newSessionId);

        // Only update state if component is still mounted
        if (isSubscribed) {
          setState((prev) => ({
            ...prev,
            sessionId: newSessionId,
            isInitializing: false,
          }));
        }
      } catch (error) {
        console.error('Failed to create session:', error);
        if (isSubscribed) {
          setState((prev) => ({
            ...prev,
            isInitializing: false,
            error: errorMessage(
              error,
              dict.wizardErrors.sessionCreateFailed,
              dict.errors
            ),
          }));
        }
      }
    };

    initSession();

    // Cleanup function to prevent state updates after unmount
    return () => {
      isSubscribed = false;
    };
    // Эффект инициализации сессии — строго один раз за монтирование.
    // `startVideoPolling` стабилен (useCallback без меняющихся зависимостей),
    // и включать его в список значило бы перезапускать инициализацию.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The uploaded reference File stays here (not in state — it is not
   * rendered) so preview frames can be grabbed from it once the analysis
   * says where to look (§18.1). Cleared for YouTube links.
   */
  const referenceFileRef = useRef<File | null>(null);

  /** After a complete analysis: grab preview frames from the local file and upload them. */
  const capturePreviews = useCallback(
    async (sessionId: string, analysis: VideoAnalysis) => {
      const file = referenceFileRef.current;
      const requests = previewRequests(analysis);
      if (!file || requests.length === 0) {
        setState((prev) => ({
          ...prev,
          previewsStatus: file ? 'done' : 'unavailable',
        }));
        return;
      }
      setState((prev) => ({ ...prev, previewsStatus: 'capturing' }));
      try {
        const frames = await captureFrames(file, requests);
        const updated = await uploadPreviewFrames(sessionId, frames);
        setState((prev) => ({
          ...prev,
          previewsStatus: 'done',
          analysis: updated ?? prev.analysis,
        }));
      } catch (e) {
        console.warn('Preview capture failed:', e);
        setState((prev) => ({ ...prev, previewsStatus: 'done' }));
      }
    },
    []
  );

  /**
   * Опрос разбора до готовности. Вызывается и после запуска разбора, и
   * при восстановлении сессии в статусе «идёт разбор» (этап 48, В-1.2)
   * — одна и та же логика, один и тот же выход.
   */
  const startAnalysisPolling = useCallback(
    (sessionId: string) => {
      stopAnalysisPolling();
      const tick = async () => {
        try {
          const analysis = await getAnalysisStatus(sessionId);
          analysisPollFailures.current = 0;
          if (analysis.status === 'complete') {
            stopAnalysisPolling();
            setState((prev) => ({
              ...prev,
              isAnalyzing: false,
              analysis,
              currentStep: 'analysis-complete',
            }));
            // Spec §18.1: preview frames from the local file, if we have it.
            void capturePreviews(sessionId, analysis);
            // Spec §16: for YouTube links the frame comes from Gemini's
            // read, stored on the session's originalVideo during analysis.
            void getSession(sessionId)
              .then((s) => {
                const frame = s?.originalVideo?.frame;
                if (!frame) return;
                setState((prev) =>
                  prev.referenceFrameSource === 'file'
                    ? prev
                    : {
                        ...prev,
                        referenceAspectRatio: frame.aspectRatio,
                        referenceFrameSource: frame.source,
                      }
                );
              })
              .catch(() => undefined);
          } else if (analysis.status === 'failed') {
            stopAnalysisPolling();
            setState((prev) => ({
              ...prev,
              isAnalyzing: false,
              // Возврат к выбору референса (этап 39, А-2.8). Без него
              // пользователь оставался на шаге «Анализ» с пустой
              // карточкой и без единой кнопки: уйти можно было только
              // перезагрузкой страницы, о которой нигде не сказано.
              currentStep: 'upload',
              error: analysis.error?.message || dict.wizardErrors.analysisFailed,
            }));
          }
        } catch (error) {
          console.error('Error checking analysis status:', error);
          // М-7.4 седьмого аудита: в Mini App фоновые запросы регулярно
          // обрываются; одна ошибка сети выбрасывала на шаг «Видео», а
          // повторная загрузка референса запускала второй платный разбор.
          // Тот же допуск, что у опроса рендера: три сбоя подряд.
          analysisPollFailures.current += 1;
          if (analysisPollFailures.current < 3) return;
          stopAnalysisPolling();
          setState((prev) => ({
            ...prev,
            isAnalyzing: false,
            currentStep: 'upload',
            error: errorMessage(
              error,
              dict.wizardErrors.analysisStatusFailed,
              dict.errors
            ),
          }));
        }
      };
      // Первый тик сразу: при восстановлении разбор мог уже закончиться,
      // и ждать три секунды ради этого незачем.
      void tick();
      analysisPollFailures.current = 0;
      analysisPollingInterval.current = window.setInterval(
        () => void tick(),
        3000
      );
    },
    [capturePreviews, stopAnalysisPolling, dict]
  );

  const handleTriggerAnalysis = useCallback(async () => {
    if (!state.sessionId) return;

    setState((prev) => ({
      ...prev,
      isAnalyzing: true,
      currentStep: 'analyzing',
      error: null,
    }));

    try {
      await triggerAnalysis(state.sessionId);
      startAnalysisPolling(state.sessionId);
    } catch (error) {
      console.error('Error triggering analysis:', error);
      setState((prev) => ({
        ...prev,
        isAnalyzing: false,
        currentStep: 'upload',
        error: errorMessage(
          error,
          dict.wizardErrors.analysisStartFailed,
          dict.errors
        ),
      }));
    }
  }, [state.sessionId, startAnalysisPolling, dict]);

  /**
   * Upload video file
   */
  const handleUploadVideo = useCallback(
    async (file: File) => {
      referenceFileRef.current = file;
      if (!state.sessionId) {
        console.error('Upload attempted without session ID');
        setState((prev) => ({
          ...prev,
          error: dict.wizardErrors.sessionNotReady,
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        isUploading: true,
        uploadProgress: 0,
        error: null,
      }));

      try {
        // Spec §16: read the file's pixel size before the PUT — exact, and
        // free; Gemini's estimate is only the fallback for YouTube links.
        const size = await readVideoSize(file);
        if (size) {
          const ratio = aspectRatioFromSize(size.width, size.height);
          setState((prev) => ({
            ...prev,
            referenceAspectRatio: ratio,
            referenceFrameSource: 'file',
          }));
        }
        await uploadVideo(
          state.sessionId,
          file,
          (progress) => {
            setState((prev) => ({
              ...prev,
              uploadProgress: progress,
            }));
          },
          size
        );

        setState((prev) => ({
          ...prev,
          isUploading: false,
          uploadProgress: 100,
        }));

        // Auto-trigger analysis after successful upload
        await handleTriggerAnalysis();
      } catch (error) {
        setState((prev) => ({
          ...prev,
          isUploading: false,
          error: errorMessage(
            error,
            dict.wizardErrors.uploadFailed,
            dict.errors
          ),
        }));
      }
    },
    [state.sessionId, handleTriggerAnalysis, dict]
  );

  /**
   * Register a public YouTube video as the analysis reference (alternative
   * to uploadVideo — no file, no blob, Gemini fetches the URL itself).
   */
  /**
   * Spec §21: третий путь — взять готовый разбор из библиотеки. Gemini не
   * вызывается вовсе: сервер копирует разбор в сессию, мастер сразу
   * оказывается на шаге «Анализ». Кадры-превью приходят внутри разбора,
   * локального файла нет — статус превью «недоступны».
   */
  const handlePickLibraryEntry = useCallback(
    async (entryId: string) => {
      if (!state.sessionId) return;
      referenceFileRef.current = null;
      setState((prev) => ({
        ...prev,
        isUploading: true,
        isAnalyzing: true,
        currentStep: 'analyzing',
        error: null,
      }));
      try {
        const analysis = await applyLibraryEntry(state.sessionId, entryId);
        setState((prev) => ({
          ...prev,
          isUploading: false,
          isAnalyzing: false,
          analysis,
          currentStep: 'analysis-complete',
          previewsStatus: 'unavailable',
          referenceAspectRatio:
            analysis.frame?.aspectRatio ?? prev.referenceAspectRatio,
          referenceFrameSource: analysis.frame
            ? 'gemini'
            : prev.referenceFrameSource,
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          isUploading: false,
          isAnalyzing: false,
          currentStep: 'upload',
          error: errorMessage(
            error,
            dict.wizardErrors.libraryPickFailed,
            dict.errors
          ),
        }));
      }
    },
    [state.sessionId, dict]
  );

  const handleSubmitYoutubeUrl = useCallback(
    async (youtubeUrl: string) => {
      if (!state.sessionId) {
        setState((prev) => ({
          ...prev,
          error: dict.wizardErrors.sessionNotReady,
        }));
        return;
      }

      referenceFileRef.current = null;
      setState((prev) => ({ ...prev, isUploading: true, error: null }));

      try {
        await registerYoutubeVideo(state.sessionId, youtubeUrl);
        setState((prev) => ({ ...prev, isUploading: false }));

        // Auto-trigger analysis, same as after a file upload
        await handleTriggerAnalysis();
      } catch (error) {
        setState((prev) => ({
          ...prev,
          isUploading: false,
          error: errorMessage(
            error,
            dict.wizardErrors.youtubeLinkFailed,
            dict.errors
          ),
        }));
      }
    },
    [state.sessionId, handleTriggerAnalysis, dict]
  );

  /**
   * Update analysis with user edits
   */
  const handleUpdateAnalysis = useCallback(
    async (editedText: string) => {
      if (!state.sessionId) {
        setState((prev) => ({
          ...prev,
          error: dict.wizardErrors.noActiveSession,
        }));
        return;
      }

      try {
        const updatedAnalysis = await updateAnalysis(
          state.sessionId,
          editedText
        );

        setState((prev) => ({
          ...prev,
          analysis: updatedAnalysis,
          currentStep: 'product-input', // Move to next step after saving
        }));
      } catch (error) {
        // Check if it's a session not found error
        const message = errorMessage(
          error,
          dict.wizardErrors.analysisEditFailed,
          dict.errors
        );

        if (/session not found|not found|не найден/i.test(message)) {
          // Clear invalid session
          localStorage.removeItem('sessionId');
          setState((prev) => ({
            ...prev,
            error: dict.wizardErrors.sessionExpired,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            error: message,
          }));
        }
      }
    },
    [state.sessionId, dict]
  );

  /**
   * Clear error
   */
  const clearError = useCallback(() => {
    setState((prev) => ({
      ...prev,
      error: null,
    }));
  }, []);

  /**
   * Показать ошибку на экране. Нужен там, где ошибку рождает не сам хук:
   * до этапа 39 отказы выбора файла («формат не поддерживается», «файл
   * больше 100 МБ») уходили в `console.error`, и интерфейс выглядел
   * зависшим — пользователь жал ещё раз с тем же файлом (А-2.12).
   */
  const showError = useCallback((message: string) => {
    setState((prev) => ({ ...prev, error: message }));
  }, []);

  /**
   * Submit product information
   */
  const handleSubmitProductInfo = useCallback(
    async (
      productName: string,
      productDescription: string,
      dialogueLanguage?: string | null
    ) => {
      if (!state.sessionId) {
        setState((prev) => ({
          ...prev,
          error: dict.wizardErrors.noActiveSession,
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        isSubmittingProduct: true,
        error: null,
      }));

      try {
        await submitProductInfo(
          state.sessionId,
          productName,
          productDescription,
          dialogueLanguage
        );

        setState((prev) => ({
          ...prev,
          isSubmittingProduct: false,
          productName,
          productDescription,
          dialogueLanguage: dialogueLanguage ?? prev.dialogueLanguage,
          currentStep: 'prompt-generation',
        }));
      } catch (error) {
        const message = errorMessage(
          error,
          dict.wizardErrors.productSaveFailed,
          dict.errors
        );

        if (/session not found|not found|не найден/i.test(message)) {
          localStorage.removeItem('sessionId');
          setState((prev) => ({
            ...prev,
            isSubmittingProduct: false,
            error: dict.wizardErrors.sessionExpired,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            isSubmittingProduct: false,
            error: message,
          }));
        }
      }
    },
    [state.sessionId, dict]
  );

  /**
   * Generate prompt from analysis and product info
   */
  const handleGeneratePrompt = useCallback(async () => {
    if (!state.sessionId) {
      setState((prev) => ({
        ...prev,
        error: dict.wizardErrors.noActiveSession,
      }));
      return;
    }

    setState((prev) => ({
      ...prev,
      isGeneratingPrompt: true,
      error: null,
    }));

    try {
      const generatedPrompt = await generatePrompt(state.sessionId);

      setState((prev) => ({
        ...prev,
        isGeneratingPrompt: false,
        prompt: generatedPrompt,
      }));
    } catch (error) {
      const message = errorMessage(
        error,
        dict.wizardErrors.promptBuildFailed,
        dict.errors
      );

      if (/session not found|not found|не найден/i.test(message)) {
        localStorage.removeItem('sessionId');
        setState((prev) => ({
          ...prev,
          isGeneratingPrompt: false,
          error: dict.wizardErrors.sessionExpired,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          isGeneratingPrompt: false,
          error: message,
        }));
      }
    }
  }, [state.sessionId, dict]);

  /**
   * Update prompt with user edits
   */
  const handleUpdatePrompt = useCallback(
    async (editedText: string, voiceoverScript?: string) => {
      if (!state.sessionId) {
        setState((prev) => ({
          ...prev,
          error: dict.wizardErrors.noActiveSession,
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        isUpdatingPrompt: true,
        error: null,
      }));

      try {
        const updatedPrompt = await updatePrompt(
          state.sessionId,
          editedText,
          voiceoverScript
        );

        setState((prev) => ({
          ...prev,
          isUpdatingPrompt: false,
          prompt: updatedPrompt,
        }));
      } catch (error) {
        const message = errorMessage(
          error,
          dict.wizardErrors.promptSaveFailed,
          dict.errors
        );

        if (/session not found|not found|не найден/i.test(message)) {
          localStorage.removeItem('sessionId');
          setState((prev) => ({
            ...prev,
            isUpdatingPrompt: false,
            error: dict.wizardErrors.sessionExpired,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            isUpdatingPrompt: false,
            error: message,
          }));
        }
      }
    },
    [state.sessionId, dict]
  );

  /**
   * Approve prompt for video generation
   */
  const handleApprovePrompt = useCallback(async () => {
    if (!state.sessionId) {
      setState((prev) => ({
        ...prev,
        error: dict.wizardErrors.noActiveSession,
      }));
      return;
    }

    setState((prev) => ({
      ...prev,
      isApprovingPrompt: true,
      error: null,
    }));

    try {
      const approvedPrompt = await approvePrompt(state.sessionId);

      setState((prev) => ({
        ...prev,
        isApprovingPrompt: false,
        prompt: approvedPrompt,
        currentStep: 'video-generation', // Move to next step after approval
      }));
    } catch (error) {
      const message = errorMessage(
        error,
        dict.wizardErrors.promptApproveFailed,
        dict.errors
      );

      if (/session not found|not found|не найден/i.test(message)) {
        localStorage.removeItem('sessionId');
        setState((prev) => ({
          ...prev,
          isApprovingPrompt: false,
          error: dict.wizardErrors.sessionExpired,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          isApprovingPrompt: false,
          error: message,
        }));
      }
    }
  }, [state.sessionId, dict]);

  /**
   * Handle product image selection
   */
  const handleImageSelect = useCallback((file: File) => {
    // Create preview URL
    const previewUrl = URL.createObjectURL(file);

    setState((prev) => ({
      ...prev,
      productImage: file,
      productImagePreview: previewUrl,
    }));
  }, []);

  /**
   * Upload product image
   */
  const handleUploadProductImage = useCallback(async () => {
    if (!state.sessionId || !state.productImage) {
      setState((prev) => ({
        ...prev,
        error: dict.wizardErrors.photoMissing,
      }));
      return;
    }

    setState((prev) => ({
      ...prev,
      isUploadingImage: true,
      imageUploadProgress: 0,
      error: null,
    }));

    try {
      await uploadProductImage(
        state.sessionId,
        state.productImage,
        (progress) => {
          setState((prev) => ({
            ...prev,
            imageUploadProgress: progress,
          }));
        }
      );

      setState((prev) => ({
        ...prev,
        isUploadingImage: false,
        imageUploadProgress: 100,
      }));
    } catch (error) {
      const message = errorMessage(
        error,
        dict.wizardErrors.photoUploadFailed,
        dict.errors
      );

      setState((prev) => ({
        ...prev,
        isUploadingImage: false,
        error: message,
      }));
    }
  }, [state.sessionId, state.productImage, dict]);

  /**
   * Generate video using Google Veo 3.1
   * @param quality - 'fast' (default, Veo 3.1 Lite) or 'standard' (full Veo 3.1)
   */
  /**
   * Опрос статуса ролика. Отдельной функцией, а не внутри «сгенерировать»
   * (этап 39, А-2.7): его надо запускать ещё и при возврате в приложение,
   * если рендер шёл, пока оно было свёрнуто, — иначе пользователь сидит
   * перед спиннером, который никогда не сменится.
   *
   * Опрос ведёт ДВА процесса, а не один: рендер у Veo и следующую за ним
   * постобработку (§15.4/§16.1 — обрезка кадра и озвучка). До этапа 37
   * он гасился на `status === 'complete'`, то есть ровно в ту секунду,
   * когда задача постобработки только создана: она оплачивалась, готовый
   * файл ложился в Blob и до пользователя не доходил никогда, хотя
   * интерфейс обещал «ссылка обновится сама».
   */
  const startVideoPolling = useCallback(
    (sessionId: string) => {
      stopVideoPolling();
      inFlight.current = false;
      pollFailures.current = 0;

      videoPollingInterval.current = setInterval(async () => {
        // Тик не должен наезжать на предыдущий: переход «Veo закончил»
        // включает скачивание ролика и заливку в Blob и длится дольше
        // интервала. Наложение тиков — дублирующая работа на сервере и
        // лишние запросы отсюда.
        if (inFlight.current) return;
        // М-7.3 седьмого аудита: свёрнутая вкладка не опрашивает; ролик
        // через Batch API xAI (до суток) — раз в минуту, а не каждые 4 с
        // (иначе ~23 000 запросов в сутки с одной вкладки, каждый —
        // вызов xAI). Готовность всё равно досмотрит серверный крон.
        if (typeof document !== 'undefined' && document.hidden) return;
        if (
          stateRef.current.generatedVideo?.xaiBatchId &&
          Date.now() - lastBatchPollAt.current < BATCH_POLL_INTERVAL_MS
        ) {
          return;
        }
        lastBatchPollAt.current = Date.now();
        inFlight.current = true;
        try {
          const status = await getVideoStatus(sessionId);
          pollFailures.current = 0;

          setState((prev) => ({
            ...prev,
            generatedVideo: status,
            // Ролик показываем сразу, как только он снят: ждать
            // постобработку, глядя на спиннер, незачем — она заменит
            // ссылку сама.
            ...(status.status === 'complete'
              ? { isGeneratingVideo: false, currentStep: 'complete' as const }
              : {}),
          }));

          if (status.status === 'failed') {
            stopVideoPolling();
            setState((prev) => ({
              ...prev,
              isGeneratingVideo: false,
              error: status.error?.message || dict.wizardErrors.videoFailed,
            }));
          } else if (!shouldKeepPolling(status)) {
            // Ролик снят И постобработка завершилась (готова, упала или
            // не требовалась) — опрашивать больше нечего.
            stopVideoPolling();
          }
        } catch (error) {
          console.error('Error checking video status:', error);
          pollFailures.current += 1;
          const alreadyHaveVideo =
            stateRef.current.generatedVideo?.status === 'complete';

          if (alreadyHaveVideo) {
            // Ролик у пользователя уже есть и работает. Подменять готовый
            // экран красной ошибкой из-за икоты сети во время
            // необязательного улучшения хуже, чем тихо перестать ждать.
            if (pollFailures.current >= 3) stopVideoPolling();
          } else {
            stopVideoPolling();
            setState((prev) => ({
              ...prev,
              isGeneratingVideo: false,
              error: errorMessage(
                error,
                dict.wizardErrors.videoStatusFailed,
                dict.errors
              ),
            }));
          }
        } finally {
          inFlight.current = false;
        }
      }, 4000); // Poll every 4 seconds (within 3-5 second range)
    },
    [stopVideoPolling, dict]
  );

  const handleGenerateVideo = useCallback(
    async (
      quality: VideoQuality = 'fast',
      aspectRatio?: string | null,
      provider?: 'veo' | 'grok',
      resolution?: '480p' | '720p' | '1080p',
      targetDurationSeconds?: number,
      avoidText?: string
    ) => {
      if (!state.sessionId) {
        setState((prev) => ({
          ...prev,
          error: dict.wizardErrors.noActiveSession,
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        isGeneratingVideo: true,
        error: null,
      }));

      try {
        const video = await generateVideo(
          state.sessionId,
          quality,
          aspectRatio,
          provider,
          resolution,
          targetDurationSeconds,
          avoidText
        );

        setState((prev) => {
          // Доп. запрос владельца продукта: полная история версий —
          // тот же принцип, что и на бэкенде (generation.service.ts,
          // startGeneration()): уходящая попытка архивируется РОВНО
          // здесь, и только если она уже завершилась (complete или
          // failed). Идущая (pending/processing) сюда попасть не
          // может — новый старт при ней вообще не разрешён (Б-2.3).
          const previous = prev.generatedVideo;
          const previousFinished =
            previous &&
            (previous.status === 'complete' || previous.status === 'failed');
          return {
            ...prev,
            generatedVideo: video,
            videoHistory: previousFinished
              ? [previous, ...prev.videoHistory]
              : prev.videoHistory,
          };
        });

        startVideoPolling(state.sessionId);
      } catch (error) {
        const message = errorMessage(
          error,
          dict.wizardErrors.generationStartFailed,
          dict.errors
        );

        if (/session not found|not found|не найден/i.test(message)) {
          localStorage.removeItem('sessionId');
          setState((prev) => ({
            ...prev,
            isGeneratingVideo: false,
            error: dict.wizardErrors.sessionExpired,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            isGeneratingVideo: false,
            error: message,
          }));
        }
      }
    },
    [state.sessionId, startVideoPolling, dict]
  );

  /**
   * Переозвучить уже готовый ролик БЕЗ повторной генерации (доп. запрос
   * владельца продукта, этап 87 — постпродакшен-переозвучка). Тонкий
   * обработчик, тем же приёмом, что `handleGenerateVideo`: свой вызов
   * сервиса + тот же общий опрос (`startVideoPolling`) подхватывает
   * результат — `postStatus` вновь уходит в `'pending'`, а
   * `shouldKeepPolling` уже умеет ждать именно это состояние (готовый
   * `status` + идущая постобработка), второго канала опроса заводить не
   * пришлось.
   *
   * Ошибку НЕ гасим здесь и не пишем в общий `error` экрана — бросаем
   * дальше: `RevoicePanel` показывает её у себя, тем же приёмом, что
   * `ExportPanel` у своих действий (вызывает сервис напрямую, ловит
   * ошибку локально). Здесь состояние приходится трогать — успешный
   * ответ обязан попасть в общий `generatedVideo`, иначе главная кнопка
   * «Скачать» продолжала бы указывать на старую озвучку.
   */
  const handleReVoice = useCallback(
    async (voiceoverScript?: string) => {
      if (!state.sessionId) {
        throw new Error(dict.wizardErrors.noActiveSession);
      }
      const video = await reVoiceVideo(state.sessionId, voiceoverScript);
      setState((prev) => ({ ...prev, generatedVideo: video }));
      startVideoPolling(state.sessionId);
      return video;
    },
    [state.sessionId, startVideoPolling, dict]
  );

  /**
   * Analysis accepted as-is → product step. (Editing + saving the analysis
   * gets there through handleUpdateAnalysis; this is the no-edit path.)
   */
  /**
   * Вернуться на пройденный шаг (этап 52, В-1.5). Степпер был нарисован
   * без `onSelect`, и `session-step.ts` утверждал, что «вернуться к
   * разбору пользователь сможет сам», — а мог только перезагрузкой.
   * Разрешаем только то, что уже пройдено и чем можно пользоваться:
   * назад к разбору (кастинг, сцены, стиль ролика), к товару, к промпту.
   * Пока идёт платная работа — никуда: переключение шага посреди
   * рендера прятало бы кнопку и спиннер.
   */
  const goToStep = useCallback((index: number) => {
    setState((prev) => {
      const target = stepTargets(prev)[index] ?? null;
      if (!target || target === prev.currentStep) return prev;
      return { ...prev, currentStep: target, error: null };
    });
  }, []);

  /** Какие шаги степпера сейчас можно выбрать — для подсветки и кликов. */
  const selectableSteps = stepTargets(state).map((t) => t !== null);

  const proceedToProduct = useCallback(() => {
    setState((prev) => ({ ...prev, currentStep: 'product-input' }));
  }, []);

  /**
   * Audit fix applied (spec §11.2): the revised prompt is now the session's
   * draft (approval reset server-side) — go back to the prompt step so the
   * user reviews it in PromptEditor, approves, and regenerates through the
   * unchanged generation flow. The previous video stays on the server
   * until the new render overwrites it.
   */
  const startRevision = useCallback(
    (prompt: GenerationPrompt) => {
      stopVideoPolling();
      setState((prev) => ({
        ...prev,
        prompt,
        generatedVideo: null,
        isGeneratingVideo: false,
        error: null,
        currentStep: 'prompt-generation',
      }));
    },
    [stopVideoPolling]
  );

  /** BrandSnapshotEditor saved the session's manifest copy (§12). */
  const setBrandManifest = useCallback((snapshot: BrandManifestSnapshot) => {
    setState((prev) => ({ ...prev, brandManifest: snapshot }));
  }, []);

  /**
   * Переключатель озвучки на шаге генерации (доп. запрос владельца
   * продукта, 14.09.2026: модели читают кириллицу с неверными
   * ударениями, режим нужно менять на каждой сессии, не возвращаясь к
   * шагу разбора).
   *
   * Режим — часть снимка бренда ЭТОЙ сессии (тот же PATCH, что у
   * BrandSnapshotEditor), но он ещё и меняет промпт: при своём голосе
   * в бриф уходит «никто не говорит в кадре» (voiceModeBriefText на
   * сервере). Уже одобренный промпт собран под старый режим, поэтому
   * после смены он пересобирается сразу и сессия возвращается на шаг
   * промпта — тем же путём, что startRevision: сервер сбрасывает
   * одобрение, пользователь смотрит новый текст и одобряет заново.
   * Это осознанная цена одного лишнего вызова GPT против ролика, где
   * персонаж артикулирует одно, а слышно другое.
   */
  const changeVoiceMode = useCallback(
    async (voiceMode: VoiceMode) => {
      if (!state.sessionId) return;
      // М-7.8: снимок без поля показывается как 'veo' — клик по уже
      // подсвеченной пилюле не должен запускать платную пересборку.
      if ((state.brandManifest?.voiceMode ?? 'voiceover') === voiceMode) return;
      // М-7.2: пока идёт рендер, режим не меняем — иначе опрос рендера
      // продолжит писать generatedVideo поверх шага промпта.
      if (state.isGeneratingVideo) return;
      stopVideoPolling();
      setState((prev) => ({ ...prev, isGeneratingPrompt: true, error: null }));
      try {
        const snapshot = await updateBrandSnapshot(state.sessionId, {
          voiceMode,
        });
        setState((prev) => ({ ...prev, brandManifest: snapshot }));
        const prompt = await generatePrompt(state.sessionId);
        setState((prev) => ({
          ...prev,
          isGeneratingPrompt: false,
          prompt,
          generatedVideo: null,
          isGeneratingVideo: false,
          error: null,
          currentStep: 'prompt-generation',
        }));
      } catch (error) {
        // М-7.1: снимок уже мог смениться, а сервер при смене режима
        // сбрасывает одобрение промпта (project-session.service.ts) —
        // старый одобренный промпт больше не действителен. Возвращаем
        // на шаг промпта без него: пользователь пересоберёт вручную,
        // а «Сгенерировать» по несогласованному брифу недоступна.
        setState((prev) => ({
          ...prev,
          isGeneratingPrompt: false,
          prompt: null,
          generatedVideo: null,
          isGeneratingVideo: false,
          currentStep: 'prompt-generation',
          error: errorMessage(
            error,
            dict.wizardErrors.promptBuildFailed,
            dict.errors
          ),
        }));
      }
    },
    [
      state.sessionId,
      state.brandManifest?.voiceMode,
      state.isGeneratingVideo,
      stopVideoPolling,
      dict,
    ]
  );

  /**
   * Cleanup polling on unmount
   */
  useEffect(() => {
    return () => {
      if (videoPollingInterval.current) {
        clearInterval(videoPollingInterval.current);
      }
      // Этап 48 (В-5.7): опрос разбора тоже гасится при уходе с мастера.
      if (analysisPollingInterval.current) {
        clearInterval(analysisPollingInterval.current);
      }
    };
  }, []);

  return {
    ...state,
    uploadVideo: handleUploadVideo,
    submitYoutubeUrl: handleSubmitYoutubeUrl,
    pickLibraryEntry: handlePickLibraryEntry,
    triggerAnalysis: handleTriggerAnalysis,
    updateAnalysis: handleUpdateAnalysis,
    proceedToProduct,
    goToStep,
    selectableSteps,
    setBrandManifest,
    changeVoiceMode,
    startRevision,
    submitProductInfo: handleSubmitProductInfo,
    generatePrompt: handleGeneratePrompt,
    updatePrompt: handleUpdatePrompt,
    approvePrompt: handleApprovePrompt,
    selectProductImage: handleImageSelect,
    uploadProductImage: handleUploadProductImage,
    generateVideo: handleGenerateVideo,
    reVoice: handleReVoice,
    clearError,
    showError,
  };
}
