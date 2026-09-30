/**
 * Селфи с камеры (ТЗ Greeting 2.0 §4.1 п.2, §4.3): фото анфас и ролик
 * 3 секунды с поворотом головы.
 *
 * Только камера: поля выбора файла здесь нет и быть не должно —
 * загрузка из галереи пропускала бы чужое фото мимо проверки живости.
 *
 * Камера включается нажатием, а не при открытии шага: разрешение
 * браузер спрашивает в ответ на действие человека (иначе WebView
 * Telegram на iOS молча отказывает), и согласие к этому моменту уже
 * дано на предыдущем шаге. Где камеры нет (часть WebView Telegram) —
 * ссылка на веб-версию этого же экрана.
 *
 * Поток камеры принадлежит вкладке, а не компоненту: уход с экрана
 * обязан его погасить, иначе индикатор камеры горит до конца сессии —
 * тот же урок, что у записи голоса (lib/mic-recorder.ts, этап 119).
 */

import { useEffect, useRef, useState } from 'react';
import { Camera, RotateCcw, Video } from 'lucide-react';
import { Alert, Button, Card, CardHeader } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { routes } from '../../lib/router';
import {
  getTelegramWebApp,
  haptic,
  openExternalLink,
} from '../../lib/telegram';
import { errorMessage } from '../../services/projects-api';
import { revokeObjectUrl } from '../../lib/object-url';
import {
  livenessUploadMime,
  cameraSupport,
  headTurnCue,
  LIVENESS_MS,
  pickVideoMime,
  secondsLeft,
  webVersionUrl,
  type HeadTurnCue,
} from '../../lib/persona-capture';

export interface PersonaCapture {
  photo: Blob;
  photoType: string;
  video: Blob;
  videoType: string;
}

function detectSupport() {
  if (typeof window === 'undefined') return 'no-camera' as const;
  return cameraSupport({
    secureContext: window.isSecureContext !== false,
    hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
    hasMediaRecorder: typeof MediaRecorder !== 'undefined',
  });
}

export function PersonaCaptureStep({
  busy,
  onCaptured,
  onCancel,
}: {
  busy: boolean;
  onCaptured: (capture: PersonaCapture) => void;
  onCancel: () => void;
}) {
  const { dict } = useI18n();
  const t = dict.persona;
  const [support] = useState(detectSupport);
  const [cameraOn, setCameraOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [video, setVideo] = useState<{
    blob: Blob;
    type: string;
    url: string;
  } | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const videoEl = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);

  const stopTimer = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const stopCamera = () => {
    stopTimer();
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      // Сначала снять обработчики — иначе `onstop` доделает работу
      // снятого экрана (тот же порядок, что releaseMicrophone).
      rec.onstop = null;
      rec.ondataavailable = null;
      rec.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    setCameraOn(false);
    setRecording(false);
  };

  useEffect(
    () => () => stopCamera(),
    // Уборка — только при уходе с экрана; stopCamera читает ref'ы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => () => revokeObjectUrl(photo?.url ?? null), [photo]);
  useEffect(() => () => revokeObjectUrl(video?.url ?? null), [video]);

  // Фото и ролик сняты — камера гаснет сразу, на просмотре она не нужна
  // (индикатор камеры не должен гореть, пока человек смотрит снимки).
  // «Переснять» включает её заново кнопкой.
  useEffect(() => {
    if (photo && video) stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo, video]);

  // Поток подключается к <video> после того, как он отрисован.
  useEffect(() => {
    if (cameraOn && videoEl.current && streamRef.current) {
      videoEl.current.srcObject = streamRef.current;
      void videoEl.current.play().catch(() => undefined);
    }
  }, [cameraOn]);

  const startCamera = async () => {
    setError(null);
    setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 1280 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
    } catch (e) {
      stopCamera();
      setError(t.cameraDenied.replace('{{error}}', errorMessage(e)));
    } finally {
      setStarting(false);
    }
  };

  const takePhoto = () => {
    const v = videoEl.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Снимок НЕ отражается, хотя превью зеркальное: модель должна видеть
    // лицо как есть, а зеркало нужно только человеку перед камерой.
    ctx.drawImage(v, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError(t.photoFailed);
          return;
        }
        haptic();
        setPhoto({ blob, url: URL.createObjectURL(blob) });
      },
      'image/jpeg',
      0.92
    );
  };

  const recordVideo = () => {
    const stream = streamRef.current;
    if (!stream) return;
    setError(null);
    const mime = pickVideoMime(
      (m) =>
        typeof MediaRecorder !== 'undefined' &&
        !!MediaRecorder.isTypeSupported?.(m)
    );
    let rec: MediaRecorder;
    try {
      rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch (e) {
      setError(t.videoFailed.replace('{{error}}', errorMessage(e)));
      return;
    }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      stopTimer();
      setRecording(false);
      recorderRef.current = null;
      const type = livenessUploadMime(rec.mimeType || mime);
      const blob = new Blob(chunks, { type });
      if (blob.size === 0) {
        setError(t.videoFailed.replace('{{error}}', t.emptyRecording));
        return;
      }
      haptic();
      setVideo({ blob, type, url: URL.createObjectURL(blob) });
    };
    recorderRef.current = rec;
    rec.start();
    const started = Date.now();
    setElapsed(0);
    setRecording(true);
    timerRef.current = window.setInterval(() => {
      const ms = Date.now() - started;
      setElapsed(ms);
      if (ms >= LIVENESS_MS && rec.state !== 'inactive') {
        stopTimer();
        rec.stop();
      }
    }, 100);
  };

  const cue: HeadTurnCue = recording ? headTurnCue(elapsed) : 'straight';
  const cueText: Record<HeadTurnCue, string> = {
    straight: t.cueStraight,
    left: t.cueLeft,
    right: t.cueRight,
    done: t.cueDone,
  };

  const submit = () => {
    if (!photo || !video) return;
    stopCamera();
    onCaptured({
      photo: photo.blob,
      photoType: 'image/jpeg',
      video: video.blob,
      videoType: video.type,
    });
  };

  const inTelegram = !!getTelegramWebApp();
  const openWeb = () =>
    openExternalLink(webVersionUrl(window.location, routes.persona()));

  if (support !== 'ok') {
    const text =
      support === 'insecure'
        ? t.cameraInsecure
        : support === 'no-recorder'
          ? t.recorderUnsupported
          : t.cameraUnsupported;
    return (
      <Card className="p-4 sm:p-5">
        <CardHeader title={t.captureTitle} />
        <Alert tone="warning">{text}</Alert>
        <div className="mt-3 flex flex-wrap gap-2">
          {inTelegram && support !== 'insecure' && (
            <Button onClick={openWeb}>{t.openWebVersion}</Button>
          )}
          <Button variant="ghost" onClick={onCancel}>
            {t.cancel}
          </Button>
        </div>
      </Card>
    );
  }

  const step: 'photo' | 'video' | 'review' = !photo
    ? 'photo'
    : !video
      ? 'video'
      : 'review';

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader title={t.captureTitle} hint={t.captureLead} />

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
          {inTelegram && (
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={openWeb}>
                {t.openWebVersion}
              </Button>
            </div>
          )}
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="label">
            {step === 'photo' ? t.photoStepLabel : t.videoStepLabel}
          </p>
          <div className="relative aspect-square overflow-hidden rounded-xl bg-silver-900">
            {cameraOn ? (
              <video
                ref={videoEl}
                autoPlay
                playsInline
                muted
                aria-label={t.cameraPreviewLabel}
                className="h-full w-full -scale-x-100 object-cover"
                data-qa-mask="persona-camera"
              />
            ) : (
              <div className="flex h-full items-center justify-center p-4 text-center text-xs text-silver-400">
                {t.cameraOff}
              </div>
            )}
            {recording && (
              <div
                className="absolute inset-x-0 bottom-0 bg-black/60 p-2 text-center text-sm font-medium text-white"
                aria-live="assertive"
              >
                {cueText[cue]} ·{' '}
                {t.secondsLeft.replace('{{n}}', String(secondsLeft(elapsed)))}
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-silver-400">
            {step === 'photo' ? t.photoTips : t.videoLead}
          </p>
        </div>

        <div className="space-y-2">
          {photo && (
            <figure>
              <figcaption className="label">{t.photoTaken}</figcaption>
              <img
                src={photo.url}
                alt={t.photoPreviewAlt}
                className="aspect-square w-full rounded-xl object-cover sm:w-40"
                data-qa-mask="persona-selfie"
              />
            </figure>
          )}
          {video && (
            <figure>
              <figcaption className="label">{t.videoTaken}</figcaption>
              <video
                src={video.url}
                controls
                playsInline
                muted
                aria-label={t.videoTaken}
                className="aspect-square w-full rounded-xl object-cover sm:w-40"
                data-qa-mask="persona-liveness"
              />
            </figure>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" aria-live="polite">
        {!cameraOn && step !== 'review' && (
          <Button
            icon={<Camera size={16} />}
            loading={starting}
            onClick={() => void startCamera()}
          >
            {t.cameraStart}
          </Button>
        )}
        {cameraOn && step === 'photo' && (
          <Button icon={<Camera size={16} />} onClick={takePhoto}>
            {t.takePhoto}
          </Button>
        )}
        {cameraOn && step === 'video' && (
          <Button
            icon={<Video size={16} />}
            loading={recording}
            onClick={recordVideo}
          >
            {recording ? t.recordingNow : t.recordVideo}
          </Button>
        )}
        {photo && !recording && (
          <Button
            variant="outline"
            icon={<RotateCcw size={14} />}
            disabled={busy}
            onClick={() => {
              setPhoto(null);
              setVideo(null);
            }}
          >
            {t.retakePhoto}
          </Button>
        )}
        {video && !recording && (
          <Button
            variant="outline"
            icon={<RotateCcw size={14} />}
            disabled={busy}
            onClick={() => setVideo(null)}
          >
            {t.retakeVideo}
          </Button>
        )}
        {step === 'review' && (
          <Button loading={busy} onClick={submit}>
            {t.submit}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={busy || recording}
          onClick={() => {
            stopCamera();
            onCancel();
          }}
        >
          {t.cancel}
        </Button>
      </div>
      <p className="mt-2 text-xs text-silver-400">{t.verifyHint}</p>
    </Card>
  );
}
