/**
 * Голос персоны (ТЗ Greeting 2.0 §4.1 п.6, §4.6): запись в приложении,
 * первой фразой — согласие вслух. Запись сама становится свидетельством
 * согласия, поэтому фраза показывается ДО кнопки записи, а загрузки
 * готового файла здесь нет (в отличие от «Моих клонированных голосов»):
 * чужой файл не несёт согласия владельца голоса.
 *
 * Приём записи — как у `MyVoicesSection` (features/brand/VoicePicker.tsx):
 * микрофон «занят» с запроса разрешения (прослушивание голосового
 * помощника на паузе — иначе фраза ушла бы на разбор как команда),
 * отпускается при любом исходе и при уходе с экрана.
 *
 * Клон — Standard и выше (В-1): на LITE — замок с объяснением.
 * Один голос на персону (§4.2), в лимит трёх клонов не входит.
 */

import { useEffect, useRef, useState } from 'react';
import { Mic, RotateCcw, Square, Volume2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  LockedNote,
  Spinner,
} from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { useFeature } from '../../lib/plan-context';
import { acquireMicBusy, mediaPlaybackRef } from '../../lib/media-playback';
import { releaseMicrophone } from '../../lib/mic-recorder';
import { revokeObjectUrl } from '../../lib/object-url';
import { haptic } from '../../lib/telegram';
import {
  baseMime,
  consentPhraseWithName,
  pickAudioMime,
} from '../../lib/persona-capture';
import { errorMessage } from '../../services/projects-api';
import {
  clonePersonaVoice,
  getVoiceConsentPhrase,
  uploadPersonaVoiceSample,
  type VoiceConsentPhrase,
} from '../../services/persona-api';
import { voiceState, type PersonaMe } from '../../lib/persona-flow';

function fmtSec(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function PersonaVoice({
  me,
  onChanged,
}: {
  me: PersonaMe;
  onChanged: () => void;
}) {
  const { dict, locale } = useI18n();
  const t = dict.persona;
  const feature = useFeature('voiceCloning');
  const [phrase, setPhrase] = useState<VoiceConsentPhrase | null>(null);
  const [phraseError, setPhraseError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [sample, setSample] = useState<{
    blob: Blob;
    mime: string;
    url: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playbackRef] = useState(() => mediaPlaybackRef());

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const micBusyRef = useRef<(() => void) | null>(null);

  const voice = me.voice;
  // Регистр статуса — как придёт (CONTRACT5): сравниваем нормализованный.
  const vstate = voice ? voiceState(voice.status) : null;
  const hasVoice = !!voice && vstate !== 'failed';
  const micSupported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if (!feature.allowed || hasVoice) return;
    let alive = true;
    setPhrase(null);
    setPhraseError(null);
    getVoiceConsentPhrase(locale)
      .then((p) => alive && setPhrase(p))
      .catch(
        (e) => alive && setPhraseError(errorMessage(e, undefined, dict.errors))
      );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature.allowed, hasVoice, locale]);

  // Пока голос обучается — перечитываем персону (статус у Resemble
  // подтягивает сервер), той же цепочкой setTimeout, что MyVoicesSection.
  useEffect(() => {
    if (vstate !== 'training') return;
    const timer = window.setTimeout(onChanged, 10000);
    return () => window.clearTimeout(timer);
  }, [vstate, onChanged]);

  const freeMicBusy = () => {
    micBusyRef.current?.();
    micBusyRef.current = null;
  };
  const stopTimer = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };
  const releaseMic = () => {
    const interrupted = releaseMicrophone(
      recorderRef.current,
      streamRef.current
    );
    recorderRef.current = null;
    streamRef.current = null;
    freeMicBusy();
    if (interrupted) chunksRef.current = [];
  };

  useEffect(
    () => () => {
      stopTimer();
      releaseMic();
    },
    // Уборка — только при уходе с экрана; функции читают ref'ы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useEffect(() => () => revokeObjectUrl(sample?.url ?? null), [sample]);

  const start = async () => {
    setError(null);
    // Занят уже с запроса разрешения: помощник не должен перехватить
    // микрофон, пока человек отвечает на окно браузера.
    freeMicBusy();
    const releaseBusy = acquireMicBusy();
    micBusyRef.current = releaseBusy;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickAudioMime(
        (m) =>
          typeof MediaRecorder !== 'undefined' &&
          !!MediaRecorder.isTypeSupported?.(m)
      );
      const rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
        releaseBusy();
        if (micBusyRef.current === releaseBusy) micBusyRef.current = null;
        const type = baseMime(rec.mimeType || mime, 'audio/webm');
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size === 0) {
          setError(t.emptyRecording);
          return;
        }
        setSample({ blob, mime: type, url: URL.createObjectURL(blob) });
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setSeconds(0);
      timerRef.current = window.setInterval(
        () => setSeconds((s) => s + 1),
        1000
      );
      haptic();
    } catch (e) {
      releaseMic();
      setError(t.voiceMicUnavailable.replace('{{error}}', errorMessage(e)));
    }
  };

  const stop = () => {
    stopTimer();
    setRecording(false);
    recorderRef.current?.stop();
    haptic();
  };

  const submit = async () => {
    if (!sample || !phrase) return;
    setSubmitting(true);
    setError(null);
    try {
      const { pathname } = await uploadPersonaVoiceSample(
        sample.blob,
        sample.mime
      );
      await clonePersonaVoice(
        pathname,
        name.trim() || t.voiceDefaultLabel,
        phrase?.version ?? ''
      );
      setSample(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e, undefined, dict.errors));
    } finally {
      setSubmitting(false);
    }
  };

  if (feature.loading) return null;

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader title={t.voiceTitle} hint={t.voiceLead} />
      {!feature.allowed ? (
        <LockedNote title={t.voiceLockedTitle} lock={feature.lock} compact>
          {t.voiceLockedBody}
        </LockedNote>
      ) : hasVoice && voice ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={vstate === 'ready' ? 'success' : 'neutral'}>
            {vstate === 'ready' ? t.voiceStatusReady : t.voiceStatusTraining}
          </Badge>
          <span className="text-silver-400">{t.voiceExists}</span>
        </div>
      ) : (
        <div className="space-y-3">
          {vstate === 'failed' && (
            <Alert tone="warning">{t.voiceStatusFailed}</Alert>
          )}
          <Field
            label={t.voiceNameLabel}
            htmlFor="persona-voice-name"
            hint={t.voiceNameHint}
          >
            <Input
              id="persona-voice-name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              disabled={recording || submitting}
            />
          </Field>
          <div>
            <p className="label">{t.voicePhraseLabel}</p>
            {phrase ? (
              <blockquote
                className="rounded-xl border-l-4 border-accent bg-accent/10 p-3 text-sm leading-relaxed"
                aria-live="polite"
              >
                {/* Имя, введённое здесь, важнее имени из Telegram: фразу
                    читает человек, и она должна звучать так, как он себя
                    называет. Пусто — готовая фраза сервера, если он знает
                    имя, иначе шаблон без вставки. */}
                {name.trim() || !phrase.text
                  ? consentPhraseWithName(phrase.template, name)
                  : phrase.text}
              </blockquote>
            ) : phraseError ? (
              <Alert tone="error">
                {t.voicePhraseFailed.replace('{{error}}', phraseError)}
              </Alert>
            ) : (
              <div className="flex items-center gap-2 text-xs text-silver-400">
                <Spinner size={14} />
                {t.voicePhraseLoading}
              </div>
            )}
            <p className="mt-1 text-xs text-silver-400">{t.voicePhraseAfter}</p>
          </div>

          {error && (
            <Alert tone="error" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}

          {!micSupported ? (
            <Alert tone="warning">{t.voiceUnsupported}</Alert>
          ) : !sample ? (
            recording ? (
              <Button
                variant="danger"
                icon={<Square size={14} />}
                onClick={stop}
              >
                {t.voiceStop} ·{' '}
                <span className="tabular">{fmtSec(seconds)}</span>
              </Button>
            ) : (
              <Button
                icon={<Mic size={14} />}
                disabled={!phrase}
                onClick={() => void start()}
              >
                {t.voiceRecord}
              </Button>
            )
          ) : (
            <div className="space-y-2">
              <audio
                ref={playbackRef}
                className="w-full"
                controls
                src={sample.url}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  icon={<Volume2 size={14} />}
                  loading={submitting}
                  onClick={() => void submit()}
                >
                  {t.voiceSubmit}
                </Button>
                <Button
                  variant="outline"
                  icon={<RotateCcw size={14} />}
                  disabled={submitting}
                  onClick={() => setSample(null)}
                >
                  {t.voiceRetake}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
