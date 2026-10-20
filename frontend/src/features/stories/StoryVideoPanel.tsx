import { exclusiveStoryPlayback } from './story-media-playback';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { api } from '../../services/api';
import { getAuthHeaders } from '../../lib/telegram';
import { acquireMicBusy } from '../../lib/media-playback';
import { releaseMicrophone } from '../../lib/mic-recorder';
import { pickRecorderMime } from '../../lib/voice-listen';
import { browserAudioDecoder } from '../../lib/voice-sample';
import type { DecodedAudioLike } from '../../lib/wav';
import {
  applyPronunciations,
  arrayBufferToBase64,
  cleanPronunciations,
  preambleFileError,
  storyPreambleWav,
  renderStatusLabel,
  storyBuildGate,
  storyQuoteRows,
  storyQuoteSummary,
  storyVideoRequest,
  STORY_PREAMBLE_MAX_SEC,
  STORY_PRONUNCIATION_CHARS,
  STORY_PRONUNCIATION_MAX,
  type PronunciationRow,
  type StoryVideoQuote,
} from './story-video-plan';
import {
  MIC_UNSUPPORTED,
  StoryClientError,
  storyErrorText,
  storyMicErrorText,
  storyMicSupported,
} from './story-errors';
import {
  deleteRecordingConfirm,
  includedInReserve,
  recordingDeletedNotice,
  type RecordingDeleted,
  videoQaConfirm,
} from './story-confirm';
import { formatUsd } from './story-wizard';
import { useStoryConfirm } from './StoryConfirm';
type Segment = {
  kind: 'intro' | 'gift_note' | 'main' | 'outro';
  position?: 'beginning' | 'end';
  source: string;
  text: string;
  seconds: number | null;
};
type Render = {
  id: string;
  status: string;
  voiceId: string;
  voiceLabel: string | null;
  userVoiceId: string | null;
  narratorManifestId: string | null;
  preambleText: string;
  preambleDuration: number | null;
  durationSeconds: number | null;
  baseHash: string;
  mainAudioHash: string;
  videoHash: string | null;
  reservedMicroUsd: number;
  approvedAt: string | null;
  qaStatus: string;
  /** Оценка проверки Soniox по длине экспорта (сервер; null — нет длины). */
  qaEstimateMicroUsd?: number | null;
  qa: { wer: number } | null;
  error: string | null;
  segments: { segments: Segment[]; layout: unknown } | null;
};
type Recording = { id: string; seconds: number; createdAt: string };
type View = {
  supported: boolean;
  baseUrl: string;
  coverUrl: string;
  base: { baseSha256: string; durationSeconds: number; revision: string };
  budgetUsd: number;
  reservedUsd: number;
  renders: Render[];
  narratorProfiles: { id: string; title: string; voiceLabel: string }[];
  voiceConsentVersion: string;
  voiceConsentText: string;
  recordingConsentVersion: string;
  recordingConsentText: string;
  recordings: Recording[];
  giftNote: { text: string; position: 'beginning' | 'end' } | null;
  hasGiftPhoto: boolean;
  preambleSuggestions: string[];
};
const SEGMENT_NAME: Record<Segment['kind'], string> = {
  intro: 'вступление',
  gift_note: 'реплика о подарке',
  main: 'сказка',
  outro: 'завершение',
};
const errorText = (e: unknown) => storyErrorText(e);
function media(base64: string, mime: string) {
  return URL.createObjectURL(
    new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
      type: mime,
    })
  );
}
/** WebVTT comes without the JSON envelope: a plain authorized fetch. */
async function fetchSubtitles(path: string) {
  const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';
  const res = await fetch(`${base}${path}`, {
    headers: getAuthHeaders(),
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('subtitles');
  return URL.createObjectURL(
    new Blob([await res.text()], { type: 'text/vtt' })
  );
}
export function StoryVideoPanel({
  giftId,
  classicText = true,
}: {
  giftId: string;
  /** Текст сказки — классическая редакция (читается точно по изданию). */
  classicText?: boolean;
}) {
  const [view, setView] = useState<View | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [intro, setIntro] = useState(
      'Сегодня я расскажу тебе сказку «Репка». Давай послушаем её вместе.'
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [video, setVideo] = useState<string | null>(null),
    [subtitles, setSubtitles] = useState<string | null>(null),
    [introAudio, setIntroAudio] = useState<string | null>(null),
    [mainAudio, setMainAudio] = useState<string | null>(null),
    [profileId, setProfileId] = useState(''),
    [voiceConsent, setVoiceConsent] = useState(false),
    [narratorImage, setNarratorImage] = useState(false),
    [source, setSource] = useState<'synth' | 'recorded'>('synth'),
    [recordingId, setRecordingId] = useState<string | null>(null),
    [recConsent, setRecConsent] = useState(false),
    [recording, setRecording] = useState(false),
    [recSeconds, setRecSeconds] = useState(0),
    [recPreview, setRecPreview] = useState<string | null>(null),
    [outro, setOutro] = useState(''),
    [pron, setPron] = useState<PronunciationRow[]>([]),
    [quoted, setQuoted] = useState<{
      key: string;
      quote: StoryVideoQuote;
    } | null>(null),
    [notice, setNotice] = useState('');
  const lock = useRef(false);
  const confirm = useStoryConfirm();
  /** Запись, остановленная во время другого действия: отправится следом (S3‑3). */
  const queuedRecording = useRef<Blob | null>(null);
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    micBusy = useRef<(() => void) | null>(null),
    timer = useRef<number | null>(null);
  const render =
    view?.renders.find((r) => r.id === selected) || view?.renders[0];
  const refresh = useCallback(async () => {
    const res = await api.get<View>(`/story-gifts/${giftId}/video`);
    if (res.data) setView(res.data);
  }, [giftId]);
  const renderId = render?.id;
  const renderStatus = render?.status;
  const pronCheck = cleanPronunciations(pron);
  const body = storyVideoRequest({
    preambleText: intro,
    preambleSource: source,
    recordingId,
    outroText: outro,
    pronunciations: pron,
    profileId,
    voiceConsent,
    voiceConsentVersion: view?.voiceConsentVersion,
    useNarratorImage: narratorImage,
  });
  const bodyKey = JSON.stringify(body);
  /** Смета действует только для того ввода, по которому её получили (S2‑3). */
  const quote = quoted && quoted.key === bodyKey ? quoted.quote : null;
  useEffect(() => {
    setQuoted((q) => (q && q.key !== bodyKey ? null : q));
  }, [bodyKey]);
  useEffect(() => {
    void refresh().catch((e) => setError(errorText(e)));
  }, [refresh]);
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      releaseMicrophone(recorder.current, stream.current);
      micBusy.current?.();
    },
    []
  );
  useEffect(
    () => () => {
      if (recPreview) URL.revokeObjectURL(recPreview);
    },
    [recPreview]
  );
  useEffect(() => {
    if (!renderId || !['PREPARING', 'PENDING'].includes(renderStatus!)) return;
    let alive = true;
    const t = setInterval(() => {
      void api
        .get<Render>(`/story-gifts/${giftId}/video/${renderId}`)
        .then(() => {
          if (alive) void refresh().catch(() => {});
        })
        .catch(() => {});
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [giftId, renderId, renderStatus, refresh]);
  useEffect(() => {
    setVideo(null);
    setIntroAudio(null);
    setMainAudio(null);
    setSubtitles(null);
    if (!renderId || renderStatus! !== 'READY') return;
    let active = true;
    const urls: string[] = [];
    void Promise.all([
      api.get<{ base64: string; mime: string }>(
        `/story-gifts/${giftId}/video/${renderId}/file`
      ),
      api.get<{ base64: string; mime: string }>(
        `/story-gifts/${giftId}/video/${renderId}/intro`
      ),
      api.get<{ base64: string; mime: string }>(
        `/story-gifts/${giftId}/video/${renderId}/main`
      ),
    ])
      .then(([v, a, m]) => {
        if (!active || !v.data || !a.data || !m.data) return;
        const u = media(v.data.base64, v.data.mime),
          i = media(a.data.base64, a.data.mime),
          main = media(m.data.base64, m.data.mime);
        urls.push(u, i, main);
        setVideo(u);
        setIntroAudio(i);
        setMainAudio(main);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    void fetchSubtitles(
      `/story-gifts/${giftId}/video/${renderId}/subtitles.vtt`
    )
      .then((u) => {
        if (active) {
          urls.push(u);
          setSubtitles(u);
        } else URL.revokeObjectURL(u);
      })
      .catch(() => {});
    return () => {
      active = false;
      urls.forEach(URL.revokeObjectURL);
    };
  }, [giftId, renderId, renderStatus]);
  async function action(fn: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
    const queued = queuedRecording.current;
    if (queued) {
      queuedRecording.current = null;
      await action(() => acceptRecording(queued));
    }
  }
  /** Decode → canonical WAV (mono 22.05 kHz, ≤20 s) → private upload. */
  async function acceptRecording(blob: Blob) {
    // ST2-U-12: лимит размера ДО чтения и декодирования всего файла.
    const tooBig = preambleFileError(blob);
    if (tooBig) throw new StoryClientError(tooBig);
    const decode = browserAudioDecoder();
    if (!decode)
      throw new StoryClientError(
        'Браузер не умеет декодировать звук — обновите Telegram или откройте раздел в другом браузере.'
      );
    let decoded: DecodedAudioLike;
    try {
      decoded = await decode(await blob.arrayBuffer());
    } catch {
      throw new StoryClientError(
        'Не удалось прочитать звук. Выберите аудиофайл MP3, M4A, WAV или OGG либо запишите вступление ещё раз.'
      );
    }
    const prepared = storyPreambleWav(decoded);
    if (prepared.tooShort)
      throw new StoryClientError('Запись короче секунды — запишите ещё раз');
    setRecPreview(
      URL.createObjectURL(new Blob([prepared.wav], { type: 'audio/wav' }))
    );
    const res = await api.post<Recording>(
      `/story-gifts/${giftId}/video/recording`,
      {
        base64: arrayBufferToBase64(prepared.wav),
        consentVersion: view!.recordingConsentVersion,
        consentAccepted: recConsent,
      },
      { timeout: 60000 }
    );
    if (res.data) setRecordingId(res.data.id);
    // S3‑2: длинный файл обрезается до лимита — говорим об этом явно.
    if (prepared.trimmed)
      setNotice(
        `Запись длиннее ${STORY_PREAMBLE_MAX_SEC} с: сохранены только первые ${STORY_PREAMBLE_MAX_SEC} с. Прослушайте её перед сборкой.`
      );
  }
  function stopRecording() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setRecording(false);
    recorder.current?.stop();
  }
  async function startRecording() {
    setError('');
    setNotice('');
    micBusy.current?.();
    const release = acquireMicBusy();
    micBusy.current = release;
    try {
      if (
        !storyMicSupported({
          mediaDevices:
            typeof navigator === 'undefined' ? null : navigator.mediaDevices,
          MediaRecorder:
            typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
        })
      )
        throw Object.assign(new Error('unsupported'), {
          name: MIC_UNSUPPORTED,
        });
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = s;
      const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
      const rec = mime
        ? new MediaRecorder(s, { mimeType: mime })
        : new MediaRecorder(s);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      rec.onstop = () => {
        s.getTracks().forEach((t) => t.stop());
        stream.current = null;
        release();
        if (micBusy.current === release) micBusy.current = null;
        const blob = new Blob(chunks, { type: rec.mimeType || mime || '' });
        // Идёт другое действие — запись не теряется, а ждёт своей очереди.
        if (lock.current) {
          queuedRecording.current = blob;
          setNotice(
            'Запись сохранена и отправится сразу после текущего действия.'
          );
        } else void action(() => acceptRecording(blob));
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
      setRecSeconds(0);
      timer.current = window.setInterval(
        () => setRecSeconds((n) => n + 1),
        1000
      );
    } catch (e) {
      releaseMicrophone(recorder.current, stream.current);
      release();
      setError(storyMicErrorText(e));
    }
  }
  // Auto-stop at the server limit (outside the state updater: no side effects there).
  useEffect(() => {
    if (recording && recSeconds >= STORY_PREAMBLE_MAX_SEC) stopRecording();
  });
  if (!view?.supported) return null;
  const recordedReady = source !== 'recorded' || !!recordingId;
  const gate = storyBuildGate(quote, !!profileId);
  const spokenIntro =
    source === 'synth' ? applyPronunciations(intro, pronCheck.list) : intro;
  return (
    <section
      className="space-y-4 rounded-xl border border-silver-500/30 p-4"
      aria-label="Базовое видео и персональные сегменты"
    >
      <h3 className="text-xl font-semibold">
        Видео «Репки» · персональные сегменты
      </h3>
      <p>
        Один неизменный видеоряд без речи. Голос и персональные части —
        отдельные сегменты: вступление, реплика о подарке, сказка и
        необязательное завершение. Уже озвученные сегменты переиспользуются без
        новой оплаты; Nova остаётся по умолчанию.
      </p>
      <p className="text-sm">
        Бюджет выпуска: ${view.budgetUsd.toFixed(2)} · общий расчётный резерв: $
        {view.reservedUsd.toFixed(2)}. Точную смету показывает «Предпросмотр и
        смета» — это оценка, не счёт провайдера; при нехватке лимита запуск
        блокируется.
      </p>
      <label className="block">
        Голос рассказчика
        <select
          className="mt-1 w-full rounded-lg border border-silver-500/30 bg-transparent p-2"
          value={profileId}
          disabled={busy}
          onChange={(e) => {
            setProfileId(e.target.value);
            setVoiceConsent(false);
            setNarratorImage(false);
          }}
        >
          <option value="">Nova · по умолчанию</option>
          {view.narratorProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} · {p.voiceLabel}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm">
        В списке — только ваши профили с готовым пользовательским клоном
        Resemble и сохранённым согласием. Голос выбирается в брендбуке;
        библиотечный голос не считается голосом родителя.{' '}
        <a className="underline" href="#/brand-manifests">
          Открыть брендбуки
        </a>
      </p>
      {profileId && (
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={voiceConsent}
            disabled={busy}
            onChange={(e) => setVoiceConsent(e.target.checked)}
          />
          {view.voiceConsentText}
        </label>
      )}
      {profileId && (
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={narratorImage}
            disabled={busy}
            onChange={(e) => setNarratorImage(e.target.checked)}
          />
          Показать во вступлении образ рассказчика из этого профиля вместо
          обложки (применённый вариант или оригинальное фото/скетч). Если
          согласие на образ отозвано или вариант устарел, сборка не начнётся —
          обложка молча не подставляется.
        </label>
      )}
      <fieldset className="space-y-2">
        <legend>Вступление</legend>
        <label className="mr-4">
          <input
            type="radio"
            name="story-preamble-source"
            checked={source === 'synth'}
            disabled={busy || recording}
            onChange={() => setSource('synth')}
          />{' '}
          Озвучить выбранным голосом
        </label>
        <label>
          <input
            type="radio"
            name="story-preamble-source"
            checked={source === 'recorded'}
            disabled={busy || recording}
            onChange={() => setSource('recorded')}
          />{' '}
          Моя запись (без клонирования)
        </label>
        {view.preambleSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-2 text-sm">
            {view.preambleSuggestions.map((line) => (
              <Button
                key={line}
                variant="ghost"
                disabled={busy}
                onClick={() => setIntro(line)}
              >
                {line}
              </Button>
            ))}
          </div>
        )}
        <label className="block">
          {source === 'recorded'
            ? 'Точный текст, который вы произносите (для субтитров и проверки речи)'
            : 'Текст вступления'}
          <textarea
            className="mt-1 w-full rounded-lg border border-silver-500/30 bg-transparent p-2"
            maxLength={180}
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
          />
        </label>
        {source === 'recorded' && (
          <div className="space-y-2">
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={recConsent}
                disabled={busy || recording}
                onChange={(e) => setRecConsent(e.target.checked)}
              />
              {view.recordingConsentText}
            </label>
            <div className="flex flex-wrap items-center gap-3">
              {recording ? (
                <Button onClick={stopRecording}>
                  Стоп · {recSeconds} / {STORY_PREAMBLE_MAX_SEC} с
                </Button>
              ) : (
                <Button
                  disabled={busy || !recConsent}
                  onClick={() => void startRecording()}
                >
                  Записать вступление (1–{STORY_PREAMBLE_MAX_SEC} с)
                </Button>
              )}
              <label className="cursor-pointer rounded text-sm underline focus-within:outline-none focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2">
                или выбрать аудиофайл
                <input
                  className="sr-only"
                  type="file"
                  accept="audio/*"
                  disabled={busy || recording || !recConsent}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void action(() => acceptRecording(file));
                  }}
                />
              </label>
            </div>
            {recPreview && (
              <audio
                controls
                src={recPreview}
                onPlay={exclusiveStoryPlayback}
                className="w-full"
              />
            )}
            {view.recordings.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-sm">
                <label>
                  <input
                    type="radio"
                    name="story-recording"
                    checked={recordingId === r.id}
                    onChange={() => setRecordingId(r.id)}
                  />{' '}
                  Запись {r.seconds.toFixed(1)} с ·{' '}
                  {new Date(r.createdAt).toLocaleString()}
                </label>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    confirm.ask(
                      deleteRecordingConfirm(r),
                      () =>
                        void action(async () => {
                          const res =
                            await api.deleteWithBody<RecordingDeleted>(
                              `/story-gifts/${giftId}/video/recording/${r.id}`
                            );
                          if (recordingId === r.id) setRecordingId(null);
                          setNotice(recordingDeletedNotice(res.data));
                        })
                    )
                  }
                >
                  Удалить
                </Button>
              </div>
            ))}
            <p className="text-xs">
              Запись хранится только в этом подарке. После её удаления видео с
              ней станут недоступны; оплаченная основная речь сохранится.
            </p>
          </div>
        )}
      </fieldset>
      {view.giftNote && (
        <p className="text-sm">
          Реплика о подарке (
          {view.giftNote.position === 'beginning' ? 'в начале' : 'в конце'}): «
          {view.giftNote.text}».{' '}
          {profileId
            ? `С голосом из профиля она звучит отдельным сегментом${view.hasGiftPhoto ? ', на экране — фото подарка' : ''}.`
            : 'С Nova она уже звучит внутри проверенной записи сказки.'}
        </p>
      )}
      <label className="block">
        Завершение (необязательно)
        <textarea
          className="mt-1 w-full rounded-lg border border-silver-500/30 bg-transparent p-2"
          maxLength={180}
          value={outro}
          onChange={(e) => setOutro(e.target.value)}
        />
      </label>
      <details>
        <summary>Произношение имён (только для синтеза)</summary>
        <p className="text-sm">
          Подсказка голосу, как произнести слово: одно слово, близкое к
          написанному (ударение — «+» перед гласной), до{' '}
          {STORY_PRONUNCIATION_CHARS} символов, без пробелов. Субтитры и
          проверка речи используют написание. Основная запись Nova не
          пересинтезируется.
        </p>
        {profileId && classicText && (
          <p role="note" className="text-sm">
            Голос из профиля читает классическую редакцию точно по изданию: к
            тексту сказки произношения не применяются — только к вступлению,
            реплике о подарке и завершению. Пары со словами из самой сказки
            сервер отклонит.
          </p>
        )}
        {pron.map((row, i) => (
          <div key={i} className="mt-2 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-silver-500/30 bg-transparent p-2"
              aria-label={`Слово ${i + 1}: как написано`}
              placeholder="Как написано"
              maxLength={40}
              value={row.written}
              onChange={(e) =>
                setPron(
                  pron.map((p, j) =>
                    j === i ? { ...p, written: e.target.value } : p
                  )
                )
              }
            />
            <input
              className="min-w-0 flex-1 rounded-lg border border-silver-500/30 bg-transparent p-2"
              aria-label={`Слово ${i + 1}: как произнести`}
              placeholder="Как произнести"
              maxLength={40}
              value={row.spoken}
              onChange={(e) =>
                setPron(
                  pron.map((p, j) =>
                    j === i ? { ...p, spoken: e.target.value } : p
                  )
                )
              }
            />
            <Button
              variant="ghost"
              aria-label={`Убрать слово ${i + 1}`}
              onClick={() => setPron(pron.filter((_, j) => j !== i))}
            >
              ×
            </Button>
          </div>
        ))}
        {pron.length < STORY_PRONUNCIATION_MAX && (
          <Button
            variant="ghost"
            onClick={() => setPron([...pron, { written: '', spoken: '' }])}
          >
            Добавить слово
          </Button>
        )}
        {pronCheck.error && <p role="alert">{pronCheck.error}</p>}
        {spokenIntro !== intro && (
          <p className="text-sm">Голос услышит: «{spokenIntro}»</p>
        )}
      </details>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="ghost"
          disabled={
            busy ||
            recording ||
            !intro.trim() ||
            !!pronCheck.error ||
            !recordedReady
          }
          onClick={() =>
            void action(async () => {
              const key = bodyKey;
              const r = await api.post<StoryVideoQuote>(
                `/story-gifts/${giftId}/video/quote`,
                body
              );
              if (r.data) setQuoted({ key, quote: r.data });
            })
          }
        >
          Предпросмотр сегментов и смета
        </Button>
        <Button
          disabled={
            busy ||
            recording ||
            !intro.trim() ||
            !!pronCheck.error ||
            !recordedReady ||
            (!!profileId && !voiceConsent) ||
            !gate.ok
          }
          aria-describedby={gate.reason ? 'story-build-reason' : undefined}
          onClick={() =>
            void action(async () => {
              const r = await api.post<Render>(
                `/story-gifts/${giftId}/video`,
                body,
                { timeout: 240000 }
              );
              if (r.data) setSelected(r.data.id);
              setQuoted(null);
            })
          }
        >
          {gate.label}
        </Button>
      </div>
      {gate.reason && (
        <p id="story-build-reason" className="text-sm">
          {gate.reason}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {quote && (
        <div className="space-y-2 rounded-lg border border-silver-500/30 p-3 text-sm">
          <p>{storyQuoteSummary(quote)}</p>
          {typeof quote.qaEstimateMicroUsd === 'number' && (
            <p>
              Проверка речи готового видео (Soniox) — отдельной кнопкой после
              сборки, оценка ≈ {formatUsd(quote.qaEstimateMicroUsd)}; входит в
              резерв сборки.
            </p>
          )}
          <ol className="list-decimal space-y-1 pl-5">
            {storyQuoteRows(quote).map((row, i) => (
              <li key={i}>
                <b>{row.label}</b> · {row.source} · {row.state}
                {row.seconds ? ` · ${row.seconds.toFixed(1)} с` : ''}
                <div className="opacity-80">«{row.text}»</div>
                {row.spoken && (
                  <div className="opacity-80">
                    Голос услышит: «{row.spoken}»
                  </div>
                )}
                {row.note && <div className="opacity-80">{row.note}</div>}
              </li>
            ))}
          </ol>
          {quote.blockers.map((b) => (
            <p key={b} role="alert">
              {b}
            </p>
          ))}
          {(quote.warnings ?? []).map((w) => (
            <p key={w} role="alert">
              {w}
            </p>
          ))}
          {quote.hints.map((h) => (
            <p key={h.code}>{h.message}</p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-sm">
        <a
          className="underline"
          href={view.baseUrl}
          download="repka-base-silent.mp4"
          target="_blank"
          rel="noopener noreferrer"
        >
          Базовый MP4 без звука
        </a>
        <a
          className="underline"
          href={`/story-assets/${view.base.revision}/manifest.json`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Манифест сцен
        </a>
      </div>
      <details>
        <summary>Неизменная версия базового видео</summary>
        <p className="break-all text-xs">
          {view.base.revision} · SHA-256 {view.base.baseSha256}
        </p>
      </details>
      {error && <p role="alert">{error}</p>}
      {view.renders.map((r) => (
        <Button
          key={r.id}
          variant="ghost"
          disabled={busy}
          onClick={() => setSelected(r.id)}
        >
          {r.preambleText} · {r.voiceLabel || 'Nova'} ·{' '}
          {renderStatusLabel(r.status)}
        </Button>
      ))}
      {render && (
        <div className="space-y-3">
          <p>
            Сборка: {renderStatusLabel(render.status)}
            {render.durationSeconds
              ? ` · ${render.durationSeconds.toFixed(2)} с`
              : ''}
          </p>
          {render.segments && (
            <p className="text-sm">
              Сегменты:{' '}
              {render.segments.segments
                .map(
                  (s) =>
                    `${SEGMENT_NAME[s.kind]}${s.source === 'recorded' ? ' (ваша запись)' : ''}${s.seconds ? ` ${s.seconds.toFixed(1)} с` : ''}`
                )
                .join(' → ')}
            </p>
          )}
          {render.error && <p role="alert">{render.error}</p>}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void action(() =>
                api.get(`/story-gifts/${giftId}/video/${render.id}`)
              )
            }
          >
            Обновить сборку видео
          </Button>
          {video && (
            <>
              <video
                onPlay={exclusiveStoryPlayback}
                className="w-full rounded-lg"
                controls
                playsInline
                src={video}
                poster={view.coverUrl}
              >
                {subtitles && (
                  <track
                    kind="subtitles"
                    srcLang="ru"
                    label="Субтитры"
                    src={subtitles}
                    default
                  />
                )}
              </video>
              <div className="flex flex-wrap gap-3">
                <a href={video} download="repka.mp4" className="underline">
                  Скачать готовый MP4
                </a>
                {introAudio && (
                  <a
                    href={introAudio}
                    download={`repka-preamble.${render.segments?.segments[0]?.source === 'recorded' ? 'wav' : 'mp3'}`}
                    className="underline"
                  >
                    Вступление отдельно
                  </a>
                )}
                {subtitles && (
                  <a
                    href={subtitles}
                    download="repka.vtt"
                    className="underline"
                  >
                    Субтитры (WebVTT)
                  </a>
                )}
              </div>
              {mainAudio && (
                <a
                  href={mainAudio}
                  download="repka-main.mp3"
                  className="underline"
                >
                  Основная речь этой версии отдельно (MP3)
                </a>
              )}
              <p className="text-sm">
                Голос этой версии: {render.voiceLabel || 'Nova'}. Музыка и
                эффекты — отдельные дорожки манифеста; сейчас не добавлялись и
                не смешаны с голосом. Субтитры построены по тексту сегментов с
                пропорциональным временем.
              </p>
            </>
          )}
          <p>
            Сверка полного видео с текстом:{' '}
            {
              (
                {
                  PENDING: 'не запускалась',
                  RUNNING: 'проверяется',
                  PASS: 'пройдена',
                  WARN: 'нужен просмотр',
                  UNKNOWN: 'не подтверждена',
                } as Record<string, string>
              )[render.qaStatus]
            }
            {render.qa
              ? ` · расхождение слов ${(render.qa.wer * 100).toFixed(1)}%`
              : ''}
          </p>
          <Button
            disabled={
              busy || render.status !== 'READY' || render.qaStatus !== 'PENDING'
            }
            onClick={() => {
              const target = render;
              confirm.ask(
                videoQaConfirm(target),
                () =>
                  void action(() =>
                    api.post(
                      `/story-gifts/${giftId}/video/${target.id}/quality`,
                      {},
                      { timeout: 150000 }
                    )
                  )
              );
            }}
          >
            Проверить речь готового видео
            {includedInReserve(render.reservedMicroUsd)}
          </Button>
          <p>
            Видео доступно только владельцу. Публикация отключена на этапе
            разработки.
          </p>
          <details>
            <summary>Независимые активы этого выпуска</summary>
            <p className="break-all text-xs">
              Базовый видеоряд: {render.baseHash}
            </p>
            <p className="break-all text-xs">
              Основная аудиодорожка: {render.mainAudioHash}
            </p>
            <p>Вступление: {render.preambleText}</p>
          </details>
        </div>
      )}
      {confirm.dialog}
    </section>
  );
}
