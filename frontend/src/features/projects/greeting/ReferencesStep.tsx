/**
 * Шаг 2 мастера поздравления — референс-фото (до 7, скетч), вместе с
 * формами добавления (`ReferenceUploader`) и правки (`ReferenceEditor`):
 * они нужны только этому шагу, поэтому живут в одном файле.
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useCallback, useEffect, useRef, useId } from 'react';
import {
  ImageIcon,
  Sparkles,
  Wand2,
  Pencil,
  Trash2,
  Camera,
  Check,
} from 'lucide-react';
import {
  Card,
  CardHeader,
  Button,
  Alert,
  Spinner,
  Field,
  Input,
  Textarea,
} from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';
import {
  listGreetingReferences,
  suggestGreetingSceneSettings,
  MAX_GREETING_REFERENCE_IMAGES,
  generateGreetingReferenceFrame,
  deleteGreetingReference,
  uploadGreetingReference,
  updateGreetingReference,
  greetingErrorMessage,
} from '../../../services/greeting-api';
import { SketchSlotActions } from '../../sketch/SketchSlotActions';
import { revokeObjectUrl } from '../../../lib/object-url';
import type { GreetingReferenceImageView } from '../../../types/project';
import { referenceFaceState } from '../../../lib/persona-greeting';
import { confirmReferenceFaceConsent } from '../../../lib/persona-greeting-api';
import { HelpButton } from '../HelpSheet';
import {
  type ReferenceFormsState,
  SESSION_VOICE_TARGETS,
  refusalLines,
  planReferenceVoice,
} from '../../../lib/voice-fields';
import { useVoiceFieldApplier } from '../../voice/voice-commands';
import {
  useSessionVoiceTexts,
  describeSessionValue,
  useReferenceFormVoice,
} from '../../voice/greeting-session-voice';

const REFERENCE_PHOTO_MIME = ['image/png', 'image/jpeg'];
const REFERENCE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

// ── Шаг 2: референс-изображения (доп. запрос — до 7, скетч) ─────────────

export function ReferencesStep({
  sessionId,
  disabled,
  onChanged,
}: {
  sessionId: string;
  disabled: boolean;
  /**
   * Список фото изменился (добавили, удалили, скетч, согласие на лицо):
   * мастер перечитывает готовность — пункты «лицо ведущего» и «фото»
   * считаются по ним (CONTRACT6 G-FE п. 7).
   */
  onChanged?: () => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [images, setImages] = useState<GreetingReferenceImageView[] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /* Фича №36: три варианта сеттинга. `null` — ещё не спрашивали,
     `[]` — спросили, но модель не дала ничего (бэкенд глотает свои
     ошибки и отдаёт пустой список); во втором случае показываем
     подсказку, а не ошибку: кадр рисуется и без сеттинга. */
  const [settings, setSettings] = useState<string[] | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const load = useCallback(() => {
    listGreetingReferences(sessionId)
      .then(setImages)
      .catch((e) => setError(greetingErrorMessage(e, dict)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- словарь: текст ошибки на момент сбоя
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (fn: () => Promise<GreetingReferenceImageView[]>) => {
    setSaving(true);
    setError(null);
    try {
      setImages(await fn());
      onChanged?.();
    } catch (e) {
      setError(greetingErrorMessage(e, dict));
    } finally {
      setSaving(false);
    }
  };

  const suggest = async () => {
    setSettingsBusy(true);
    setError(null);
    try {
      setSettings(await suggestGreetingSceneSettings(sessionId));
    } catch (e) {
      setError(greetingErrorMessage(e, dict));
    } finally {
      setSettingsBusy(false);
    }
  };

  const canDraw =
    !disabled &&
    images !== null &&
    images.length < MAX_GREETING_REFERENCE_IMAGES;

  // Голос (K5): подпись и описание живут ТОЛЬКО в открытой форме кадра —
  // её и заполняет голос (форма регистрируется сама, `voiceActive`).
  // Нет формы, их две или правки заперты — карточка отвечает причиной,
  // а не молчит: «Да» на такое ничего бы не сделало.
  const openForms = (adding ? 1 : 0) + (editingId !== null ? 1 : 0);
  const referenceForms: ReferenceFormsState = disabled
    ? 'locked'
    : openForms === 0
      ? 'none'
      : openForms === 1
        ? 'one'
        : 'two';
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets:
      images === null || referenceForms === 'one'
        ? []
        : [
            SESSION_VOICE_TARGETS.referenceLabel,
            SESSION_VOICE_TARGETS.referenceDescription,
          ],
    describe: (f) => describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) =>
      refusalLines(
        planReferenceVoice(referenceForms, saving, fields).refused,
        fields,
        voiceTexts
      ),
  });

  return (
    <Card className="p-5" data-qa="greeting-references-card">
      <CardHeader
        icon={<ImageIcon size={18} />}
        title={w.referencesHeading}
        hint={w.referencesHint}
        action={
          <>
            <HelpButton cardHook="greeting-references-card" />
            {canDraw && (
              <div className="flex flex-wrap gap-2">
                {/* Фича №6: нарисовать кадр по брифу. Рядом с загрузкой, а
                  не вместо неё — своё фото остаётся более точным
                  вариантом, а кадр нужен тем, у кого фото нет вовсе:
                  именно у них grok-путь уходил в text-to-video вслепую
                  и показывал результат только после дорогого рендера. */}
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Sparkles size={14} />}
                  loading={saving}
                  disabled={saving}
                  onClick={() =>
                    void apply(() => generateGreetingReferenceFrame(sessionId))
                  }
                >
                  {w.generateReference}
                </Button>
                {/* Фича №36: дешёвый текстовый вызов перед дорогим
                  рисованием. Отдельной кнопкой, а не автоматически при
                  открытии шага, — иначе платный вызов уходил бы у
                  каждого, кто просто пролистал шаг. */}
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Wand2 size={14} />}
                  loading={settingsBusy}
                  disabled={saving || settingsBusy}
                  onClick={() => void suggest()}
                >
                  {w.suggestSettings}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAdding((v) => !v)}
                  active={adding}
                >
                  {w.addReference}
                </Button>
              </div>
            )}
          </>
        }
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!images ? (
        <div className="flex justify-center py-4">
          <Spinner size={20} />
        </div>
      ) : (
        <>
          {settings !== null && canDraw && (
            <div className="mt-3 rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
              <p className="text-xs text-silver-400">{w.settingsHint}</p>
              {settings.length === 0 ? (
                <p className="mt-2 text-xs text-silver-400">
                  {w.settingsEmpty}
                </p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {settings.map((setting) => (
                    <li key={setting}>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saving || settingsBusy}
                        onClick={() =>
                          void apply(() =>
                            generateGreetingReferenceFrame(sessionId, setting)
                          )
                        }
                      >
                        {setting}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {adding && !disabled && (
            <ReferenceUploader
              sessionId={sessionId}
              voiceActive={referenceForms === 'one'}
              onDone={(next) => {
                setAdding(false);
                setImages(next);
                onChanged?.();
              }}
              onCancel={() => setAdding(false)}
              onError={setError}
            />
          )}

          {images.length === 0 ? (
            <p className="rounded-xl border border-dashed border-silver-300 p-3 text-xs text-silver-400 dark:border-silver-700">
              {w.referencesEmpty}
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 mt-3">
              {images.map((img) => (
                <li key={img.id} className="relative">
                  <div className="overflow-hidden rounded-xl border border-silver-200/70 dark:border-silver-800">
                    <div className="relative aspect-square w-full bg-silver-200/60 dark:bg-silver-800/60">
                      <img
                        src={img.photoUrl}
                        alt=""
                        data-qa-mask="reference-thumbnail"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    {editingId === img.id && !disabled ? (
                      <ReferenceEditor
                        sessionId={sessionId}
                        image={img}
                        voiceActive={referenceForms === 'one'}
                        onDone={(next) => {
                          setEditingId(null);
                          setImages(next);
                          onChanged?.();
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      <div className="p-2">
                        {/* Подпись и описание пишет человек — это личный
                            текст, как имя в брифе: на кадре лендинга он
                            размывается (`data-qa-mask="personal-…"`, этап I
                            ТЗ Greeting 2.0, §5.3), а сам кадр — нет. */}
                        <p
                          className="truncate text-xs font-medium"
                          data-qa-mask="personal-reference-label"
                        >
                          {img.label}
                        </p>
                        {img.description && (
                          <p
                            className="line-clamp-2 text-[11px] text-silver-400"
                            data-qa-mask="personal-reference-description"
                          >
                            {img.description}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  {!disabled && editingId !== img.id && (
                    <div className="absolute right-1.5 top-1.5 flex gap-1">
                      <button
                        type="button"
                        aria-label={w.editReferenceAria}
                        disabled={saving}
                        onClick={() => setEditingId(img.id)}
                        className="rounded-full bg-silver-950/70 p-1 text-white hover:bg-accent"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        aria-label={w.deleteReferenceAria}
                        disabled={saving}
                        onClick={() => {
                          if (
                            !window.confirm(
                              w.deleteReferenceConfirm.replace(
                                '{{label}}',
                                img.label
                              )
                            )
                          )
                            return;
                          void apply(() =>
                            deleteGreetingReference(sessionId, img.id)
                          );
                        }}
                        className="rounded-full bg-silver-950/70 p-1 text-white hover:bg-rose-500"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )}
                  <FaceConsentNote
                    image={img}
                    disabled={saving || disabled}
                    onConfirm={() =>
                      void apply(() =>
                        confirmReferenceFaceConsent(sessionId, img.id)
                      )
                    }
                  />
                  <SketchSlotActions
                    className="mt-1"
                    target={{
                      type: 'session-greeting-reference',
                      id: sessionId,
                      subId: img.id,
                    }}
                    hasImage
                    originalUrl={img.originalPhotoUrl}
                    activeUrl={img.photoUrl}
                    variant={img.variant}
                    originalDeleted={img.originalDeleted}
                    description={img.description ?? img.label}
                    disabled={saving || disabled}
                    onSlot={() => {
                      load();
                      onChanged?.();
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Лицо на фото референса (ТЗ Greeting 2.0 §4.8, Г-8). Сервер при
 * загрузке ищет лицо; нашёл — без подтверждения автора фото в
 * видеомодель не уйдёт. Два честных выхода: подтвердить согласие этого
 * человека или сделать скетч с заменой лица (кнопка «Скетч» ниже —
 * существующие действия слота). Снять подтверждение нельзя: контракт
 * знает только `faceConsent: true`, и чекбокс после него гаснет.
 */
function FaceConsentNote({
  image,
  disabled,
  onConfirm,
}: {
  image: GreetingReferenceImageView;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const { dict } = useI18n();
  const pg = dict.personaGreeting;
  const state = referenceFaceState(image);
  if (state === 'none') return null;
  if (state === 'sketched') {
    return (
      <p className="mt-1 text-[11px] text-silver-400">{pg.faceSketched}</p>
    );
  }
  return (
    <div className="mt-1 space-y-1 rounded-lg border border-amber-400/40 bg-amber-400/5 p-2 text-[11px] leading-relaxed">
      {state === 'needs-consent' && <p>{pg.faceFound}</p>}
      {/* Проверка лица не состоялась (или фото старше неё): сервер
          теперь закрыт по умолчанию и считает, что лицо может быть. */}
      {state === 'unchecked' && <p>{pg.faceUnchecked}</p>}
      <label className="flex cursor-pointer gap-2">
        <input
          type="checkbox"
          checked={state === 'consented'}
          disabled={disabled || state === 'consented'}
          onChange={(e) => {
            if (e.target.checked) onConfirm();
          }}
          className="mt-0.5 h-4 w-4 shrink-0 accent-sky-400"
        />
        <span>{pg.faceConsentLabel}</span>
      </label>
      {(state === 'needs-consent' || state === 'unchecked') && (
        <p className="text-silver-400">{pg.faceNotSentNote}</p>
      )}
    </div>
  );
}

function ReferenceUploader({
  sessionId,
  voiceActive,
  onDone,
  onCancel,
  onError,
}: {
  sessionId: string;
  /** Единственная открытая форма кадра — голос пишет в неё (K5). */
  voiceActive: boolean;
  onDone: (images: GreetingReferenceImageView[]) => void;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const fid = useId();

  useEffect(() => () => revokeObjectUrl(preview), [preview]);

  useReferenceFormVoice(
    voiceActive,
    uploading,
    w.addReference,
    setLabel,
    setDescription
  );

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!REFERENCE_PHOTO_MIME.includes(f.type)) {
      onError(w.referencePngJpegOnly);
      return;
    }
    if (f.size > REFERENCE_PHOTO_MAX_BYTES) {
      onError(w.fileTooLarge);
      return;
    }
    onError(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    if (!label) setLabel(f.name.replace(/\.[^.]+$/, '').slice(0, 80));
  };

  const submit = async () => {
    if (!file || !label.trim()) return;
    setUploading(true);
    setProgress(0);
    onError(null);
    try {
      const next = await uploadGreetingReference(
        sessionId,
        file,
        label.trim(),
        description.trim() || null,
        setProgress
      );
      onDone(next);
    } catch (e) {
      onError(greetingErrorMessage(e, dict));
    } finally {
      setUploading(false);
    }
  };

  return (
    <form
      className="space-y-2 rounded-xl border border-accent/30 bg-accent/5 p-3 mb-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="relative grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-lg border border-dashed border-silver-300 text-silver-400 hover:border-accent dark:border-silver-700"
        >
          {preview ? (
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <Camera size={20} />
          )}
          {uploading && (
            <span className="absolute inset-0 grid place-items-center bg-silver-950/60 font-mono text-xs text-white tabular">
              {progress}%
            </span>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <Field label={w.referenceLabelLabel} htmlFor={`${fid}-label`}>
            <Input
              id={`${fid}-label`}
              data-qa="greeting-references-label"
              data-qa-mask="personal-reference-label"
              value={label}
              maxLength={80}
              placeholder={w.referenceLabelPlaceholder}
              onChange={(e) => setLabel(e.target.value)}
              disabled={uploading}
            />
          </Field>
        </div>
      </div>
      <Field
        label={w.referenceDescLabel}
        counter={`${description.length}/2000`}
        htmlFor={`${fid}-description`}
      >
        <Textarea
          id={`${fid}-description`}
          data-qa="greeting-references-description"
          data-qa-mask="personal-reference-description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
          placeholder={w.referenceDescPlaceholder}
          disabled={uploading}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={uploading}
        >
          {w.cancel}
        </Button>
        <Button
          type="submit"
          size="sm"
          icon={<Check size={14} />}
          loading={uploading}
          disabled={!file || !label.trim()}
        >
          {w.addReference}
        </Button>
      </div>
    </form>
  );
}

/**
 * Инлайн-редактирование подписи/описания уже загруженного референса —
 * тем же приёмом, что `ReferenceUploader` (форма прямо в карточке, без
 * отдельного экрана), но без файла: `updateGreetingReference` меняет
 * только текстовые поля, само изображение неизменно (заменить фото —
 * это удалить и загрузить заново, отдельного флоу не требуется).
 */
function ReferenceEditor({
  sessionId,
  image,
  voiceActive,
  onDone,
  onCancel,
}: {
  sessionId: string;
  image: GreetingReferenceImageView;
  /** Единственная открытая форма кадра — голос пишет в неё (K5). */
  voiceActive: boolean;
  onDone: (images: GreetingReferenceImageView[]) => void;
  onCancel: () => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [label, setLabel] = useState(image.label);
  const [description, setDescription] = useState(image.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fid = useId();
  useReferenceFormVoice(
    voiceActive,
    saving,
    w.saveReferenceButton,
    setLabel,
    setDescription
  );

  const submit = async () => {
    if (!label.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const next = await updateGreetingReference(sessionId, image.id, {
        label: label.trim(),
        description: description.trim() || null,
      });
      onDone(next);
    } catch (e) {
      setError(greetingErrorMessage(e, dict));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label={w.referenceLabelLabel} htmlFor={`${fid}-label`}>
        <Input
          id={`${fid}-label`}
          data-qa="greeting-references-label"
          data-qa-mask="personal-reference-label"
          value={label}
          maxLength={80}
          placeholder={w.referenceLabelPlaceholder}
          onChange={(e) => setLabel(e.target.value)}
          disabled={saving}
          autoFocus
        />
      </Field>
      <Field
        label={w.referenceDescLabel}
        counter={`${description.length}/2000`}
        htmlFor={`${fid}-description`}
      >
        <Textarea
          id={`${fid}-description`}
          data-qa="greeting-references-description"
          data-qa-mask="personal-reference-description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
          placeholder={w.referenceDescPlaceholder}
          disabled={saving}
        />
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          {w.cancel}
        </Button>
        <Button
          type="submit"
          size="sm"
          icon={<Check size={14} />}
          loading={saving}
          disabled={!label.trim()}
        >
          {w.saveReferenceButton}
        </Button>
      </div>
    </form>
  );
}
