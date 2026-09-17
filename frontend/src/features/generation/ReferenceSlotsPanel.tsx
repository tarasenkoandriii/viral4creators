/**
 * ReferenceSlotsPanel — spec §17: which images fill Veo's three
 * referenceImage slots, and the user's own scenes (location / set).
 *
 * Candidates come from the server (active characters with a photo, the
 * uploaded scenes, the brand's permanent scenes from the manifest snapshot
 * — §17.1 — and the product photo). Tap a card to put it in the next free
 * slot / take it out; the badge shows the slot number. Everything not in a
 * slot is described in the prompt text — the card says so. "Авто" restores
 * the default rule (characters → session scenes → brand scenes → product).
 * Brand scenes carry a «бренд» mark and no delete button: they are edited
 * in the «Бренд» section, not per session.
 *
 * Scenes are uploaded right here (PNG/JPEG ≤10 MB, label + optional
 * description used as the text fallback), because this is the moment the
 * user is thinking about what Veo will see.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  ImageIcon,
  MapPin,
  Package,
  RotateCcw,
  Trash2,
  UserRound,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  Spinner,
  Textarea,
} from '../../components/ui';
import {
  deleteScene,
  errorMessage,
  getReferenceSlots,
  putReferenceSlots,
  resetReferenceSlots,
  uploadScene,
} from '../../services/projects-api';
import type { ReferenceCandidate, ReferenceSlots } from '../../types';
import { revokeObjectUrl } from '../../lib/object-url';
import { useI18n } from '../../lib/i18n-context';
import type { Dictionary } from '../../lib/get-dictionary';

const PHOTO_MIME = ['image/png', 'image/jpeg'];
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

function kindLabel(dict: Dictionary, kind: ReferenceCandidate['kind']) {
  if (kind === 'character') return dict.referenceSlotsPanel.kindCharacter;
  if (kind === 'scene') return dict.referenceSlotsPanel.kindScene;
  return dict.referenceSlotsPanel.kindProduct;
}

function KindIcon({ kind }: { kind: ReferenceCandidate['kind'] }) {
  if (kind === 'character') return <UserRound size={11} />;
  if (kind === 'scene') return <MapPin size={11} />;
  return <Package size={11} />;
}

export function ReferenceSlotsPanel({
  sessionId,
  onChange,
}: {
  sessionId: string;
  /** Lets the wizard mirror the count in its summary line. */
  onChange?: (slots: ReferenceSlots) => void;
}) {
  const { dict } = useI18n();
  const [data, setData] = useState<ReferenceSlots | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingScene, setAddingScene] = useState(false);

  const load = () =>
    getReferenceSlots(sessionId)
      .then((d) => {
        setData(d);
        onChange?.(d);
      })
      .catch((e) => setError(errorMessage(e)));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const apply = async (fn: () => Promise<ReferenceSlots>) => {
    setSaving(true);
    setError(null);
    try {
      const d = await fn();
      setData(d);
      onChange?.(d);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (id: string) => {
    if (!data) return;
    const inSlot = data.slots.includes(id);
    const next = inSlot
      ? data.slots.filter((s) => s !== id)
      : data.slots.length >= data.max
        ? data.slots
        : [...data.slots, id];
    if (!inSlot && data.slots.length >= data.max) {
      setError(
        dict.referenceSlotsPanel.slotsFull
          .replace('{{max}}', String(data.max))
          .replace('{{max}}', String(data.max))
      );
      return;
    }
    void apply(() => putReferenceSlots(sessionId, next));
  };

  if (!data) {
    return (
      <div className="flex justify-center py-4">
        {error ? <Alert tone="error">{error}</Alert> : <Spinner size={20} />}
      </div>
    );
  }

  const sceneCount = data.candidates.filter(
    (c) => c.kind === 'scene' && c.origin !== 'brand'
  ).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="label">{dict.referenceSlotsPanel.heading}</span>
          <p className="-mt-1 text-[11px] text-silver-400">
            {dict.referenceSlotsPanel.slotsCount
              .replace('{{count}}', String(data.slots.length))
              .replace('{{max}}', String(data.max))}
            {' · '}
            {data.isDefault
              ? dict.referenceSlotsPanel.autoPicked
              : dict.referenceSlotsPanel.yourChoice}
            {' · '}
            {dict.referenceSlotsPanel.restAsText}
          </p>
        </div>
        <div className="flex gap-1">
          {!data.isDefault && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={12} />}
              onClick={() => void apply(() => resetReferenceSlots(sessionId))}
              disabled={saving}
            >
              {dict.referenceSlotsPanel.auto}
            </Button>
          )}
          {sceneCount < 5 && (
            <Button
              size="sm"
              variant="outline"
              icon={<MapPin size={12} />}
              onClick={() => setAddingScene((v) => !v)}
              active={addingScene}
              disabled={saving}
            >
              {dict.referenceSlotsPanel.ownScene}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {addingScene && (
        <SceneUploader
          sessionId={sessionId}
          onDone={(d) => {
            setAddingScene(false);
            setData(d);
            onChange?.(d);
          }}
          onCancel={() => setAddingScene(false)}
          onError={setError}
        />
      )}

      {data.candidates.length === 0 ? (
        <p className="rounded-xl border border-dashed border-silver-300 p-3 text-xs text-silver-400 dark:border-silver-700">
          {dict.referenceSlotsPanel.emptyState}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {data.candidates.map((c) => {
            const slot = data.slots.indexOf(c.id);
            const chosen = slot >= 0;
            return (
              <li key={c.id} className="relative">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => toggle(c.id)}
                  aria-pressed={chosen}
                  className={`flex w-full flex-col overflow-hidden rounded-xl border text-left transition-all disabled:opacity-60 ${
                    chosen
                      ? 'border-accent ring-2 ring-accent/40'
                      : 'border-silver-200/70 hover:border-accent/60 dark:border-silver-800'
                  }`}
                >
                  <div className="relative aspect-square w-full bg-silver-200/60 dark:bg-silver-800/60">
                    {c.thumbnailUrl ? (
                      <img
                        src={c.thumbnailUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="grid h-full place-items-center text-silver-400">
                        <ImageIcon size={22} />
                      </div>
                    )}
                    <span
                      className={`absolute left-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold ${
                        chosen
                          ? 'bg-accent text-accent-on'
                          : 'bg-silver-950/60 text-white'
                      }`}
                    >
                      {chosen ? (
                        slot + 1
                      ) : (
                        <Check size={12} className="opacity-0" />
                      )}
                    </span>
                    {!chosen && (
                      <span className="absolute bottom-1.5 left-1.5 rounded-md bg-silver-950/70 px-1.5 py-0.5 text-[11px] text-white">
                        {dict.referenceSlotsPanel.asText}
                      </span>
                    )}
                  </div>
                  <div className="p-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={chosen ? 'accent' : 'neutral'}>
                        <KindIcon kind={c.kind} /> {kindLabel(dict, c.kind)}
                      </Badge>
                      {c.origin === 'brand' && c.kind === 'scene' && (
                        <Badge tone="neutral">
                          {dict.referenceSlotsPanel.brandBadge}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs font-medium">
                      {c.label}
                    </p>
                    <p className="line-clamp-2 text-[11px] text-silver-400">
                      {c.textFallback}
                    </p>
                  </div>
                </button>
                {c.kind === 'scene' && c.origin !== 'brand' && (
                  <button
                    type="button"
                    aria-label={dict.referenceSlotsPanel.deleteSceneAria}
                    disabled={saving}
                    onClick={() => {
                      if (
                        !window.confirm(
                          dict.referenceSlotsPanel.deleteSceneConfirm.replace(
                            '{{label}}',
                            c.label
                          )
                        )
                      )
                        return;
                      void apply(async () => {
                        await deleteScene(
                          sessionId,
                          c.id.replace(/^scene:/, '')
                        );
                        return getReferenceSlots(sessionId);
                      });
                    }}
                    className="absolute right-1.5 top-1.5 rounded-full bg-silver-950/70 p-1 text-white hover:bg-rose-500"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SceneUploader({
  sessionId,
  onDone,
  onCancel,
  onError,
}: {
  sessionId: string;
  onDone: (slots: ReferenceSlots) => void;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const { dict } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // Ссылка на выбранный файл отзывается и при замене, и при закрытии
  // формы (этап 119): зависимость эффекта — сам адрес, поэтому уборка
  // срабатывает на оба случая. Форма открывается и закрывается часто, и
  // каждая отменённая загрузка оставляла картинку в памяти вкладки.
  useEffect(() => () => revokeObjectUrl(preview), [preview]);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!PHOTO_MIME.includes(f.type)) {
      onError(dict.referenceSlotsPanel.scenePngJpegOnly);
      return;
    }
    if (f.size > PHOTO_MAX_BYTES) {
      onError(dict.referenceSlotsPanel.fileTooLarge);
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
      await uploadScene(
        sessionId,
        file,
        label.trim(),
        description.trim() || null,
        setProgress
      );
      onDone(await getReferenceSlots(sessionId));
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <form
      className="space-y-2 rounded-xl border border-accent/30 bg-accent/5 p-3"
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
          <Field
            htmlFor="scene-label"
            label={dict.referenceSlotsPanel.sceneLabelLabel}
          >
            <Input
              id="scene-label"
              value={label}
              maxLength={80}
              placeholder={dict.referenceSlotsPanel.sceneLabelPlaceholder}
              onChange={(e) => setLabel(e.target.value)}
              disabled={uploading}
            />
          </Field>
        </div>
      </div>
      <Field
        htmlFor="scene-desc"
        label={dict.referenceSlotsPanel.sceneDescLabel}
        counter={`${description.length}/2000`}
      >
        <Textarea
          id="scene-desc"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
          placeholder={dict.referenceSlotsPanel.sceneDescPlaceholder}
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
          {dict.referenceSlotsPanel.cancel}
        </Button>
        <Button
          type="submit"
          size="sm"
          icon={<Check size={14} />}
          loading={uploading}
          disabled={!file || !label.trim()}
        >
          {dict.referenceSlotsPanel.addScene}
        </Button>
      </div>
    </form>
  );
}
