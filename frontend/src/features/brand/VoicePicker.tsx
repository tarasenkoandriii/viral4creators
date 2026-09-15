/**
 * Выбор режима озвучки и голоса (§15.1) — общий для манифеста бренда и
 * копии манифеста в сессии (этап 52, В-1.6: ТЗ обещало правку режима «для
 * одного ролика там же, где стиль», сервер это принимал, а контролов в
 * редакторе копии не было).
 *
 * Этап 73 (TODO п.32) добавил «Мои клонированные голоса» — self-service
 * клонирование голоса через Resemble AI прямо здесь, рядом с выбором
 * голоса: клон нужен ровно затем, чтобы его тут же выбрать.
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Trash2, Volume2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  LockedNote,
  Select,
} from '../../components/ui';
import {
  cloneUserVoice,
  deleteUserVoice,
  errorMessage,
  getVoices,
  listUserVoices,
  previewVoice,
  uploadVoiceSample,
  type VoiceCatalogue,
} from '../../services/projects-api';
import { useI18n } from '../../lib/i18n-context';
import { useFeature } from '../../lib/plan-context';
import { haptic } from '../../lib/telegram';
import type { UserVoice } from '../../types';

/**
 * Выбор голоса из каталога провайдера. Каталог не копируется в базу: он
 * живёт у провайдера и меняется без нас, а копия устареет в первый же
 * день — хранится только идентификатор выбранного голоса.
 *
 * Ненастроенный синтез здесь не ошибка, а состояние стенда, и сказано об
 * этом спокойно: ролик всё равно получится, просто со звуком модели.
 */
export function VoicePicker({
  value,
  onChange,
  disabled,
  voiceProvider,
  sessionId,
  providerOverride,
  onProviderOverrideChange,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /**
   * Провайдер, сохранённый на текущем голосе бренда
   * (`BrandManifestView.ttsProvider`, doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md
   * §4.2). Сверяется с активным провайдером стенда (из ответа
   * `getVoices()`) — расхождение значит, что `value` — идентификатор
   * от провайдера, который сейчас не активен, и звук не получится.
   */
  voiceProvider?: string | null;
  /**
   * Доп. запрос владельца продукта — нужен для пробы репликами
   * ОРИГИНАЛЬНОГО референсного видео (см.
   * `AnalysisService.extractOriginalDialogueSample()` на бекенде).
   * Только на экране сессии (`BrandSnapshotEditor.tsx`) — у самого
   * бренда (`ManifestScreen.tsx`) нет своего оригинального видео,
   * поэтому там этот проп не передаётся, и кнопка не показывается.
   */
  sessionId?: string;
  /**
   * Этап 91 (доп. запрос владельца продукта — явный выбор провайдера в
   * `RevoicePanel`, «способ переозвучки можно выбрать явно»). Когда
   * задан — каталог (`getVoices`) и проба (`listen`) читаются у ЭТОГО
   * провайдера, в обход платформенного дефолта, тем же приёмом, что уже
   * поддержан бэкендом для `/tts/voices`/`/tts/preview` (см. их
   * доккомментарии). Селектор рисует и держит состояние вызывающий
   * (`RevoicePanel`) — здесь только используется, чтобы не удваивать
   * его в `BrandSnapshotEditor.tsx`/`ManifestScreen.tsx`, которые этот
   * проп не передают (там `undefined` — прежнее поведение без изменений).
   */
  providerOverride?: string | null;
  /** Только для проброса в `MyVoicesSection` — см. её `onPick`. */
  onProviderOverrideChange?: (p: string | null) => void;
}) {
  const { dict } = useI18n();
  const [state, setState] = useState<VoiceCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [sample, setSample] = useState(dict.voicePicker.defaultSample);
  const [audio, setAudio] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewNote, setPreviewNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getVoices(undefined, providerOverride ?? undefined)
      .then((c) => alive && setState(c))
      .catch(() =>
        alive
          ? setState({
              configured: false,
              voices: [],
              // Пусто, не угадываем: сеть отвалилась раньше, чем узнали
              // активный провайдер — пустая строка гарантированно не
              // совпадёт ни с одним реальным ключом, так что предупреждение
              // о рассинхроне ниже корректно промолчит на этой ветке.
              provider: '',
              error: dict.voicePicker.catalogFetchError,
            })
          : null
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerOverride]);

  const chosen = state?.voices.find((v) => v.voiceId === value) ?? null;

  // Проба стоит денег и ограничена числом в сутки, поэтому она по
  // нажатию, а не автоматически при выборе голоса.
  //
  // Доп. запрос владельца продукта: `useOriginal` — проба репликами
  // ОРИГИНАЛЬНОГО референсного видео вместо своего текста в `sample`.
  // НЕ клонирование голоса диктора оригинала — сервер сам достаёт
  // ТЕКСТ его реплик (`AnalysisService.extractOriginalDialogueSample()`)
  // и озвучивает его выбранным кандидат-голосом.
  const listen = async (useOriginal = false) => {
    setPreviewing(true);
    setPreviewNote(null);
    setAudio(null);
    try {
      const r = await previewVoice(
        useOriginal ? null : sample.trim(),
        value || null,
        {
          provider: providerOverride ?? undefined,
          ...(useOriginal && sessionId
            ? { useOriginalDialogue: true, sessionId }
            : {}),
        }
      );
      if (r.ok && r.audio) {
        setAudio(r.audio);
        setPreviewNote(
          dict.voicePicker.previewCount
            .replace('{{used}}', String(r.used))
            .replace('{{limit}}', String(r.limit))
        );
      } else {
        setPreviewNote(r.reason ?? dict.voicePicker.previewFailed);
      }
    } catch (e) {
      setPreviewNote(errorMessage(e));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div>
      <Field
        label={dict.voicePicker.label}
        htmlFor="m-tts-voice"
        hint={
          loading
            ? dict.voicePicker.loadingHint
            : // Подсказка про умолчание уместна ровно тогда, когда голос не
              // выбран: висеть над выбранным голосом ей незачем.
              (state?.error ??
              (value ? undefined : dict.voicePicker.defaultHint))
        }
      >
        <Select
          id="m-tts-voice"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled || loading}
        >
          <option value="">{dict.voicePicker.defaultOption}</option>
          {/* Сохранённый голос мог исчезнуть из каталога — показываем его
              отдельной строкой, иначе выбор молча сбросился бы на
              умолчание, а пользователь узнал бы об этом по звуку. */}
          {value && !chosen && (
            <option value={value}>
              {dict.voicePicker.notInCatalog.replace('{{value}}', value)}
            </option>
          )}
          {state?.voices.map((v) => (
            <option key={v.voiceId} value={v.voiceId}>
              {v.name}
              {v.accent ? ` · ${v.accent}` : ''}
            </option>
          ))}
        </Select>

        {/* doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.2: голос помечен, каким
            провайдером выпущен — расхождение с активным на стенде значит,
            что value — чужой идентификатор, и звук не получится.
            Этап 91: при активном явном `providerOverride` это
            предупреждение — шум, а не сигнал (пользователь СОЗНАТЕЛЬНО
            смотрит каталог другого провайдера, ещё не сохранившись). */}
        {!providerOverride &&
          value &&
          voiceProvider &&
          state?.provider &&
          voiceProvider !== state.provider && (
            <p className="mt-1 text-xs text-amber-500">
              {dict.voicePicker.providerMismatch}
            </p>
          )}

        {/* §15.3: послушать голос ДО генерации. Фраза своя — голос,
            прочитавший чужой текст, о вашем ролике говорит мало. */}
        {state?.configured && (
          <div className="mt-2 space-y-2">
            {/* На 320px поле съёживалось до 134px и обрезало собственный
                placeholder посреди слова (аудит 2026-09-06, А-3.9). Ниже
                basis-40 строка переносится, и кнопка уходит под поле. */}
            <div className="flex flex-wrap gap-2">
              <Input
                id="m-tts-sample"
                aria-label={dict.voicePicker.sampleAriaLabel}
                className="flex-1 basis-40"
                value={sample}
                onChange={(e) => setSample(e.target.value.slice(0, 300))}
                placeholder={dict.voicePicker.samplePlaceholder}
                disabled={disabled || previewing}
              />
              <Button
                variant="outline"
                size="sm"
                className="ml-auto shrink-0"
                onClick={() => listen()}
                loading={previewing}
                disabled={disabled || previewing || !sample.trim()}
              >
                {dict.voicePicker.listenButton}
              </Button>
              {/* Доп. запрос владельца продукта: проба репликами
                  ОРИГИНАЛЬНОГО референсного видео — только на экране
                  сессии (`sessionId` передан), у самого бренда своего
                  оригинала нет. */}
              {sessionId && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => listen(true)}
                  loading={previewing}
                  disabled={disabled || previewing}
                >
                  {dict.voicePicker.listenOriginalButton}
                </Button>
              )}
            </div>
            {audio && (
              <audio className="w-full" controls autoPlay src={audio} />
            )}
            {previewNote && (
              <p className="text-xs text-silver-400">{previewNote}</p>
            )}
          </div>
        )}
      </Field>

      <div className="mt-4">
        <MyVoicesSection
          onPick={(voiceId) => {
            onChange(voiceId);
            // Этап 91: свой клон — всегда Resemble (см. applySnapshotEdit,
            // Е-4.1) — синхронизируем явный выбор провайдера тем же
            // выбором, чтобы каталог/проба/итоговое сохранение не
            // разъехались с только что выбранным голосом.
            onProviderOverrideChange?.('resemble');
          }}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

// ── Мои клонированные голоса (этап 73, TODO п.32) ──────────────────────

const MAX_USER_VOICES = 3; // зеркалит backend/src/modules/user-voices/user-voices.service.ts

function pickRecorderMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const c of candidates) {
    if (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported?.(c)
    )
      return c;
  }
  return 'audio/webm';
}

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function statusTone(
  status: UserVoice['status']
): 'success' | 'warning' | 'neutral' {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'warning';
  return 'neutral';
}

function MyVoicesSection({
  onPick,
  disabled,
}: {
  onPick: (voiceId: string) => void;
  disabled?: boolean;
}) {
  const { dict } = useI18n();
  const t = dict.myVoices;
  const feature = useFeature('voiceCloning');
  const [voices, setVoices] = useState<UserVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Recording / upload form state — сбрасывается при закрытии формы.
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [sampleBlob, setSampleBlob] = useState<{
    blob: Blob;
    mime: string;
  } | null>(null);
  const [sampleObjectUrl, setSampleObjectUrl] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const micSupported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  const activeCount = voices.filter((v) => v.status !== 'failed').length;
  const atLimit = activeCount >= MAX_USER_VOICES;
  const training = voices.some((v) => v.status === 'training');

  const load = () =>
    listUserVoices()
      .then(setVoices)
      .catch(() => undefined);

  useEffect(() => {
    if (!feature.allowed) {
      setVoicesLoading(false);
      return;
    }
    let alive = true;
    setVoicesLoading(true);
    listUserVoices()
      .then((v) => alive && setVoices(v))
      .catch(() => alive && setVoices([]))
      .finally(() => alive && setVoicesLoading(false));
    return () => {
      alive = false;
    };
  }, [feature.allowed]);

  // Пока хоть один голос ещё обучается — периодически перечитываем
  // список: `list()` на бэкенде сам подтягивает статус у Resemble
  // (poll-фоллбек §5.4 TTS-спека, на случай стенда без публичного
  // HTTPS-эндпоинта под вебхук). `setTimeout`-цепочка, не `setInterval`
  // — тот же приём, что у CatalogBatchProgressScreen: медленный ответ не
  // накладывает тики друг на друга.
  useEffect(() => {
    if (!training) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      if (!alive) return;
      void load();
    }, 10000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [training, voices]);

  useEffect(() => () => stopTimer(), []);
  const stopTimer = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  useEffect(
    () => () => {
      if (sampleObjectUrl) URL.revokeObjectURL(sampleObjectUrl);
    },
    [sampleObjectUrl]
  );

  const resetForm = () => {
    setAdding(false);
    setSampleBlob(null);
    if (sampleObjectUrl) URL.revokeObjectURL(sampleObjectUrl);
    setSampleObjectUrl(null);
    setLabel('');
    setConsent(false);
    setError(null);
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecorderMime();
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) =>
        e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunksRef.current, { type: mime });
        if (blob.size === 0) {
          setError(t.emptyRecording);
          return;
        }
        setSampleBlob({ blob, mime });
        setSampleObjectUrl(URL.createObjectURL(blob));
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
      setError(t.micUnavailable.replace('{{error}}', errorMessage(e)));
    }
  };

  const stopRecording = () => {
    stopTimer();
    setRecording(false);
    recorderRef.current?.stop();
    haptic();
  };

  const onFilePicked = (file: File | undefined) => {
    if (!file) return;
    setSampleBlob({ blob: file, mime: file.type || 'audio/mpeg' });
    setSampleObjectUrl(URL.createObjectURL(file));
  };

  const submit = async () => {
    if (!sampleBlob || !label.trim() || !consent) return;
    setSubmitting(true);
    setError(null);
    try {
      const { pathname } = await uploadVoiceSample(
        sampleBlob.blob,
        sampleBlob.mime
      );
      const created = await cloneUserVoice(pathname, label.trim(), consent);
      setVoices((prev) => [created, ...prev]);
      resetForm();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (v: UserVoice) => {
    if (!window.confirm(t.deleteConfirm.replace('{{label}}', v.label))) return;
    setDeletingId(v.id);
    setError(null);
    try {
      await deleteUserVoice(v.id);
      setVoices((prev) => prev.filter((x) => x.id !== v.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeletingId(null);
    }
  };

  if (feature.loading) return null;

  if (!feature.allowed) {
    return (
      <LockedNote title={t.lockedTitle} lock={feature.lock} compact>
        {t.lockedBody}
      </LockedNote>
    );
  }

  return (
    <div className="rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{t.title}</p>
        {!adding && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAdding(true)}
            disabled={disabled || atLimit}
          >
            {t.addButton}
          </Button>
        )}
      </div>

      {atLimit && !adding && (
        <p className="mt-1 text-xs text-silver-400">
          {t.limitReached.replace('{{max}}', String(MAX_USER_VOICES))}
        </p>
      )}

      {error && (
        <Alert tone="error" className="mt-2" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {voicesLoading && !adding && (
        <p className="mt-2 text-xs text-silver-400">{t.loading}</p>
      )}

      {!voicesLoading && voices.length > 0 && (
        <ul className="mt-2 space-y-2">
          {voices.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-silver-200/60 p-2 text-xs dark:border-silver-800"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{v.label}</span>
                  <Badge tone={statusTone(v.status)}>
                    {v.status === 'ready'
                      ? t.statusReady
                      : v.status === 'failed'
                        ? t.statusFailed
                        : t.statusTraining}
                  </Badge>
                </div>
                {v.status === 'failed' && v.error && (
                  <p className="mt-0.5 text-[11px] text-silver-400">
                    {v.error}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {v.status === 'ready' && v.resembleVoiceId && (
                  <Button
                    variant="outline"
                    size="sm"
                    // Шестой аудит, Е-4.1: кнопка когда-то была
                    // разблокирована, но выбор проходил вхолостую — сервер
                    // тегировал клон АКТИВНЫМ на стенде провайдером вместо
                    // настоящего Resemble (см. applySnapshotEdit), и
                    // синтез потом гарантированно проваливался. Блокировка
                    // до нужного активного провайдера была барьером
                    // против ЭТОГО.
                    //
                    // Этап 91 снял первопричину с двух концов: клон
                    // теперь ВСЕГДА тегируется 'resemble' безусловно (то
                    // же Е-4.1, applySnapshotEdit это уже умел), а
                    // `postprod.service.ts` при синтезе зовёт ИМЕННО
                    // тегированный провайдер (`resolveByKey`), а не
                    // сверяет его с активным на стенде. Блокировка кнопки
                    // ничего больше не защищает — держать её означало бы
                    // запрещать рабочий выбор.
                    disabled={disabled}
                    onClick={() => onPick(v.resembleVoiceId!)}
                  >
                    {t.pickButton}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={13} />}
                  aria-label={t.deleteButton}
                  loading={deletingId === v.id}
                  disabled={disabled || deletingId !== null}
                  onClick={() => void remove(v)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="mt-3 space-y-3 border-t border-silver-200/60 pt-3 dark:border-silver-800">
          {!sampleBlob ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {micSupported ? (
                  recording ? (
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<Square size={14} />}
                      onClick={stopRecording}
                    >
                      {t.stopButton} ·{' '}
                      <span className="tabular">{fmtSec(seconds)}</span>
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      icon={<Mic size={14} />}
                      onClick={() => void startRecording()}
                    >
                      {t.recordButton}
                    </Button>
                  )
                ) : (
                  <span className="text-xs text-silver-400">
                    {t.recordingUnsupported}
                  </span>
                )}
                <label className="inline-flex min-h-[44px] cursor-pointer items-center text-xs text-accent">
                  {t.uploadButton}
                  <input
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    disabled={recording}
                    onChange={(e) => onFilePicked(e.target.files?.[0])}
                  />
                </label>
              </div>
              <Button variant="ghost" size="sm" onClick={resetForm}>
                {t.cancelButton}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {sampleObjectUrl && (
                <audio className="w-full" controls src={sampleObjectUrl} />
              )}
              <Field label={t.labelFieldLabel} htmlFor="my-voice-label">
                <Input
                  id="my-voice-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value.slice(0, 80))}
                  placeholder={t.labelPlaceholder}
                  disabled={submitting}
                />
              </Field>
              <label className="flex cursor-pointer gap-2 text-xs leading-relaxed">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  disabled={submitting}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-sky-400"
                />
                <span>{t.consentLabel}</span>
              </label>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  icon={<Volume2 size={14} />}
                  loading={submitting}
                  disabled={!label.trim() || !consent}
                  onClick={() => void submit()}
                >
                  {t.submitButton}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={submitting}
                  onClick={resetForm}
                >
                  {t.cancelButton}
                </Button>
              </div>
              {/* 15.09.2026: кнопка без названия/согласия была просто тусклой —
                  пользователь не понимал, почему «не даёт клонировать». */}
              {(!label.trim() || !consent) && !submitting && (
                <p className="text-xs text-silver-400">{t.submitHint}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
