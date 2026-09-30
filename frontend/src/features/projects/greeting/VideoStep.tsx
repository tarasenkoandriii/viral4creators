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
import { isGenerationLocked } from '../../../services/projects-api';
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
  greetingErrorMessage,
  startGreetingVideo,
} from '../../../services/greeting-api';
import {
  type GeneratedVideo,
  GenerationStatus,
  type GenerationPrompt,
  ModerationStatus,
  type Readiness,
} from '../../../types';
import {
  GREETING_SCRIPT_STALE,
  greetingErrorCodeOfError,
} from '../../../lib/greeting-errors';
import {
  isVoiceStartError,
  pollSettled,
  renderBlockOf,
  renderPollDelay,
  renderPollErrorKind,
  voiceTrackIssue,
} from '../../../lib/greeting-render';
import { reVoiceVideo } from '../../../services/postprod-api';
import type { SenderVoiceKind } from '../../../lib/greeting-character';
import { GreetingDeliveryPanel } from '../GreetingDeliveryPanel';
import type { GreetingBriefView } from '../../../types/project';
import { HelpButton } from '../HelpSheet';

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
  readiness,
  onGoToScript,
  voiceLabel = null,
  voiceKind = null,
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
  /** Готовность сессии: невыполненный обязательный пункт гасит кнопку. */
  readiness: Readiness | null;
  /** Прокрутить к шагу «Сценарий» — выход из «сценарий устарел». */
  onGoToScript?: () => void;
  /**
   * Чьим голосом прозвучит ролик — подпись сводки «Характера ролика»
   * (S2); `null` — выбор ещё не прочитан, строки голоса в сводке нет.
   */
  voiceLabel?: string | null;
  /** Вид выбранного голоса (аудит S2); `null` — не прочитан. */
  voiceKind?: SenderVoiceKind | null;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [starting, setStarting] = useState(false);
  // Стена бесплатного (этап 132) — отдельно от `error`: это не ошибка,
  // а состояние «нужен доступ», и рисуется оно по-другому.
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Старт отказал `GREETING_SCRIPT_STALE`: сценарий собран для других
   * фото или образа. Рядом с отказом — путь к «Пересобрать»; новая
   * сборка (новый `prompt`) снимает плашку.
   */
  const [staleScript, setStaleScript] = useState(false);
  /** Старт отказал из-за голоса (S2) — рядом с ошибкой путь к карточке голоса. */
  const [voiceStartError, setVoiceStartError] = useState(false);
  useEffect(() => {
    setStaleScript(false);
  }, [prompt]);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Опрос включён (ролик в работе), даже если сейчас ждёт паузу. */
  const pollingRef = useRef(false);
  /** Сбоев связи подряд — от них пауза до следующей попытки. */
  const failuresRef = useRef(0);
  const inFlight = useRef(false);
  const startingRef = useRef(false);
  /** Идёт «Переозвучить»: опрос ждёт конца постобработки, а не рендера. */
  const awaitingRevoiceRef = useRef(false);
  const [revoicing, setRevoicing] = useState(false);
  /** Переозвучку запросили в этом экране — показать, что она идёт. */
  const [revoiceRequested, setRevoiceRequested] = useState(false);
  // Опрос — таймер, а колбэк из мастера — новая стрелка на каждый рендер:
  // таймер зовёт последний, а не тот, что был при запуске.
  const onVideoRef = useRef(onVideo);
  onVideoRef.current = onVideo;
  /**
   * Беда с опросом (CONTRACT6 G-FE п. 1): `reconnecting` — нет связи,
   * пробуем снова сами; `stopped` — сервер отказал (4xx), нужна кнопка.
   */
  const [pollTrouble, setPollTrouble] = useState<
    { kind: 'reconnecting' } | { kind: 'stopped'; message: string } | null
  >(null);
  // Готовый ролик, играющий вслух, микрофон помощника не пишет как речь
  // (`media-playback.ts`, аудит волны 2). Один реф на компонент.
  const [videoPlaybackRef] = useState(() => mediaPlaybackRef());

  const clearPollTimer = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    pollingRef.current = false;
    clearPollTimer();
  }, [clearPollTimer]);

  /**
   * Один шаг опроса. Раньше опрос был `setInterval`, и первый же сетевой
   * сбой гасил его насовсем: ролик доснимался, а экран до перезагрузки
   * крутил «генерируется». Теперь сбой связи — пауза с удвоением
   * (`renderPollDelay`) и строка «нет связи, пробуем снова»; 4xx — стоп с
   * причиной и кнопкой; скрытая вкладка не опрашивает, а возобновляет
   * опрос по `visibilitychange`/`online` (эффект ниже).
   */
  const pollOnce = useCallback(async (): Promise<void> => {
    pollRef.current = null;
    if (!pollingRef.current || inFlight.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    inFlight.current = true;
    let next: number | null = null;
    try {
      const status = await getGreetingVideoStatus(sessionId);
      failuresRef.current = 0;
      setPollTrouble(null);
      if (status) onVideoRef.current(status);
      if (pollSettled(status, awaitingRevoiceRef.current)) {
        pollingRef.current = false;
        awaitingRevoiceRef.current = false;
      } else next = renderPollDelay(0);
    } catch (e) {
      const httpStatus = (e as { response?: { status?: number } })?.response
        ?.status;
      if (renderPollErrorKind(httpStatus) === 'stop') {
        pollingRef.current = false;
        setPollTrouble({
          kind: 'stopped',
          message: greetingErrorMessage(e, dict),
        });
      } else {
        failuresRef.current += 1;
        setPollTrouble({ kind: 'reconnecting' });
        next = renderPollDelay(failuresRef.current);
      }
    } finally {
      inFlight.current = false;
    }
    if (next !== null && pollingRef.current) {
      clearPollTimer();
      pollRef.current = setTimeout(() => void pollOnce(), next);
    }
  }, [sessionId, dict, clearPollTimer]);

  const startPolling = useCallback(
    (delay = renderPollDelay(0)) => {
      clearPollTimer();
      pollingRef.current = true;
      failuresRef.current = 0;
      setPollTrouble(null);
      pollRef.current = setTimeout(() => void pollOnce(), delay);
    },
    [clearPollTimer, pollOnce]
  );

  useEffect(() => {
    if (video && !isTerminal(video)) startPolling();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- запуск только по смене sessionId
  }, [sessionId]);

  // Вернулась связь или вкладка — спросить сразу, не дожидаясь паузы
  // (после нескольких сбоев она дорастает до минуты).
  useEffect(() => {
    const resume = () => {
      if (!pollingRef.current || inFlight.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      clearPollTimer();
      void pollOnce();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [pollOnce, clearPollTimer]);

  // CONTRACT6 G-FE п. 4: кнопка гаснет с причиной, а не отказом после
  // нажатия. Правило одно на кнопку и на согласие голосом.
  const renderBlock = renderBlockOf({
    moderationStatus: prompt?.moderationStatus,
    readiness,
  });
  const renderBlockText =
    renderBlock === 'flagged'
      ? dict.greetingUi.renderBlockedFlagged
      : renderBlock === 'not-ready'
        ? dict.greetingUi.renderBlockedNotReady
        : null;

  // Аудит S2: ролик готов, а наша речь на него не легла — немой ролик.
  const voiceIssue = voiceTrackIssue(video, {
    voiceKind,
    presenter: consentBrief.presenterProvider,
  });
  const s2 = dict.greetingSoniox;
  /**
   * «Переозвучить» — дорожка поверх ГОТОВОГО ролика тем же голосом, без
   * второго платного рендера (`/postprod/revoice`, как в постпродакшене).
   */
  const revoice = async () => {
    if (revoicing) return;
    setRevoicing(true);
    setError(null);
    try {
      // Ответ маршрута — общий тип постпродакшена; состояние ролика
      // поздравления читаем тем же опросом, что и рендер.
      await reVoiceVideo(sessionId);
      awaitingRevoiceRef.current = true;
      setRevoiceRequested(true);
      startPolling(0);
    } catch (e) {
      setError(greetingErrorMessage(e, dict));
    } finally {
      setRevoicing(false);
    }
  };
  /**
   * К карточке голоса. Голос готового ролика не меняется (карточки
   * заперты, CONTRACT6) — карточка сама объяснит путь через новую версию,
   * и плашка говорит то же самое словами (`changeVoiceHint`).
   */
  const goToVoiceCard = () =>
    document
      .querySelector('[data-qa="greeting-voice-card"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const start = async () => {
    // Повторный вход — двойное нажатие или нажатие поверх голосового
    // старта: `starting` из замыкания ещё прежний, ref — уже нет (K7).
    if (startingRef.current) return;
    if (renderBlock) return;
    startingRef.current = true;
    // Нажали сами — сводка для голоса больше не нужна (K7).
    consent.cancel();
    setStarting(true);
    setError(null);
    setLocked(false);
    setStaleScript(false);
    setVoiceStartError(false);
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
      } else {
        setError(greetingErrorMessage(e, dict));
        const code = greetingErrorCodeOfError(e);
        setStaleScript(code === GREETING_SCRIPT_STALE);
        setVoiceStartError(isVoiceStartError(code));
      }
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
      voice: voiceLabel,
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
        ? renderBlock
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
        {error && voiceStartError && (
          <div className="mt-2">
            <Button size="sm" variant="outline" onClick={goToVoiceCard}>
              {dict.greetingSoniox.changeVoiceButton}
            </Button>
          </div>
        )}
        {staleScript && (
          <Alert tone="info" className="mt-2">
            <div className="flex items-center justify-between gap-3">
              <span>
                {dict.greetingUi.scriptStaleHint.replace(
                  '{button}',
                  w.regenerateScriptButton
                )}
              </span>
              {onGoToScript && (
                <Button size="sm" variant="outline" onClick={onGoToScript}>
                  {dict.greetingUi.scriptStaleButton}
                </Button>
              )}
            </div>
          </Alert>
        )}

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
            disabled={!!renderBlock}
            onClick={() => void start()}
          >
            {w.generateVideoButton}
          </Button>
        )}
        {renderBlockText &&
          (!video || video.status === GenerationStatus.FAILED) && (
            <p className="mt-2 text-xs text-silver-400">{renderBlockText}</p>
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
        {pollTrouble?.kind === 'reconnecting' && (
          <Alert tone="warning" className="mt-2">
            {dict.greetingUi.pollReconnecting}
          </Alert>
        )}
        {pollTrouble?.kind === 'stopped' && (
          <Alert tone="error" className="mt-2">
            <div className="flex items-center justify-between gap-3">
              <span>{pollTrouble.message}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => startPolling(0)}
              >
                {dict.greetingUi.pollRetryButton}
              </Button>
            </div>
          </Alert>
        )}
        {video && video.status === GenerationStatus.FAILED && (
          <div className="space-y-2">
            <Alert tone="error">{video.error?.message ?? w.videoFailed}</Alert>
            <Button
              loading={starting}
              disabled={!!renderBlock}
              onClick={() => void start()}
            >
              {w.retryButton}
            </Button>
          </div>
        )}
        {video && video.status === GenerationStatus.COMPLETE && (
          <div className="space-y-3">
            <Badge tone="success">{w.videoReady}</Badge>
            {voiceIssue && (
              // Причину говорим своими словами: `voiceError` — технический
              // текст, в нём бывает сырой ответ провайдера.
              <Alert tone="warning">
                <p>
                  {voiceIssue.kind === 'failed'
                    ? s2.voiceFailed
                    : s2.voiceSkipped}
                </p>
                <p className="mt-1 text-xs">{s2.changeVoiceHint}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {voiceIssue.canRevoice && (
                    <Button
                      size="sm"
                      loading={revoicing}
                      onClick={() => void revoice()}
                    >
                      {s2.revoiceButton}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={goToVoiceCard}>
                    {s2.changeVoiceButton}
                  </Button>
                </div>
              </Alert>
            )}
            {revoiceRequested && video.postStatus === 'pending' && (
              <Alert tone="info">
                <Spinner size={14} className="inline mr-2" />
                {s2.revoicePending}
              </Alert>
            )}
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
            occasionDate={consentBrief.occasionDate}
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
