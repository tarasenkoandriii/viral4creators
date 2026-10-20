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
  liveExistingRender,
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
  qaConfirmMember,
  recordingDeletedNotice,
  type RecordingDeleted,
  videoQaConfirm,
} from './story-confirm';
import { formatUsd } from './story-wizard';
import { useStoryConfirm } from './StoryConfirm';
import { useI18n } from '../../lib/i18n-context';
import { useStoryAccess } from './story-access-context';
import {
  fill,
  storyAccessCode,
  storyBlockerText,
  storyChargeConfirm,
  storyChargeNeedsConfirm,
  storyChargeOf,
  storyCode,
  storyCreditsRequired,
  storyPriceChanged,
  storyPromiseText,
  storyServerText,
  storyAcceptLanguage,
} from './story-pilot';
import { INTL_LOCALE } from '../../lib/intl-locale';
import { StoryChargeLine, StoryCreditsNotice } from './StoryPilotParts';
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
const SEGMENT_NAME_KEY = {
  intro: 'segNameIntro',
  gift_note: 'segNameGiftNote',
  main: 'segNameMain',
  outro: 'segNameOutro',
} as const;
function media(base64: string, mime: string) {
  return URL.createObjectURL(
    new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
      type: mime,
    })
  );
}
/** WebVTT comes without the JSON envelope: a plain authorized fetch. */
async function fetchSubtitles(path: string, locale: string) {
  const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';
  const res = await fetch(`${base}${path}`, {
    headers: {
      ...getAuthHeaders(),
      'Accept-Language': storyAcceptLanguage(locale),
    },
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
  owner = true,
  readOnly = false,
  publicNote,
}: {
  giftId: string;
  /** Текст сказки — классическая редакция (читается точно по изданию). */
  classicText?: boolean;
  /** ST3-U-03/U-07: суммы провайдеров и образ рассказчика — только владельцу. */
  owner?: boolean;
  /** ST3-U-01: доступ отозван — готовые версии можно смотреть и скачать. */
  readOnly?: boolean;
  /** ST3-U-02: что происходит с видео при публикации (по режиму и ссылке). */
  publicNote?: string;
}) {
  const { dict, locale } = useI18n();
  const u = dict.storyUi;
  const v = u.video;
  const ps = { plan: u.plan, render: u.render };
  const errorText = (e: unknown) => storyErrorText(e, { locale, ui: u });
  const errorTextRef = useRef(errorText);
  errorTextRef.current = errorText;
  /** Язык для субтитров без перезагрузки медиа при смене языка. */
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [view, setView] = useState<View | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    // Текст вступления звучит на языке сказки, а не интерфейса: русский
    // пример — только в ru-интерфейсе; иначе — первая подсказка сервера
    // (на языке сказки), см. эффект ниже.
    [intro, setIntro] = useState(
      locale === 'ru'
        ? 'Сегодня я расскажу тебе сказку «Репка». Давай послушаем её вместе.'
        : ''
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
  const t = dict.storyTales;
  const storyAccess = useStoryAccess();
  /** 402 `STORY_CREDITS_REQUIRED` запуска сборки (бриф ST3, п. 2). */
  const [credits, setCredits] = useState<{
    required: number | null;
    balance: number | null;
  } | null>(null);
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
    const next = res.data;
    if (next) {
      setView(next);
      setIntro((cur) => cur || next.preambleSuggestions[0] || '');
    }
    // Тексты согласий сервер отдаёт на языке запроса: смена языка
    // интерфейса перечитывает панель.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [giftId, locale]);
  const renderId = render?.id;
  const renderStatus = render?.status;
  const pronCheck = cleanPronunciations(pron, ps);
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
    void refresh().catch((e) => setError(errorTextRef.current(e)));
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
        if (active) setError(errorTextRef.current(e));
      });
    void fetchSubtitles(
      `/story-gifts/${giftId}/video/${renderId}/subtitles.vtt`,
      localeRef.current
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
    setCredits(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      const need = storyCreditsRequired(e);
      if (need) setCredits(need);
      else {
        if (storyAccessCode(e)) storyAccess.refresh();
        setError(storyPromiseText(storyCode(e), errorText(e), t));
      }
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
    const tooBig = preambleFileError(blob, ps);
    if (tooBig) throw new StoryClientError(tooBig);
    const decode = browserAudioDecoder();
    if (!decode) throw new StoryClientError(u.errors.decodeUnsupported);
    let decoded: DecodedAudioLike;
    try {
      decoded = await decode(await blob.arrayBuffer());
    } catch {
      throw new StoryClientError(u.errors.decodeFailed);
    }
    const prepared = storyPreambleWav(decoded);
    if (prepared.tooShort) throw new StoryClientError(u.errors.tooShort);
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
      setNotice(fill(v.trimmed, { max: STORY_PREAMBLE_MAX_SEC }));
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
          setNotice(v.queued);
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
      setError(storyMicErrorText(e, u));
    }
  }
  // Auto-stop at the server limit (outside the state updater: no side effects there).
  useEffect(() => {
    if (recording && recSeconds >= STORY_PREAMBLE_MAX_SEC) stopRecording();
  });
  if (!view?.supported) return null;
  const recordedReady = source !== 'recorded' || !!recordingId;
  const gate = storyBuildGate(quote, !!profileId, ps, !owner);
  const charge = storyChargeOf(quote);
  /**
   * ST3-U-04: сервер сверяет показанную цену (`expectedCredits`). При 409
   * `STORY_PRICE_CHANGED` смета получает новую цену, и подтверждение
   * открывается заново.
   */
  const build = (shown: StoryVideoQuote | null = quote) =>
    void action(async () => {
      const expected = storyChargeOf(shown)?.credits ?? 0;
      try {
        const r = await api.post<Render>(
          `/story-gifts/${giftId}/video`,
          { ...body, expectedCredits: expected },
          { timeout: 240000 }
        );
        if (r.data) setSelected(r.data.id);
        setQuoted(null);
      } catch (e) {
        const changed = storyPriceChanged(e);
        if (!changed || !shown) throw e;
        const key = bodyKey;
        const fresh =
          (
            await api.post<StoryVideoQuote>(
              `/story-gifts/${giftId}/video/quote`,
              body
            )
          ).data ?? shown;
        const next = changed.charge
          ? { ...fresh, charge: changed.charge }
          : fresh;
        setQuoted({ key, quote: next });
        setError(u.codes.STORY_PRICE_CHANGED);
        const nextCharge = storyChargeOf(next);
        if (nextCharge && storyChargeNeedsConfirm(nextCharge))
          setTimeout(
            () =>
              confirm.ask(storyChargeConfirm(nextCharge, t, locale), () =>
                build(next)
              ),
            0
          );
      }
    });
  const spokenIntro =
    source === 'synth' ? applyPronunciations(intro, pronCheck.list) : intro;
  return (
    <section
      className="space-y-4 rounded-xl border border-silver-500/30 p-4"
      aria-label={v.aria}
    >
      <h3 className="text-xl font-semibold">{v.title}</h3>
      {!readOnly && <p>{v.intro}</p>}
      {owner && !readOnly && (
        <p className="text-sm">
          {fill(v.budget, {
            budget: `$${view.budgetUsd.toFixed(2)}`,
            reserve: `$${view.reservedUsd.toFixed(2)}`,
          })}
        </p>
      )}
      {!readOnly && (
        <>
          <label className="block">
            {v.voice}
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
              <option value="">{v.novaDefault}</option>
              {view.narratorProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · {p.voiceLabel}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm">
            {v.voiceNote}{' '}
            <a className="underline" href="#/brand-manifests">
              {v.openBrand}
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
          {/* ST3-U-07: образы рассказчика в пилоте — только у владельца. */}
          {owner && profileId && (
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={narratorImage}
                disabled={busy}
                onChange={(e) => setNarratorImage(e.target.checked)}
              />
              {v.narratorImage}
            </label>
          )}
          <fieldset className="space-y-2">
            <legend>{v.preamble}</legend>
            <label className="mr-4">
              <input
                type="radio"
                name="story-preamble-source"
                checked={source === 'synth'}
                disabled={busy || recording}
                onChange={() => setSource('synth')}
              />{' '}
              {v.synth}
            </label>
            <label>
              <input
                type="radio"
                name="story-preamble-source"
                checked={source === 'recorded'}
                disabled={busy || recording}
                onChange={() => setSource('recorded')}
              />{' '}
              {v.recorded}
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
              {source === 'recorded' ? v.recordedText : v.introText}
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
                      {fill(v.stop, {
                        n: recSeconds,
                        max: STORY_PREAMBLE_MAX_SEC,
                      })}
                    </Button>
                  ) : (
                    <Button
                      disabled={busy || !recConsent}
                      onClick={() => void startRecording()}
                    >
                      {fill(v.record, { max: STORY_PREAMBLE_MAX_SEC })}
                    </Button>
                  )}
                  <label className="cursor-pointer rounded text-sm underline focus-within:outline-none focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2">
                    {v.pickFile}
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
                      {fill(v.recordingItem, {
                        n: r.seconds.toFixed(1),
                        date: new Date(r.createdAt).toLocaleString(
                          INTL_LOCALE[locale] ?? 'ru-RU'
                        ),
                      })}
                    </label>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        confirm.ask(
                          deleteRecordingConfirm(r, u.confirm),
                          () =>
                            void action(async () => {
                              const res =
                                await api.deleteWithBody<RecordingDeleted>(
                                  `/story-gifts/${giftId}/video/recording/${r.id}`
                                );
                              if (recordingId === r.id) setRecordingId(null);
                              setNotice(
                                recordingDeletedNotice(res.data, u.confirm)
                              );
                            })
                        )
                      }
                    >
                      {v.delete}
                    </Button>
                  </div>
                ))}
                <p className="text-xs">{v.recordingKept}</p>
              </div>
            )}
          </fieldset>
          {view.giftNote && (
            <p className="text-sm">
              {fill(v.giftNote, {
                position:
                  view.giftNote.position === 'beginning'
                    ? u.wizard.atBeginning
                    : u.wizard.atEnd,
                text: view.giftNote.text,
              })}{' '}
              {profileId
                ? view.hasGiftPhoto
                  ? v.giftNoteProfilePhoto
                  : v.giftNoteProfile
                : v.giftNoteNova}
            </p>
          )}
          <label className="block">
            {v.outro}
            <textarea
              className="mt-1 w-full rounded-lg border border-silver-500/30 bg-transparent p-2"
              maxLength={180}
              value={outro}
              onChange={(e) => setOutro(e.target.value)}
            />
          </label>
          <details>
            <summary>{v.pronSummary}</summary>
            <p className="text-sm">
              {fill(v.pronHelp, { max: STORY_PRONUNCIATION_CHARS })}
            </p>
            {profileId && classicText && (
              <p role="note" className="text-sm">
                {v.pronClassic}
              </p>
            )}
            {pron.map((row, i) => (
              <div key={i} className="mt-2 flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-lg border border-silver-500/30 bg-transparent p-2"
                  aria-label={fill(v.wordWritten, { n: i + 1 })}
                  placeholder={v.written}
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
                  aria-label={fill(v.wordSpoken, { n: i + 1 })}
                  placeholder={v.spoken}
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
                  aria-label={fill(v.removeWord, { n: i + 1 })}
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
                {v.addWord}
              </Button>
            )}
            {pronCheck.error && <p role="alert">{pronCheck.error}</p>}
            {spokenIntro !== intro && (
              <p className="text-sm">
                {fill(v.voiceHears, { text: spokenIntro })}
              </p>
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
              {owner ? v.quoteButton : v.quoteButtonMember}
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
                // Платный запуск (кредиты или первая бесплатная) — только после
                // подтверждения с ценой; уже собранная версия открывается сразу.
                quote &&
                !liveExistingRender(quote) &&
                storyChargeNeedsConfirm(charge)
                  ? confirm.ask(storyChargeConfirm(charge!, t, locale), () =>
                      build()
                    )
                  : build()
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
              <p>{storyQuoteSummary(quote, ps, !owner)}</p>
              {owner && typeof quote.qaEstimateMicroUsd === 'number' && (
                <p>
                  {fill(v.qaEstimate, {
                    usd: formatUsd(quote.qaEstimateMicroUsd),
                  })}
                </p>
              )}
              <ol className="list-decimal space-y-1 pl-5">
                {storyQuoteRows(quote, ps).map((row, i) => (
                  <li key={i}>
                    <b>{row.label}</b> · {row.source} · {row.state}
                    {row.seconds
                      ? ` · ${fill(v.secondsShort, { n: row.seconds.toFixed(1) })}`
                      : ''}
                    <div className="opacity-80">«{row.text}»</div>
                    {row.spoken && (
                      <div className="opacity-80">
                        {fill(v.voiceHears, { text: row.spoken })}
                      </div>
                    )}
                    {row.note && <div className="opacity-80">{row.note}</div>}
                  </li>
                ))}
              </ol>
              {quote.blockers.map((b) => (
                <p key={b} role="alert">
                  {storyBlockerText(b, u, locale)}
                </p>
              ))}
              {(quote.warnings ?? []).map((w) => (
                <p key={w} role="alert">
                  {storyBlockerText(w, u, locale)}
                </p>
              ))}
              {quote.hints.map((h) => (
                <p key={h.code}>{storyPromiseText(h.code, h.message, t)}</p>
              ))}
              {!liveExistingRender(quote) && (
                <StoryChargeLine charge={charge} />
              )}
            </div>
          )}
        </>
      )}
      {owner && (
        <div className="flex flex-wrap gap-3 text-sm">
          <a
            className="underline"
            href={view.baseUrl}
            download="repka-base-silent.mp4"
            target="_blank"
            rel="noopener noreferrer"
          >
            {v.baseMp4}
          </a>
          <a
            className="underline"
            href={`/story-assets/${view.base.revision}/manifest.json`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {v.manifest}
          </a>
        </div>
      )}
      {owner && (
        <details>
          <summary>{v.baseVersion}</summary>
          <p className="break-all text-xs">
            {view.base.revision} · SHA-256 {view.base.baseSha256}
          </p>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      <StoryCreditsNotice info={credits} />
      {view.renders.map((r) => (
        <Button
          key={r.id}
          variant="ghost"
          disabled={busy}
          onClick={() => setSelected(r.id)}
        >
          {r.preambleText} · {r.voiceLabel || 'Nova'} ·{' '}
          {renderStatusLabel(r.status, ps)}
        </Button>
      ))}
      {render && (
        <div className="space-y-3">
          <p>
            {fill(v.renderLine, {
              status: renderStatusLabel(render.status, ps),
            })}
            {render.durationSeconds
              ? ` · ${fill(v.secondsShort, { n: render.durationSeconds.toFixed(2) })}`
              : ''}
          </p>
          {render.segments && (
            <p className="text-sm">
              {fill(v.segments, {
                list: render.segments.segments
                  .map(
                    (s) =>
                      `${v[SEGMENT_NAME_KEY[s.kind]] ?? s.kind}${s.source === 'recorded' ? v.yourRecording : ''}${s.seconds ? ` ${fill(v.secondsShort, { n: s.seconds.toFixed(1) })}` : ''}`
                  )
                  .join(' → '),
              })}
            </p>
          )}
          {render.error && (
            <p role="alert">
              {storyServerText(render.error, locale, u.errors.buildFailed)}
            </p>
          )}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void action(() =>
                api.get(`/story-gifts/${giftId}/video/${render.id}`)
              )
            }
          >
            {v.refresh}
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
                    label={v.subtitles}
                    src={subtitles}
                    default
                  />
                )}
              </video>
              <div className="flex flex-wrap gap-3">
                <a href={video} download="repka.mp4" className="underline">
                  {v.downloadMp4}
                </a>
                {introAudio && (
                  <a
                    href={introAudio}
                    download={`repka-preamble.${render.segments?.segments[0]?.source === 'recorded' ? 'wav' : 'mp3'}`}
                    className="underline"
                  >
                    {v.introSeparate}
                  </a>
                )}
                {subtitles && (
                  <a
                    href={subtitles}
                    download="repka.vtt"
                    className="underline"
                  >
                    {v.vtt}
                  </a>
                )}
              </div>
              {mainAudio && (
                <a
                  href={mainAudio}
                  download="repka-main.mp3"
                  className="underline"
                >
                  {v.mainSeparate}
                </a>
              )}
              <p className="text-sm">
                {fill(v.voiceOfVersion, { voice: render.voiceLabel || 'Nova' })}
              </p>
            </>
          )}
          <p>
            {fill(v.qaLine, {
              status:
                (u.videoQa as Record<string, string>)[render.qaStatus] ?? '',
            })}
            {render.qa
              ? fill(v.werSuffix, { n: (render.qa.wer * 100).toFixed(1) })
              : ''}
          </p>
          {!readOnly && (
            <Button
              disabled={
                busy ||
                render.status !== 'READY' ||
                render.qaStatus !== 'PENDING'
              }
              onClick={() => {
                const target = render;
                confirm.ask(
                  owner
                    ? videoQaConfirm(target, u.confirm)
                    : qaConfirmMember('video', u.confirm),
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
              {v.qaButton}
              {owner
                ? includedInReserve(render.reservedMicroUsd, u.confirm)
                : ''}
            </Button>
          )}
          <p>{publicNote ?? v.ownerOnly}</p>
          {owner && (
            <details>
              <summary>{v.assets}</summary>
              <p className="break-all text-xs">
                {fill(v.baseHash, { hash: render.baseHash })}
              </p>
              <p className="break-all text-xs">
                {fill(v.mainHash, { hash: render.mainAudioHash })}
              </p>
              <p>{fill(v.preambleLine, { text: render.preambleText })}</p>
            </details>
          )}
        </div>
      )}
      {confirm.dialog}
    </section>
  );
}
