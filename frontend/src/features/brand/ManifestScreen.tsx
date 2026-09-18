/**
 * Brand Manifest — create / edit (spec §12 "Экран — управление
 * манифестом"). One screen for both modes: without `manifestId` it is the
 * create form (title + style notes, saved once → navigates to the edit
 * URL); with an id it loads the manifest and shows the style form plus the
 * characters block.
 *
 * `filters` / `effects` are a free JSON object (open question §12.1 —
 * schema settles in Stage 15), hidden behind "Дополнительно" so a
 * first-time user sees only title + style notes.
 *
 * Characters (spec §10 / §12): label + optional text description +
 * optional PNG/JPEG photo (a Veo `referenceImage`, §10.2). Only the first
 * three photo-characters ride as images (§10.3), so the list shows that
 * cap explicitly rather than surprising the user at generation time.
 *
 * Brand scenes (spec §17.1, Stage 22) are the same block with other words:
 * permanent locations of the brand (showroom, studio kitchen) that every
 * session of a linked project inherits as slot candidates. One generic
 * `AssetsBlock` renders both, parameterised by `getAssetCopy(kind, …)`.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  Lock,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  UserRound,
  X,
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
  Spinner,
  Textarea,
} from '../../components/ui';
import {
  addBrandCharacter,
  addBrandScene,
  createBrandManifest,
  deleteBrandCharacter,
  deleteBrandManifest,
  deleteBrandScene,
  errorMessage,
  getBrandManifest,
  updateBrandCharacter,
  updateBrandManifest,
  updateBrandScene,
  uploadBrandCharacterPhoto,
  uploadBrandScenePhoto,
  type CharacterInput,
} from '../../services/projects-api';
import { cameraMoveHint, cameraMoveOptions } from '../../lib/camera-move';
import {
  subtitleThemeHint,
  subtitleThemeOptions,
} from '../../lib/subtitle-theme';
import { useAsync } from '../../lib/useAsync';
import { useFeature } from '../../lib/plan-context';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import type { Locale } from '../../lib/i18n';
import type { Dictionary } from '../../lib/get-dictionary';
import type {
  BrandCharacterView,
  BrandManifestView,
  JsonObject,
} from '../../types/project';
import type {
  CameraMove,
  VoiceMode,
  SubtitlesMode,
  SubtitleTheme,
} from '../../types';
import { LoadError, ScreenHeader } from '../projects/shared';
import { SketchSlotActions } from '../sketch/SketchSlotActions';
import { VoicePicker } from './VoicePicker';
import { voiceModeHint } from '../../lib/voice-mode';
import { JsonField } from './JsonField';

/** Same cap as the backend / spec §10.3. */
const REFERENCE_IMAGE_CAP = 3;
const PHOTO_MIME = ['image/png', 'image/jpeg'];
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export function ManifestScreen({ manifestId }: { manifestId?: string }) {
  if (!manifestId) return <CreateForm />;
  return <EditScreen manifestId={manifestId} />;
}

// ── Create ────────────────────────────────────────────────────────────

function CreateForm() {
  const { dict } = useI18n();
  const [title, setTitle] = useState('');
  const [styleNotes, setStyleNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    const t = title.trim();
    if (!t) {
      setError(dict.manifestScreen.titleRequired);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const m = await createBrandManifest({
        title: t,
        styleNotes: styleNotes.trim() || null,
      });
      navigate(routes.manifest(m.id), true);
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.manifestScreen.createTitle}
        back={routes.manifests()}
        hint={dict.manifestScreen.createHint}
      />
      <Card className="p-5">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
        >
          <Field
            label={dict.manifestScreen.titleLabel}
            htmlFor="manifest-title"
          >
            <Input
              id="manifest-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={dict.manifestScreen.titlePlaceholder}
              maxLength={120}
              autoFocus
              disabled={submitting}
            />
          </Field>
          <Field
            label={dict.manifestScreen.styleLabel}
            htmlFor="manifest-style"
            hint={dict.manifestScreen.createStyleHint}
            counter={`${styleNotes.length}/4000`}
          >
            <Textarea
              id="manifest-style"
              rows={5}
              value={styleNotes}
              onChange={(e) => setStyleNotes(e.target.value.slice(0, 4000))}
              placeholder={dict.manifestScreen.createStylePlaceholder}
              disabled={submitting}
            />
          </Field>
          {error && <Alert tone="error">{error}</Alert>}
          <Button block type="submit" loading={submitting}>
            {dict.manifestScreen.createSubmitButton}
          </Button>
          <p className="text-center text-xs text-silver-400">
            {dict.manifestScreen.createFooterNote}
          </p>
        </form>
      </Card>
    </div>
  );
}

// ── Edit ──────────────────────────────────────────────────────────────

function EditScreen({ manifestId }: { manifestId: string }) {
  const { dict, locale } = useI18n();
  const {
    data: manifest,
    setData,
    loading,
    error,
    reload,
  } = useAsync(() => getBrandManifest(manifestId), [manifestId]);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const onDelete = async () => {
    if (!manifest) return;
    const warn =
      manifest.projectCount > 0
        ? pluralForm(
            manifest.projectCount,
            locale,
            dict.manifestScreen.deleteWarnWithProjects
          )
        : dict.manifestScreen.deleteWarnSimple;
    if (!window.confirm(warn)) return;
    setDeleting(true);
    try {
      await deleteBrandManifest(manifestId);
      navigate(routes.manifests(), true);
    } catch (e) {
      setActionError(errorMessage(e));
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} />
      </div>
    );
  }
  if (error || !manifest) {
    return (
      <div>
        <ScreenHeader
          title={dict.manifestScreen.screenTitle}
          back={routes.manifests()}
        />
        <LoadError error={error} onRetry={reload} />
      </div>
    );
  }

  return (
    <div className="animate-fadeIn space-y-4">
      <ScreenHeader
        title={manifest.title}
        back={routes.manifests()}
        hint={
          manifest.projectCount === 0
            ? dict.manifestScreen.notLinkedHint
            : pluralForm(
                manifest.projectCount,
                locale,
                dict.manifestScreen.usedInProjectsHint
              )
        }
        action={
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={14} />}
            onClick={onDelete}
            loading={deleting}
            aria-label={dict.manifestScreen.deleteAriaLabel}
          />
        }
      />

      {actionError && (
        <Alert tone="error" onDismiss={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      <StyleForm
        manifest={manifest}
        onSaved={(m) => setData(m)}
        onError={setActionError}
      />

      <AssetsBlock
        kind="character"
        manifestId={manifest.id}
        items={manifest.characters}
        onChange={(characters) =>
          setData((m) => (m ? { ...m, characters } : m))
        }
        onError={setActionError}
      />

      <AssetsBlock
        kind="scene"
        manifestId={manifest.id}
        items={manifest.scenes ?? []}
        onChange={(scenes) => setData((m) => (m ? { ...m, scenes } : m))}
        onError={setActionError}
      />
    </div>
  );
}

// ── Style form (title / notes / advanced JSON) ────────────────────────

function StyleForm({
  manifest,
  onSaved,
  onError,
}: {
  manifest: BrandManifestView;
  onSaved: (m: BrandManifestView) => void;
  onError: (msg: string | null) => void;
}) {
  const { dict } = useI18n();
  const dub = useFeature('voiceDub');
  const [title, setTitle] = useState(manifest.title);
  const [styleNotes, setStyleNotes] = useState(manifest.styleNotes ?? '');
  const [voiceNotes, setVoiceNotes] = useState(manifest.voiceNotes ?? '');
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(
    // 15.09.2026: умолчание — свой голос; 'veo' здесь заставляло форму
    // нового манифеста сохранять голос модели явно.
    manifest.voiceMode ?? 'voiceover'
  );
  const [ttsVoiceId, setTtsVoiceId] = useState(manifest.ttsVoiceId ?? '');
  const [cameraMove, setCameraMove] = useState<CameraMove>(
    manifest.cameraMove ?? 'none'
  );
  const [subtitlesMode, setSubtitlesMode] = useState<SubtitlesMode>(
    manifest.subtitlesMode ?? 'off'
  );
  const [subtitleTheme, setSubtitleTheme] = useState<SubtitleTheme>(
    manifest.subtitleTheme ?? 'classic'
  );
  const [filters, setFilters] = useState<JsonObject | null>(manifest.filters);
  const [effects, setEffects] = useState<JsonObject | null>(manifest.effects);
  const [jsonValid, setJsonValid] = useState({ filters: true, effects: true });
  const [advanced, setAdvanced] = useState(
    manifest.filters !== null || manifest.effects !== null
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty =
    title.trim() !== manifest.title ||
    (styleNotes.trim() || null) !== (manifest.styleNotes ?? null) ||
    (voiceNotes.trim() || null) !== (manifest.voiceNotes ?? null) ||
    voiceMode !== (manifest.voiceMode ?? 'voiceover') ||
    (ttsVoiceId.trim() || null) !== (manifest.ttsVoiceId ?? null) ||
    cameraMove !== (manifest.cameraMove ?? 'none') ||
    subtitlesMode !== (manifest.subtitlesMode ?? 'off') ||
    subtitleTheme !== (manifest.subtitleTheme ?? 'classic') ||
    JSON.stringify(filters) !== JSON.stringify(manifest.filters) ||
    JSON.stringify(effects) !== JSON.stringify(manifest.effects);
  const canSave =
    dirty && title.trim().length > 0 && jsonValid.filters && jsonValid.effects;

  const onSave = async () => {
    if (!canSave) return;
    setSaving(true);
    onError(null);
    try {
      const m = await updateBrandManifest(manifest.id, {
        title: title.trim(),
        styleNotes: styleNotes.trim() || null,
        voiceNotes: voiceNotes.trim() || null,
        voiceMode,
        ttsVoiceId: ttsVoiceId.trim() || null,
        cameraMove,
        subtitlesMode,
        subtitleTheme,
        filters,
        effects,
      });
      onSaved(m);
      setSavedAt(Date.now());
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setTimeout(() => setSavedAt(null), 2000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  return (
    <Card className="p-5">
      <CardHeader
        title={dict.manifestScreen.styleCardTitle}
        hint={dict.manifestScreen.styleCardHint}
      />
      <div className="space-y-4">
        <Field label={dict.manifestScreen.titleLabel} htmlFor="m-title">
          <Input
            id="m-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            disabled={saving}
          />
        </Field>
        <Field
          label={dict.manifestScreen.styleLabel}
          htmlFor="m-style"
          hint={dict.manifestScreen.styleHintEdit}
          counter={`${styleNotes.length}/4000`}
        >
          <Textarea
            id="m-style"
            rows={5}
            value={styleNotes}
            onChange={(e) => setStyleNotes(e.target.value.slice(0, 4000))}
            placeholder={dict.manifestScreen.stylePlaceholderEdit}
            disabled={saving}
          />
        </Field>
        <Field
          label={dict.manifestScreen.voiceNotesLabel}
          htmlFor="m-voice"
          hint={dict.manifestScreen.voiceNotesHint}
          counter={`${voiceNotes.length}/2000`}
        >
          <Textarea
            id="m-voice"
            rows={3}
            value={voiceNotes}
            onChange={(e) => setVoiceNotes(e.target.value.slice(0, 2000))}
            placeholder={dict.manifestScreen.voiceNotesPlaceholder}
            disabled={saving}
          />
        </Field>

        {/* §15.1: чем озвучивать. Голос — то, по чему узнают серию
            роликов, поэтому он живёт в бренде, а не в настройках сессии. */}
        <Field
          label={dict.manifestScreen.voiceLabel}
          hint={voiceModeHint(voiceMode, dict.voiceMode.hints)}
        >
          <Pills
            value={voiceMode}
            onChange={setVoiceMode}
            disabled={saving}
            columns={3}
            options={[
              {
                value: 'veo' as VoiceMode,
                label: dict.manifestScreen.voiceOptionVeo,
              },
              {
                value: 'voiceover' as VoiceMode,
                label: dict.manifestScreen.voiceOptionVoiceover,
              },
              {
                value: 'dub' as VoiceMode,
                label: dub.allowed ? (
                  dict.manifestScreen.voiceOptionDub
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Lock size={9} /> {dict.manifestScreen.voiceOptionDub}
                  </span>
                ),
                disabled: !dub.allowed,
              },
            ]}
          />
        </Field>

        {voiceMode !== 'veo' && (
          <VoicePicker
            value={ttsVoiceId}
            onChange={setTtsVoiceId}
            disabled={saving}
            voiceProvider={manifest.ttsProvider}
          />
        )}

        {/* §29: движение камеры живёт в бренде рядом со стилем — это
            почерк серии роликов, а не настройка одной генерации. */}
        <Field
          label={dict.manifestScreen.cameraMoveLabel}
          hint={cameraMoveHint(cameraMove, dict.cameraMove.hints)}
        >
          <Pills
            value={cameraMove}
            onChange={setCameraMove}
            disabled={saving}
            columns={2}
            options={cameraMoveOptions(dict.cameraMove.options)}
          />
        </Field>

        {/* Этап 67: жёстко вшитые субтитры живут в бренде по той же
            причине, что и голос с камерой — почерк серии, а не разовая
            настройка. Тема значима, только когда субтитры включены. */}
        <Field label={dict.manifestScreen.subtitlesLabel}>
          <Pills
            value={subtitlesMode}
            onChange={setSubtitlesMode}
            disabled={saving}
            columns={2}
            options={[
              {
                value: 'off' as SubtitlesMode,
                label: dict.manifestScreen.subtitlesOptionOff,
              },
              {
                value: 'on' as SubtitlesMode,
                label: dict.manifestScreen.subtitlesOptionOn,
              },
            ]}
          />
        </Field>

        {subtitlesMode === 'on' && (
          <Field
            label={dict.manifestScreen.subtitleThemeLabel}
            hint={subtitleThemeHint(subtitleTheme, dict.subtitleTheme.hints)}
          >
            <Pills
              value={subtitleTheme}
              onChange={setSubtitleTheme}
              disabled={saving}
              columns={3}
              options={subtitleThemeOptions(dict.subtitleTheme.options)}
            />
          </Field>
        )}

        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="inline-flex min-h-[44px] items-center gap-1 text-xs font-medium text-silver-500 hover:text-accent"
        >
          {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {dict.manifestScreen.advancedToggle}
        </button>

        {advanced && (
          <div className="grid gap-4 sm:grid-cols-2">
            <JsonField
              id="m-filters"
              label={dict.manifestScreen.filtersLabel}
              hint={dict.manifestScreen.filtersHint}
              value={filters}
              disabled={saving}
              onChange={(v, valid) => {
                setFilters(v);
                setJsonValid((s) => ({ ...s, filters: valid }));
              }}
            />
            <JsonField
              id="m-effects"
              label={dict.manifestScreen.effectsLabel}
              hint={dict.manifestScreen.effectsHint}
              value={effects}
              disabled={saving}
              onChange={(v, valid) => {
                setEffects(v);
                setJsonValid((s) => ({ ...s, effects: valid }));
              }}
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-silver-400">
            {savedAt !== null ? (
              <span className="inline-flex items-center gap-1 text-emerald-500">
                <Check size={12} /> {dict.manifestScreen.savedLabel}
              </span>
            ) : dirty ? (
              dict.manifestScreen.unsavedLabel
            ) : (
              ''
            )}
          </span>
          <Button
            size="sm"
            onClick={onSave}
            disabled={!canSave}
            loading={saving}
          >
            {dict.manifestScreen.saveButton}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── Characters and brand scenes — one block, two vocabularies ─────────

type AssetKind = 'character' | 'scene';

interface AssetCopy {
  title: string;
  icon: JSX.Element;
  emptyHint: string;
  countHint: (n: number, withPhoto: number) => string;
  emptyText: string;
  fallbackLabel: (i: number) => string;
  noDescription: string;
  photoMimeError: string;
  deleteConfirm: (label: string) => string;
  deleteAria: string;
  labelField: string;
  labelPlaceholder: string;
  labelRequired: string;
  descPlaceholder: string;
  descHintNew: string;
  api: {
    add: (
      manifestId: string,
      input: CharacterInput & { label: string }
    ) => Promise<BrandCharacterView>;
    update: (
      manifestId: string,
      id: string,
      input: CharacterInput
    ) => Promise<BrandCharacterView>;
    remove: (manifestId: string, id: string) => Promise<void>;
    uploadPhoto: (
      manifestId: string,
      id: string,
      file: File,
      onProgress?: (p: number) => void
    ) => Promise<BrandCharacterView>;
  };
}

/**
 * Копия строится из словаря (этап 56), а не лежит статикой на уровне
 * модуля: она зависит от языка интерфейса, а число со сценами — ещё и от
 * числовых форм текущей локали (см. `pluralForm`).
 */
function getAssetCopy(
  kind: AssetKind,
  dict: Dictionary,
  locale: Locale
): AssetCopy {
  if (kind === 'character') {
    const t = dict.manifestScreen.assets.character;
    return {
      title: t.title,
      icon: <UserRound size={18} className="text-accent" />,
      emptyHint: t.emptyHint,
      countHint: (n, withPhoto) =>
        t.countHint
          .replace('{{n}}', String(n))
          .replace('{{withPhoto}}', String(withPhoto))
          .replace('{{cap}}', String(REFERENCE_IMAGE_CAP)),
      emptyText: t.emptyText,
      fallbackLabel: (i) => t.fallbackLabel.replace('{{n}}', String(i + 1)),
      noDescription: t.noDescription,
      photoMimeError: t.photoMimeError,
      deleteConfirm: (l) => t.deleteConfirm.replace('{{label}}', l),
      deleteAria: t.deleteAria,
      labelField: t.labelField,
      labelPlaceholder: t.labelPlaceholder,
      labelRequired: t.labelRequired,
      descPlaceholder: t.descPlaceholder,
      descHintNew: t.descHintNew,
      api: {
        add: addBrandCharacter,
        update: updateBrandCharacter,
        remove: deleteBrandCharacter,
        uploadPhoto: uploadBrandCharacterPhoto,
      },
    };
  }
  const t = dict.manifestScreen.assets.scene;
  return {
    title: t.title,
    icon: <MapPin size={18} className="text-accent" />,
    emptyHint: t.emptyHint,
    countHint: (n, withPhoto) =>
      pluralForm(n, locale, t.countHint).replace(
        '{{withPhoto}}',
        String(withPhoto)
      ),
    emptyText: t.emptyText,
    fallbackLabel: (i) => t.fallbackLabel.replace('{{n}}', String(i + 1)),
    noDescription: t.noDescription,
    photoMimeError: t.photoMimeError,
    deleteConfirm: (l) => t.deleteConfirm.replace('{{label}}', l),
    deleteAria: t.deleteAria,
    labelField: t.labelField,
    labelPlaceholder: t.labelPlaceholder,
    labelRequired: t.labelRequired,
    descPlaceholder: t.descPlaceholder,
    descHintNew: t.descHintNew,
    api: {
      add: addBrandScene,
      update: updateBrandScene,
      remove: deleteBrandScene,
      uploadPhoto: uploadBrandScenePhoto,
    },
  };
}

function AssetsBlock({
  kind,
  manifestId,
  items,
  onChange,
  onError,
}: {
  kind: AssetKind;
  manifestId: string;
  items: BrandCharacterView[];
  onChange: (items: BrandCharacterView[]) => void;
  onError: (msg: string | null) => void;
}) {
  const { dict, locale } = useI18n();
  const copy = getAssetCopy(kind, dict, locale);
  const [adding, setAdding] = useState(false);
  const withPhoto = items.filter((c) => c.photoUrl).length;

  const replace = (c: BrandCharacterView) =>
    onChange(items.map((x) => (x.id === c.id ? c : x)));

  return (
    <Card className="p-5">
      <CardHeader
        title={copy.title}
        icon={copy.icon}
        hint={
          items.length === 0
            ? copy.emptyHint
            : copy.countHint(items.length, withPhoto)
        }
        action={
          !adding && (
            <Button
              size="sm"
              variant="outline"
              icon={<Plus size={14} />}
              onClick={() => setAdding(true)}
            >
              {dict.manifestScreen.addButton}
            </Button>
          )
        }
      />

      {kind === 'character' && withPhoto > REFERENCE_IMAGE_CAP && (
        <Alert tone="warning" className="mb-3">
          {dict.manifestScreen.capWarning.replace(
            /\{\{cap\}\}/g,
            String(REFERENCE_IMAGE_CAP)
          )}
        </Alert>
      )}

      {adding && (
        <CharacterEditor
          copy={copy}
          onCancel={() => setAdding(false)}
          onSubmit={async (input) => {
            const c = await copy.api.add(manifestId, input);
            onChange([...items, c]);
            setAdding(false);
          }}
          onError={onError}
        />
      )}

      {items.length === 0 && !adding ? (
        <p className="py-4 text-center text-sm text-silver-400">
          {copy.emptyText}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((c, index) => (
            <AssetRow
              key={c.id}
              copy={copy}
              kind={kind}
              asset={c}
              manifestId={manifestId}
              isReferenceImage={
                kind === 'character'
                  ? !!c.photoUrl &&
                    items.filter((x) => x.photoUrl).indexOf(c) <
                      REFERENCE_IMAGE_CAP
                  : !!c.photoUrl
              }
              index={index}
              onUpdated={replace}
              onDeleted={() => onChange(items.filter((x) => x.id !== c.id))}
              onError={onError}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AssetRow({
  copy,
  kind,
  asset: character,
  manifestId,
  isReferenceImage,
  index,
  onUpdated,
  onDeleted,
  onError,
}: {
  copy: AssetCopy;
  /** Слот S4 или S5 для «ИИ-скетча» (doc/AI-SKETCH-SPEC.md §2.1). */
  kind: AssetKind;
  asset: BrandCharacterView;
  manifestId: string;
  isReferenceImage: boolean;
  index: number;
  onUpdated: (c: BrandCharacterView) => void;
  onDeleted: () => void;
  onError: (msg: string | null) => void;
}) {
  const { dict } = useI18n();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'photo' | 'delete' | null>(null);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    if (!PHOTO_MIME.includes(file.type)) {
      onError(copy.photoMimeError);
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      onError(dict.manifestScreen.photoTooLarge);
      return;
    }
    setBusy('photo');
    setProgress(0);
    onError(null);
    try {
      const c = await copy.api.uploadPhoto(
        manifestId,
        character.id,
        file,
        setProgress
      );
      onUpdated(c);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onDelete = async () => {
    if (!window.confirm(copy.deleteConfirm(character.label))) return;
    setBusy('delete');
    try {
      await copy.api.remove(manifestId, character.id);
      onDeleted();
    } catch (e) {
      onError(errorMessage(e));
      setBusy(null);
    }
  };

  if (editing) {
    return (
      <li>
        <CharacterEditor
          copy={copy}
          initial={character}
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            const c = await copy.api.update(manifestId, character.id, input);
            onUpdated(c);
            setEditing(false);
          }}
          onError={onError}
        />
      </li>
    );
  }

  return (
    <li className="flex items-start gap-3 rounded-xl border border-silver-200/70 dark:border-silver-800 p-3">
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy !== null}
        aria-label={
          character.photoUrl
            ? dict.manifestScreen.replacePhotoAria
            : dict.manifestScreen.uploadPhotoAria
        }
        className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-silver-200/60 dark:bg-silver-800/60 grid place-items-center text-silver-400 hover:text-accent disabled:opacity-60"
      >
        {character.photoUrl ? (
          <img
            src={character.photoUrl}
            alt=""
            // Фото слота может смениться на ИИ-скетч (§7.2) — крон
            // UI-снимков не должен считать это регрессом вёрстки.
            data-qa-mask="brand-asset-photo"
            className="h-full w-full object-cover"
          />
        ) : (
          <Camera size={20} />
        )}
        {busy === 'photo' && (
          <span className="absolute inset-0 grid place-items-center bg-silver-950/60 text-[11px] font-mono text-white tabular">
            {progress}%
          </span>
        )}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => void onPhoto(e.target.files?.[0])}
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">
            {character.label || copy.fallbackLabel(index)}
          </span>
          {isReferenceImage ? (
            <Badge tone="accent">
              <ImageIcon size={10} /> {dict.manifestScreen.referenceBadge}
            </Badge>
          ) : character.photoUrl ? (
            <Badge>{dict.manifestScreen.photoAsTextBadge}</Badge>
          ) : (
            <Badge>{dict.manifestScreen.textBadge}</Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-silver-400 line-clamp-2">
          {character.description || copy.noDescription}
        </p>
        {/* ИИ-скетч слотов S4/S5 (doc/AI-SKETCH-SPEC.md §7.2). Оригинал
            бренда разделяемый (со снимками бренда в сессиях), поэтому
            применение и удаление разбирает сервер — экрану достаточно
            обновить свою строку из `slot.url`. */}
        <SketchSlotActions
          className="mt-1.5"
          target={{
            type: kind === 'character' ? 'brand-character' : 'brand-scene',
            id: manifestId,
            subId: character.id,
          }}
          hasImage={!!character.photoUrl}
          originalUrl={character.originalPhotoUrl ?? character.photoUrl}
          activeUrl={character.photoUrl}
          variant={character.photoVariant ?? 'original'}
          activeSketchId={character.activeSketchId ?? null}
          originalDeleted={character.originalDeleted ?? false}
          description={character.description ?? undefined}
          disabled={busy !== null}
          onSlot={(slot) => onUpdated({ ...character, photoUrl: slot.url })}
        />
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label={dict.manifestScreen.editAria}
          onClick={() => setEditing(true)}
          disabled={busy !== null}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-1.5 text-silver-400 hover:bg-silver-200/60 dark:hover:bg-silver-800/60 hover:text-accent disabled:opacity-50"
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          aria-label={copy.deleteAria}
          onClick={() => void onDelete()}
          disabled={busy !== null}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-1.5 text-silver-400 hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
}

function CharacterEditor({
  copy,
  initial,
  onSubmit,
  onCancel,
  onError,
}: {
  copy: AssetCopy;
  initial?: BrandCharacterView;
  onSubmit: (input: {
    label: string;
    description: string | null;
  }) => Promise<void>;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const { dict } = useI18n();
  const [label, setLabel] = useState(initial?.label ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async () => {
    const l = label.trim();
    if (!l) {
      setLocalError(copy.labelRequired);
      return;
    }
    setSaving(true);
    setLocalError(null);
    onError(null);
    try {
      await onSubmit({ label: l, description: description.trim() || null });
    } catch (e) {
      setLocalError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="mb-3 space-y-3 rounded-xl border border-accent/30 bg-accent/5 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label={copy.labelField} htmlFor="char-label" error={localError}>
        <Input
          id="char-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={copy.labelPlaceholder}
          maxLength={80}
          autoFocus
          disabled={saving}
          invalid={!!localError}
        />
      </Field>
      <Field
        label={dict.manifestScreen.descriptionLabel}
        htmlFor="char-desc"
        hint={initial ? dict.manifestScreen.photoHintEdit : copy.descHintNew}
        counter={`${description.length}/2000`}
      >
        <Textarea
          id="char-desc"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
          placeholder={copy.descPlaceholder}
          disabled={saving}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon={<X size={14} />}
          onClick={onCancel}
          disabled={saving}
        >
          {dict.manifestScreen.cancelButton}
        </Button>
        <Button
          type="submit"
          size="sm"
          loading={saving}
          icon={<Check size={14} />}
        >
          {initial
            ? dict.manifestScreen.saveButton
            : dict.manifestScreen.addButton}
        </Button>
      </div>
    </form>
  );
}

/**
 * Числовые формы через `Intl.PluralRules` (этап 56) — так же, как в
 * ManifestsListScreen: у каждого языка словаря свой набор форм
 * (ru/uk — one/few/many, en/de/es — one/other).
 */
function pluralForm(
  n: number,
  locale: Locale,
  forms: Partial<Record<Intl.LDMLPluralRule, string>>
): string {
  const rule = new Intl.PluralRules(locale).select(n);
  const template = forms[rule] ?? forms.other ?? '';
  return template.replace('{{n}}', String(n));
}
