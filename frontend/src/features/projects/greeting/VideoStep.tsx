/**
 * Шаг 4 мастера поздравления — запуск рендера, опрос статуса и готовый
 * ролик с доставкой.
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Download } from 'lucide-react';
import {
  Card,
  CardHeader,
  Alert,
  Button,
  Spinner,
  Badge,
} from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';
import { navigate, routes } from '../../../lib/router';
import {
  isGenerationLocked,
  errorMessage,
} from '../../../services/projects-api';
import { recordInviteEvent } from '../../../services/invite-api';
import { useRenderVoiceConsent } from '../../voice/VoiceConsentFlow';
import { mediaPlaybackRef } from '../../../lib/media-playback';
import { VoiceConsentCard } from '../../voice/VoiceConsentCard';
import {
  announceStartRefusal,
  useVoiceProactiveWatch,
} from '../../voice/voice-proactive-bus';
import {
  getGreetingVideoStatus,
  startGreetingVideo,
} from '../../../services/greeting-api';
import {
  type GeneratedVideo,
  GenerationStatus,
  type GenerationPrompt,
  ModerationStatus,
} from '../../../types';
import { GreetingDeliveryPanel } from '../GreetingDeliveryPanel';
import type { GreetingBriefView } from '../../../types/project';
import { HelpButton } from '../HelpSheet';

const POLL_INTERVAL_MS = 4000;

// ── Шаг 4: видео ──────────────────────────────────────────────────────────

function isTerminal(video: GeneratedVideo | undefined): boolean {
  return (
    !!video &&
    video.status !== GenerationStatus.PENDING &&
    video.status !== GenerationStatus.PROCESSING
  );
}

export function VideoStep({
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
      // K4: отказ старта (стена, суточный лимит) помощник объясняет и
      // голосом — у включивших «голосом»; экран показал его сам.
      announceStartRefusal(e);
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

  // K4 (§4А.2 п.1): ролик готов, сценарий помечен проверкой — поводы
  // заговорить. Слышит их помощник, только если «голосом» включён.
  useVoiceProactiveWatch({
    sessionId,
    videoStatus: video?.status ?? null,
    promptId: prompt?.promptId ?? null,
    scriptFlagged: prompt?.moderationStatus === ModerationStatus.FLAGGED,
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
