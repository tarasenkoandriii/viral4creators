/**
 * GreetingVideoWizard — GREETING_VIDEO (ТЗ TZ-Greeting-Video-Project-Type.md
 * §4.3/§5/§8), and the follow-up request: reference-image upload (до 7 —
 * предел Grok reference-to-video) с ИИ-скетчем, как у остальных
 * изображений проекта.
 *
 * Один экран на весь путь, а не отдельные маршруты на каждый шаг — тем же
 * приёмом, что ClientSiteWizard: шаги строго последовательны (бриф →
 * референсы → сценарий → видео), и адрес «шаг 3» без сессии ничего не
 * значит. `Stepper` ниже — только индикатор, не роутинг.
 *
 * Каждый шаг — минимальный API-контракт, а не переиспользование
 * `useWorkflow`: тот хук — конечный автомат SINGLE/LINE
 * (upload → analyze → product → prompt → generate), завязанный на разбор
 * референсного видео и `productInformation`, которых у GREETING_VIDEO нет
 * вообще (см. backend GreetingPromptService/GreetingVideoService
 * doc-comment — тот же выбор архитектуры, отдельный сервис вместо ветки в
 * существующем).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Download,
  Gift,
  ImageIcon,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Pills,
  Select,
  Spinner,
  Stepper,
  Textarea,
} from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes } from '../../lib/router';
import {
  errorMessage,
  getPlanState,
  listBrandManifests,
} from '../../services/projects-api';
import {
  createGreetingSession,
  deleteGreetingReference,
  generateGreetingPrompt,
  generateGreetingReferenceFrame,
  getGreetingBrief,
  getGreetingVideoStatus,
  listGreetingReferences,
  listGreetingSessions,
  MAX_GREETING_REFERENCE_IMAGES,
  startGreetingVideo,
  updateGreetingBrief,
  updateGreetingReference,
  uploadGreetingReference,
} from '../../services/greeting-api';
import { SketchSlotActions } from '../sketch/SketchSlotActions';
import { revokeObjectUrl } from '../../lib/object-url';
import { LoadError, ScreenHeader } from './shared';
import { GreetingDeliveryPanel } from './GreetingDeliveryPanel';
import {
  GREETING_OCCASIONS,
  GREETING_RESOLUTIONS,
  allowedTonesFor,
  defaultToneFor,
} from '../../types/project';
import type {
  BrandManifestSummaryView,
  GreetingBriefView,
  GreetingOccasion,
  GreetingPresenterProvider,
  GreetingReferenceImageView,
  GreetingResolution,
  GreetingTone,
} from '../../types/project';
import type { GeneratedVideo, GenerationPrompt, PlanId } from '../../types';
import { GenerationStatus } from '../../types';

const REFERENCE_PHOTO_MIME = ['image/png', 'image/jpeg'];
const REFERENCE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const POLL_INTERVAL_MS = 4000;

function stepIndexOf(
  hasSession: boolean,
  prompt: GenerationPrompt | undefined,
  hasVideo: boolean
): number {
  if (!hasSession) return 0;
  if (hasVideo) return 3;
  if (prompt) return 2;
  return 1;
}

export function GreetingVideoWizard({ projectId }: { projectId: string }) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [brief, setBrief] = useState<GreetingBriefView | null>(null);
  const [manifests, setManifests] = useState<BrandManifestSummaryView[]>([]);
  const [plan, setPlan] = useState<PlanId>('LITE');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<GenerationPrompt | undefined>();
  const [video, setVideo] = useState<GeneratedVideo | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [b, mfs, planState, sessions] = await Promise.all([
        getGreetingBrief(projectId),
        listBrandManifests().catch(() => []),
        getPlanState().catch(() => null),
        listGreetingSessions(projectId).catch(() => []),
      ]);
      setBrief(b);
      setManifests(mfs);
      if (planState) setPlan(planState.plan);
      const latest = sessions[0];
      if (latest) {
        setSessionId(latest.sessionId);
      }
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner size={24} />
      </div>
    );
  }
  if (loadError || !brief) {
    return (
      <div>
        <ScreenHeader title={w.title} back={routes.project(projectId)} />
        <LoadError error={loadError} onRetry={load} />
      </div>
    );
  }

  const step = stepIndexOf(!!sessionId, prompt, !!video);

  return (
    <div className="animate-fadeIn space-y-4">
      <ScreenHeader
        title={w.title}
        back={routes.project(projectId)}
        hint={w.hint}
      />
      <Stepper
        steps={[
          w.occasionLabel,
          w.referencesHeading,
          w.scriptHeading,
          w.videoHeading,
        ]}
        current={step}
      />

      <BriefStep
        brief={brief}
        manifests={manifests}
        plan={plan}
        hasSession={!!sessionId}
        onSaved={setBrief}
        onStartSession={async () => {
          const session = await createGreetingSession(projectId);
          setSessionId(session.sessionId);
        }}
      />

      {sessionId && (
        <ReferencesStep sessionId={sessionId} disabled={!!prompt} />
      )}

      {sessionId && (
        <ScriptStep
          sessionId={sessionId}
          prompt={prompt}
          onGenerated={setPrompt}
        />
      )}

      {sessionId && prompt && (
        <VideoStep
          sessionId={sessionId}
          video={video}
          onVideo={setVideo}
          recipientName={brief.recipientName}
          senderName={brief.senderName}
        />
      )}
    </div>
  );
}

// ── Шаг 1: бриф ──────────────────────────────────────────────────────────

function BriefStep({
  brief,
  manifests,
  plan,
  hasSession,
  onSaved,
  onStartSession,
}: {
  brief: GreetingBriefView;
  manifests: BrandManifestSummaryView[];
  plan: PlanId;
  hasSession: boolean;
  onSaved: (brief: GreetingBriefView) => void;
  onStartSession: () => Promise<void>;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;

  const [occasion, setOccasion] = useState<GreetingOccasion>(brief.occasion);
  const [customOccasionText, setCustomOccasionText] = useState(
    brief.customOccasionText ?? ''
  );
  const [recipientName, setRecipientName] = useState(brief.recipientName);
  const [senderName, setSenderName] = useState(brief.senderName ?? '');
  const [tone, setTone] = useState<GreetingTone>(brief.tone);
  const [personalMessage, setPersonalMessage] = useState(
    brief.personalMessage ?? ''
  );
  const [presenterProvider, setPresenterProvider] =
    useState<GreetingPresenterProvider>(brief.presenterProvider);
  const [resolution, setResolution] = useState<GreetingResolution>(
    brief.resolution
  );
  const [brandManifestId, setBrandManifestId] = useState(
    brief.brandManifestId ?? ''
  );
  const [occasionDate, setOccasionDate] = useState(brief.occasionDate ?? '');

  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const canSave =
    recipientName.trim().length > 0 &&
    (occasion !== 'OTHER' || customOccasionText.trim().length > 0);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateGreetingBrief(brief.projectId, {
        occasion,
        customOccasionText:
          occasion === 'OTHER' ? customOccasionText.trim() : null,
        recipientName: recipientName.trim(),
        senderName: senderName.trim() || null,
        tone,
        personalMessage: personalMessage.trim() || null,
        presenterProvider,
        resolution,
        brandManifestId: brandManifestId || null,
        occasionDate: occasionDate || null,
      });
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await save();
      await onStartSession();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card className="p-5">
      <CardHeader
        icon={<Gift size={18} />}
        title={w.occasionLabel}
        hint={hasSession ? undefined : w.hint}
      />
      <div className="space-y-4">
        <Field label={w.occasionLabel}>
          <Select
            value={occasion}
            onChange={(e) => {
              // Тот же сброс тона при смене повода, что и в
              // ProjectCreateScreen: иначе «С юмором», выбранный для дня
              // рождения, поедет в соболезнование и получит 400 уже
              // после заполнения всей формы.
              const next = e.target.value as GreetingOccasion;
              setOccasion(next);
              if (!allowedTonesFor(next).includes(tone)) {
                setTone(defaultToneFor(next));
              }
            }}
            disabled={hasSession}
          >
            {GREETING_OCCASIONS.map((o) => (
              <option key={o} value={o}>
                {w.occasion[o]}
              </option>
            ))}
          </Select>
        </Field>

        {occasion === 'OTHER' && (
          <Field label={w.customOccasionLabel}>
            <Input
              value={customOccasionText}
              onChange={(e) =>
                setCustomOccasionText(e.target.value.slice(0, 120))
              }
              placeholder={w.customOccasionPlaceholder}
              disabled={hasSession}
            />
          </Field>
        )}

        <Field label={w.recipientNameLabel}>
          <Input
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value.slice(0, 120))}
            placeholder={w.recipientNamePlaceholder}
            disabled={hasSession}
          />
        </Field>

        <Field label={w.senderNameLabel}>
          <Input
            value={senderName}
            onChange={(e) => setSenderName(e.target.value.slice(0, 120))}
            placeholder={w.senderNamePlaceholder}
          />
        </Field>

        <div>
          <span className="label">{w.toneLabel}</span>
          <Pills
            value={tone}
            onChange={setTone}
            // Этап 2, фича №3: набор тонов зависит от повода — см.
            // тот же приём и то же обоснование в ProjectCreateScreen.
            options={allowedTonesFor(occasion).map((t) => ({
              value: t,
              label: w.tone[t],
            }))}
          />
        </div>

        <Field
          label={w.personalMessageLabel}
          hint={w.personalMessageHint}
          counter={`${personalMessage.length}/2000`}
        >
          <Textarea
            rows={3}
            value={personalMessage}
            onChange={(e) => setPersonalMessage(e.target.value.slice(0, 2000))}
            placeholder={w.personalMessagePlaceholder}
          />
        </Field>

        <div>
          <span className="label">{w.presenterProviderLabel}</span>
          <Pills
            value={presenterProvider}
            onChange={setPresenterProvider}
            disabled={hasSession}
            options={[
              { value: 'grok', label: w.providerGrok },
              {
                value: 'hedra',
                label: w.providerHedra,
                sub:
                  plan === 'PREMIUM' ? undefined : w.providerHedraPremiumOnly,
              },
            ]}
          />
          {presenterProvider === 'hedra' && (
            <Alert tone="warning" className="mt-2">
              {w.providerHedraPilotNotice}
            </Alert>
          )}
        </div>

        <Field label={w.resolutionLabel}>
          <Select
            value={resolution}
            onChange={(e) =>
              setResolution(e.target.value as GreetingResolution)
            }
            disabled={hasSession}
          >
            {GREETING_RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={w.occasionDateLabel}>
          <Input
            type="date"
            value={occasionDate}
            onChange={(e) => setOccasionDate(e.target.value)}
          />
        </Field>

        <Field label={w.manifestLabel}>
          <Select
            value={brandManifestId}
            onChange={(e) => setBrandManifestId(e.target.value)}
            disabled={hasSession || manifests.length === 0}
          >
            <option value="">{w.noManifestOption}</option>
            {manifests.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </Field>

        {error && <Alert tone="error">{error}</Alert>}
        {saved && !error && (
          <Alert tone="success">
            <Check size={14} className="inline mr-1" />
            {w.editSubmitButton}
          </Alert>
        )}

        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!canSave || saving || starting}
            loading={saving}
            onClick={() => void save()}
          >
            {w.editSubmitButton}
          </Button>
          {!hasSession && (
            <Button
              disabled={!canSave || saving || starting}
              loading={starting}
              onClick={() => void start()}
            >
              {w.startSessionButton}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Шаг 2: референс-изображения (доп. запрос — до 7, скетч) ─────────────

function ReferencesStep({
  sessionId,
  disabled,
}: {
  sessionId: string;
  disabled: boolean;
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

  const load = useCallback(() => {
    listGreetingReferences(sessionId)
      .then(setImages)
      .catch((e) => setError(errorMessage(e)));
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (fn: () => Promise<GreetingReferenceImageView[]>) => {
    setSaving(true);
    setError(null);
    try {
      setImages(await fn());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <CardHeader
        icon={<ImageIcon size={18} />}
        title={w.referencesHeading}
        hint={w.referencesHint}
        action={
          !disabled &&
          images &&
          images.length < MAX_GREETING_REFERENCE_IMAGES && (
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
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAdding((v) => !v)}
                active={adding}
              >
                {w.addReference}
              </Button>
            </div>
          )
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
          {adding && !disabled && (
            <ReferenceUploader
              sessionId={sessionId}
              onDone={(next) => {
                setAdding(false);
                setImages(next);
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
                        onDone={(next) => {
                          setEditingId(null);
                          setImages(next);
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      <div className="p-2">
                        <p className="truncate text-xs font-medium">
                          {img.label}
                        </p>
                        {img.description && (
                          <p className="line-clamp-2 text-[11px] text-silver-400">
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
                    onSlot={() => void load()}
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

function ReferenceUploader({
  sessionId,
  onDone,
  onCancel,
  onError,
}: {
  sessionId: string;
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

  useEffect(() => () => revokeObjectUrl(preview), [preview]);

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
      onError(errorMessage(e));
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
          <Field label={w.referenceLabelLabel}>
            <Input
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
      >
        <Textarea
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
  onDone,
  onCancel,
}: {
  sessionId: string;
  image: GreetingReferenceImageView;
  onDone: (images: GreetingReferenceImageView[]) => void;
  onCancel: () => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [label, setLabel] = useState(image.label);
  const [description, setDescription] = useState(image.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(errorMessage(e));
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
      <Field label={w.referenceLabelLabel}>
        <Input
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
      >
        <Textarea
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

// ── Шаг 3: сценарий ───────────────────────────────────────────────────────

function ScriptStep({
  sessionId,
  prompt,
  onGenerated,
}: {
  sessionId: string;
  prompt: GenerationPrompt | undefined;
  onGenerated: (p: GenerationPrompt) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      onGenerated(await generateGreetingPrompt(sessionId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="p-5">
      <CardHeader title={w.scriptHeading} />
      {error && <Alert tone="error">{error}</Alert>}
      {prompt ? (
        <div className="space-y-3">
          <p className="whitespace-pre-wrap rounded-xl border border-silver-200/70 p-3 text-sm dark:border-silver-800">
            {prompt.voiceoverScript || prompt.finalText}
          </p>
          <Button
            variant="outline"
            size="sm"
            icon={<RefreshCw size={14} />}
            loading={loading}
            onClick={() => void generate()}
          >
            {w.regenerateScriptButton}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-silver-400">{w.scriptEmpty}</p>
          <Button loading={loading} onClick={() => void generate()}>
            {w.generateScriptButton}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ── Шаг 4: видео ──────────────────────────────────────────────────────────

function isTerminal(video: GeneratedVideo | undefined): boolean {
  return (
    !!video &&
    video.status !== GenerationStatus.PENDING &&
    video.status !== GenerationStatus.PROCESSING
  );
}

function VideoStep({
  sessionId,
  video,
  onVideo,
  recipientName,
  senderName,
}: {
  sessionId: string;
  video: GeneratedVideo | undefined;
  onVideo: (v: GeneratedVideo | undefined) => void;
  /** Имена из брифа — только для текста сообщения при вручении (№26). */
  recipientName: string;
  senderName?: string | null;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlight = useRef(false);

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
    setStarting(true);
    setError(null);
    try {
      const v = await startGreetingVideo(sessionId);
      onVideo(v);
      if (!isTerminal(v)) startPolling();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <Card className="p-5">
        <CardHeader title={w.videoHeading} />
        {error && <Alert tone="error">{error}</Alert>}

        {!video && (
          <Button loading={starting} onClick={() => void start()}>
            {w.generateVideoButton}
          </Button>
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
