/**
 * CharacterCasting — spec §10 "Экран — фильтры/группы персонажей" +
 * "Форма подгрузки нового персонажа (справа)". Sits on the analysis step
 * above the scene breakdown.
 *
 * Top: one chip per character Gemini found (VideoAnalysis.characters).
 * Click = toggle "active" (stays in the generated video), multi-select;
 * an active chip AND that character's description below light up in the
 * same colour. Below: the descriptions. Right (below on phones): for the
 * currently focused active character, three ways to swap in your own
 * person — photo ("новый скин"), text (pre-filled from the current
 * project's product), or a saved brand character from the manifest copy
 * (§12) — or leave it as Gemini saw it.
 *
 * Every change is PUT to /sessions/:id/characters right away; the server
 * recomputes the activation order that decides which three photos become
 * Veo referenceImages (§10.3) — the counter here mirrors that rule.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n-context';
import {
  Camera,
  Check,
  ImageIcon,
  Lock,
  Palette,
  Type as TypeIcon,
  UserRound,
  Users,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  LockedNote,
  Spinner,
  Tabs,
  Textarea,
} from '../../components/ui';
import { useFeature } from '../../lib/plan-context';
import {
  errorMessage,
  getCasting,
  addCharacterFromSessionCast,
  generateCharacterPreview,
  promotePreviewToPhoto,
  putCasting,
  uploadCastPhoto,
  type CastInput,
} from '../../services/projects-api';
import type {
  AnalysisCharacter,
  BrandCharacterSnapshot,
  BrandManifestSnapshot,
  CastReplacementKind,
  CharacterCast,
  CharacterCasting as Casting,
} from '../../types';
import type { HighlightFocus } from './SceneCasting';
import {
  characterColor,
  defaultCasting,
  defaultTextFor,
  photoSlots,
  REFERENCE_IMAGE_CAP,
  toggleActive,
  withReplacement,
} from '../../lib/casting';

const PHOTO_MIME = ['image/png', 'image/jpeg'];
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export function CharacterCasting({
  sessionId,
  characters,
  brandManifest,
  productName,
  productDescription,
  previewsStatus = 'idle',
  onHighlight,
}: {
  sessionId: string;
  characters: AnalysisCharacter[];
  brandManifest: BrandManifestSnapshot | null;
  productName: string | null;
  productDescription: string | null;
  /** Spec §18.1: real frames from the uploaded file replace the generic avatars. */
  previewsStatus?: 'idle' | 'capturing' | 'done' | 'unavailable';
  /**
   * Spec §19: выбранный персонаж подсвечивается в тексте разбора — тот же
   * механизм, что у сцен и массовки. Передаётся наверх, в мастер.
   */
  onHighlight?: (focus: HighlightFocus | null) => void;
}) {
  const { dict } = useI18n();
  const prominenceLabel: Record<AnalysisCharacter['prominence'], string> = {
    main: dict.characterCasting.prominence.main,
    secondary: dict.characterCasting.prominence.secondary,
    background: dict.characterCasting.prominence.background,
  };
  const [casts, setCasts] = useState<CharacterCast[] | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getCasting(sessionId)
      .then(async (c) => {
        // First visit: everyone stays in by default — persist that so the
        // generation step (Stage 15) sees an explicit casting, not "none".
        if (c.casts.length === 0 && characters.length > 0) {
          const saved = await putCasting(sessionId, defaultCasting(characters));
          if (alive) setCasts(saved.casts);
          return;
        }
        if (alive) setCasts(c.casts);
      })
      .catch((e) => {
        if (alive) {
          setCasts([]);
          setError(errorMessage(e));
        }
      });
    return () => {
      alive = false;
    };
    // `characters` is fixed for a given analysis; re-running on its identity
    // would re-PUT the default casting on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const persist = async (next: CastInput[]) => {
    setSaving(true);
    setError(null);
    try {
      const saved: Casting = await putCasting(sessionId, next);
      setCasts(saved.casts);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const castOf = (id: string) => casts?.find((c) => c.characterId === id);

  /**
   * Spec §19: тот же жест, что у сцен и массовки — выбранный персонаж
   * подсвечивает свои строки в разборе. Повторный клик снимает фильтр.
   */
  const focusCharacter = (id: string | null) => {
    setFocused(id);
    if (!onHighlight) return;
    const ch = id ? characters.find((c) => c.id === id) : null;
    onHighlight(
      ch
        ? {
            kind: 'character',
            id: ch.id,
            label: ch.label,
            terms: [ch.label, ch.role ?? '', ch.appearance].filter(Boolean),
            exact: [],
          }
        : null
    );
  };

  const onToggle = (id: string) => {
    if (!casts) return;
    const next = toggleActive(casts, id);
    const nowActive = next.find((c) => c.characterId === id)?.active;
    focusCharacter(nowActive ? id : focused === id ? null : focused);
    void persist(next);
  };

  const onReplace = (
    id: string,
    kind: CastReplacementKind,
    extra: Partial<CastInput['replacement']> = {}
  ) => {
    if (!casts) return;
    void persist(withReplacement(casts, id, { kind, ...extra }));
  };

  const activeCount = casts?.filter((c) => c.active).length ?? 0;
  const slots = useMemo(() => (casts ? photoSlots(casts) : new Set()), [casts]);
  const photoCount =
    casts?.filter((c) => c.active && c.replacement.photoUrl).length ?? 0;

  const focusedCharacter = characters.find((c) => c.id === focused) ?? null;
  const focusedCast = focused ? castOf(focused) : undefined;

  if (casts === null) {
    return (
      <Card className="p-5">
        <div className="flex justify-center py-6">
          <Spinner size={24} />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Users size={18} className="text-accent" />}
        title={dict.characterCasting.title}
        hint={
          characters.length === 0
            ? dict.characterCasting.hintEmpty
            : dict.characterCasting.hintCount
                .replace('{{active}}', String(activeCount))
                .replace('{{total}}', String(characters.length))
                .replace('{{photos}}', String(photoCount))
                .replace('{{cap}}', String(REFERENCE_IMAGE_CAP))
        }
        action={saving ? <Spinner size={16} /> : undefined}
      />

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {characters.length > 0 && (
        <>
          {/* ── chips ── */}
          <div className="mb-4 flex flex-wrap gap-2">
            {characters.map((ch, i) => {
              const cast = castOf(ch.id);
              const active = !!cast?.active;
              const color = characterColor(i);
              return (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => onToggle(ch.id)}
                  disabled={saving}
                  aria-pressed={active}
                  className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-60 ${
                    active
                      ? `${color.chip} border-transparent shadow-sm`
                      : 'border-silver-300 text-silver-500 hover:border-accent dark:border-silver-700'
                  } ${focused === ch.id && active ? `ring-2 ${color.ring}` : ''}`}
                >
                  {ch.previewUrl ? (
                    <img
                      src={ch.previewUrl}
                      alt=""
                      className={`-ml-1.5 h-5 w-5 rounded-full object-cover ${active ? '' : 'grayscale'}`}
                    />
                  ) : (
                    <span
                      className={`h-2 w-2 rounded-full ${active ? 'bg-current' : color.dot}`}
                    />
                  )}
                  {ch.label}
                  {active && cast?.replacement.kind !== 'none' && (
                    <ReplacementGlyph kind={cast!.replacement.kind} />
                  )}
                </button>
              );
            })}
          </div>

          {photoCount > REFERENCE_IMAGE_CAP && (
            <Alert tone="warning" className="mb-3">
              {dict.characterCasting.photoCapWarning.replace(
                '{{cap}}',
                String(REFERENCE_IMAGE_CAP)
              )}
            </Alert>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
            {/* ── descriptions ── */}
            <ul className="min-w-0 space-y-2">
              {characters.map((ch, i) => {
                const cast = castOf(ch.id);
                const active = !!cast?.active;
                const color = characterColor(i);
                return (
                  <li
                    key={ch.id}
                    onClick={() =>
                      active && focusCharacter(focused === ch.id ? null : ch.id)
                    }
                    className={`rounded-xl border-l-4 px-3 py-2 text-xs transition-colors ${
                      active
                        ? `${color.bar} ${color.tint} cursor-pointer`
                        : 'border-silver-200 text-silver-400 dark:border-silver-800'
                    } ${focused === ch.id && active ? `ring-1 ${color.ring}` : ''}`}
                  >
                    <div className="flex gap-3">
                      <div
                        className={`relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-silver-200/60 dark:bg-silver-800/60 ${active ? '' : 'opacity-50 grayscale'}`}
                      >
                        {ch.previewUrl ? (
                          <img
                            src={ch.previewUrl}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="grid h-full place-items-center text-silver-400">
                            {previewsStatus === 'capturing' ? (
                              <Spinner size={14} />
                            ) : (
                              <UserRound size={18} />
                            )}
                          </div>
                        )}
                        {typeof ch.previewAt === 'number' && (
                          <span className="absolute bottom-0.5 right-0.5 rounded bg-silver-950/70 px-1 font-mono text-[11px] text-white tabular">
                            {Math.floor(ch.previewAt / 60)}:
                            {String(Math.floor(ch.previewAt % 60)).padStart(
                              2,
                              '0'
                            )}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`font-semibold ${active ? '' : 'line-through decoration-silver-400/60'}`}
                          >
                            {ch.label}
                          </span>
                          {ch.role && <Badge>{ch.role}</Badge>}
                          <Badge
                            tone={
                              ch.prominence === 'main' ? 'accent' : 'neutral'
                            }
                          >
                            {prominenceLabel[ch.prominence]}
                          </Badge>
                          {active && cast?.replacement.kind !== 'none' && (
                            <Badge tone="success">
                              <ReplacementGlyph kind={cast!.replacement.kind} />{' '}
                              {cast!.replacement.kind === 'brand'
                                ? (cast!.replacement.label ??
                                  dict.characterCasting.badge.brandDefault)
                                : cast!.replacement.kind === 'photo'
                                  ? slots.has(ch.id)
                                    ? dict.characterCasting.badge.photoReference
                                    : dict.characterCasting.badge.photoText
                                  : dict.characterCasting.badge.customText}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 leading-relaxed">{ch.appearance}</p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* ── replacement form ── */}
            <div className="min-w-0">
              {focusedCharacter && focusedCast?.active ? (
                <ReplacementForm
                  key={focusedCharacter.id}
                  sessionId={sessionId}
                  character={focusedCharacter}
                  cast={focusedCast}
                  color={characterColor(characters.indexOf(focusedCharacter))}
                  brandCharacters={brandManifest?.characters ?? []}
                  brandManifestId={brandManifest?.brandManifestId ?? null}
                  productName={productName}
                  productDescription={productDescription}
                  saving={saving}
                  onKind={(kind, extra) =>
                    onReplace(focusedCharacter.id, kind, extra)
                  }
                  onUploaded={(c) => setCasts(c.casts)}
                  onError={setError}
                />
              ) : (
                <div className="rounded-xl border border-dashed border-silver-300 p-4 text-center text-xs text-silver-400 dark:border-silver-700">
                  <UserRound size={22} className="mx-auto mb-1 opacity-60" />
                  {dict.characterCasting.emptyFormHint}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function ReplacementGlyph({ kind }: { kind: CastReplacementKind }) {
  if (kind === 'photo') return <Camera size={11} />;
  if (kind === 'brand') return <Palette size={11} />;
  if (kind === 'text') return <TypeIcon size={11} />;
  return null;
}

// ── Right-hand form ─────────────────────────────────────────────────────

type FormTab = 'none' | 'photo' | 'text' | 'brand';

function ReplacementForm({
  sessionId,
  character,
  cast,
  color,
  brandCharacters,
  brandManifestId,
  productName,
  productDescription,
  saving,
  onKind,
  onUploaded,
  onError,
}: {
  sessionId: string;
  character: AnalysisCharacter;
  cast: CharacterCast;
  color: ReturnType<typeof characterColor>;
  brandCharacters: BrandCharacterSnapshot[];
  /** Доп. запрос владельца продукта — нужен для кнопки «Сохранить в
   * брендбук»; `null`, если у сессии нет брендбука вовсе (кнопка тогда
   * не показывается). */
  brandManifestId: string | null;
  productName: string | null;
  productDescription: string | null;
  saving: boolean;
  onKind: (
    kind: CastReplacementKind,
    extra?: Partial<CastInput['replacement']>
  ) => void;
  onUploaded: (c: Casting) => void;
  onError: (msg: string | null) => void;
}) {
  const { dict } = useI18n();
  // ТЗ §23: замена персонажа СВОИМ фото — возможность старших режимов.
  // «Как есть», текстовое описание и персонаж бренда работают везде.
  const photoFeature = useFeature('characterReplacement');
  const [tab, setTab] = useState<FormTab>(cast.replacement.kind);
  const [text, setText] = useState(
    cast.replacement.kind === 'text' && cast.replacement.description
      ? cast.replacement.description
      : defaultTextFor(character, productName, productDescription, {
          holdsProduct: dict.casting.holdsProductTemplate,
        })
  );
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // Доп. запрос владельца продукта: сохранить эту замену (фото/текст)
  // постоянным персонажем бренда — не повторять её вручную в каждой
  // новой сессии того же бренда.
  const [savingToBrand, setSavingToBrand] = useState(false);
  const [savedToBrandNote, setSavedToBrandNote] = useState<string | null>(null);

  const saveToBrand = async () => {
    if (!brandManifestId) return;
    setSavingToBrand(true);
    setSavedToBrandNote(null);
    try {
      await addCharacterFromSessionCast(brandManifestId, {
        label: character.label,
        description: cast.replacement.description,
        photoPathname: cast.replacement.photoPathname,
      });
      setSavedToBrandNote(dict.characterCasting.savedToBrand);
    } catch (e) {
      setSavedToBrandNote(errorMessage(e));
    } finally {
      setSavingToBrand(false);
    }
  };

  // Доп. запрос владельца продукта: статичное превью персонажа из
  // текстового описания — по двойному клику на поле описания, ещё до
  // того, как оно сохранено кнопкой ниже. Не становится референсом
  // автоматически — только показать пользователю, как модель может
  // понять словесное описание.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPathname, setPreviewPathname] = useState<string | null>(null);
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewQuota, setPreviewQuota] = useState<string | null>(null);
  const [usingAsPhoto, setUsingAsPhoto] = useState(false);

  const generatePreview = async () => {
    // Превью существует ради «использовать как фото» — это замена
    // персонажа, режим Standard+ (§6.8 doc/AI-SKETCH-SPEC.md). На младшем
    // режиме двойной клик ничего не тратит и не шлёт запрос.
    if (!text.trim() || generatingPreview || !photoFeature.allowed) return;
    setGeneratingPreview(true);
    setPreviewNote(null);
    setPreviewUrl(null);
    setPreviewPathname(null);
    try {
      const { url, pathname, dayUsed, dayLimit } =
        await generateCharacterPreview(sessionId, character.id, text.trim());
      setPreviewQuota(
        dict.characterCasting.previewQuota
          .replace('{{left}}', String(Math.max(0, dayLimit - dayUsed)))
          .replace('{{limit}}', String(dayLimit))
      );
      if (url && pathname) {
        setPreviewUrl(url);
        setPreviewPathname(pathname);
      } else {
        setPreviewNote(dict.characterCasting.previewFailed);
      }
    } catch (e) {
      setPreviewNote(errorMessage(e));
    } finally {
      setGeneratingPreview(false);
    }
  };

  // Доп. запрос владельца продукта: продвинуть уже сгенерированное
  // превью до статуса настоящего фото персонажа — дальше оно
  // используется как обычная загруженная фотография (референс для
  // Veo/Grok), не только превью для самого пользователя. Названа без
  // префикса `use` намеренно — см. доккомментарий `promotePreviewToPhoto`
  // в `projects-api.ts`.
  const applyPreviewAsPhoto = async () => {
    if (!previewPathname || usingAsPhoto) return;
    setUsingAsPhoto(true);
    setPreviewNote(null);
    try {
      const c = await promotePreviewToPhoto(
        sessionId,
        character.id,
        previewPathname,
        text.trim() || null
      );
      onUploaded(c);
      setPreviewUrl(null);
      setPreviewPathname(null);
    } catch (e) {
      setPreviewNote(errorMessage(e));
    } finally {
      setUsingAsPhoto(false);
    }
  };

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    if (!PHOTO_MIME.includes(file.type)) {
      onError(dict.characterCasting.photoTypeError);
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      onError(dict.characterCasting.photoSizeError);
      return;
    }
    setUploading(true);
    setProgress(0);
    onError(null);
    try {
      const c = await uploadCastPhoto(
        sessionId,
        character.id,
        file,
        cast.replacement.description,
        setProgress
      );
      onUploaded(c);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const tabs: { value: FormTab; label: ReactNode }[] = [
    { value: 'none', label: dict.characterCasting.tabNone },
    {
      value: 'photo',
      label: photoFeature.allowed ? (
        dict.characterCasting.tabPhoto
      ) : (
        <span className="inline-flex items-center gap-1">
          <Lock size={10} /> {dict.characterCasting.tabPhoto}
        </span>
      ),
    },
    { value: 'text', label: dict.characterCasting.tabText },
    ...(brandCharacters.length > 0
      ? [{ value: 'brand' as const, label: dict.characterCasting.tabBrand }]
      : []),
  ];

  return (
    <div
      className={`rounded-xl border p-3 ${color.ring.replace('ring-', 'border-')}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${color.dot}`} />
        <span className="text-sm font-semibold">{character.label}</span>
        <span className="text-[11px] text-silver-400">
          {dict.characterCasting.orderLabel.replace(
            '{{order}}',
            String(cast.order)
          )}
        </span>
      </div>

      <Tabs
        value={tab}
        onChange={(v) => {
          setTab(v);
          if (v === 'none') onKind('none');
        }}
        disabled={saving || uploading}
        tabs={tabs}
        compact
      />

      {tab === 'none' && (
        <p className="text-xs text-silver-400">
          {dict.characterCasting.noneHint}
        </p>
      )}

      {tab === 'photo' && !photoFeature.allowed && !photoFeature.loading && (
        <LockedNote
          title={dict.characterCasting.photoLockedTitle}
          lock={photoFeature.lock}
          compact
        >
          {dict.characterCasting.photoLockedBody}
        </LockedNote>
      )}

      {tab === 'photo' && photoFeature.allowed && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || saving}
            className="relative flex w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-silver-300 px-3 py-4 text-xs text-silver-500 hover:border-accent disabled:opacity-60 dark:border-silver-700"
          >
            {cast.replacement.kind === 'photo' && cast.replacement.photoUrl ? (
              <img
                src={cast.replacement.photoUrl}
                alt=""
                className="h-24 w-24 rounded-lg object-cover"
              />
            ) : (
              <Camera size={22} className="text-silver-400" />
            )}
            <span>
              {cast.replacement.kind === 'photo'
                ? dict.characterCasting.photoReplaceCta
                : dict.characterCasting.photoUploadCta}
            </span>
            <span className="text-[11px] text-silver-400">
              {dict.characterCasting.photoHint}
            </span>
            {uploading && (
              <span className="absolute inset-0 grid place-items-center rounded-xl bg-silver-950/60 font-mono text-xs text-white tabular">
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
        </div>
      )}

      {tab === 'text' && (
        <div className="space-y-2">
          <Field
            label={dict.characterCasting.textFieldLabel}
            htmlFor={`cast-text-${character.id}`}
            hint={dict.characterCasting.textFieldHint}
            counter={`${text.length}/2000`}
          >
            <Textarea
              id={`cast-text-${character.id}`}
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 2000))}
              onDoubleClick={() => void generatePreview()}
              disabled={saving}
            />
          </Field>
          {generatingPreview && (
            <p className="text-xs text-silver-400">
              {dict.characterCasting.previewGenerating}
            </p>
          )}
          {previewUrl && (
            <div className="flex items-start gap-2">
              <img
                src={previewUrl}
                alt=""
                className="h-40 w-32 rounded-lg border border-silver-200 object-cover dark:border-silver-800"
              />
              <Button
                variant="outline"
                size="sm"
                loading={usingAsPhoto}
                disabled={usingAsPhoto}
                onClick={() => void applyPreviewAsPhoto()}
              >
                {dict.characterCasting.useAsPhotoButton}
              </Button>
            </div>
          )}
          {previewNote && (
            <p className="text-xs text-silver-400">{previewNote}</p>
          )}
          {previewQuota && (
            <p className="text-xs text-silver-500">{previewQuota}</p>
          )}
          <Button
            size="sm"
            block
            icon={<Check size={14} />}
            disabled={
              saving ||
              !text.trim() ||
              (cast.replacement.kind === 'text' &&
                cast.replacement.description === text.trim())
            }
            onClick={() => onKind('text', { description: text.trim() })}
          >
            {cast.replacement.kind === 'text'
              ? dict.characterCasting.textUpdateCta
              : dict.characterCasting.textApplyCta}
          </Button>
        </div>
      )}

      {tab === 'brand' && (
        <ul className="space-y-1.5">
          {brandCharacters.map((b, i) => {
            const chosen =
              cast.replacement.kind === 'brand' &&
              (cast.replacement.brandCharacterId === b.sourceCharacterId ||
                (cast.replacement.photoUrl !== null &&
                  cast.replacement.photoUrl === b.photoUrl) ||
                (b.photoUrl === null &&
                  cast.replacement.description === b.description &&
                  cast.replacement.label === b.label));
            return (
              <li key={b.sourceCharacterId ?? `adhoc-${i}`}>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    onKind('brand', {
                      photoUrl: b.photoUrl,
                      description: b.description,
                      brandCharacterId: b.sourceCharacterId,
                      label: b.label,
                    })
                  }
                  className={`flex w-full items-center gap-2 rounded-lg border p-2 text-left text-xs transition-colors ${
                    chosen
                      ? 'border-accent bg-accent/10'
                      : 'border-silver-200/70 hover:border-accent dark:border-silver-800'
                  }`}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md bg-silver-200/60 text-silver-400 dark:bg-silver-800/60">
                    {b.photoUrl ? (
                      <img
                        src={b.photoUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ImageIcon size={14} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {b.label}
                    </span>
                    <span className="block truncate text-silver-400">
                      {b.description ??
                        (b.photoUrl ? dict.characterCasting.photoOnly : '')}
                    </span>
                  </span>
                  {chosen && (
                    <Check size={14} className="shrink-0 text-accent" />
                  )}
                </button>
              </li>
            );
          })}
          <li className="pt-1 text-[11px] text-silver-400">
            {dict.characterCasting.brandPhotoNote}
          </li>
        </ul>
      )}

      {/* Доп. запрос владельца продукта: сохранить эту замену
          (фото/текст) постоянным персонажем бренда. Не показывается
          для kind 'brand' — такая замена уже ссылается на существующего
          персонажа бренда, сохранять нечего. */}
      {brandManifestId &&
        (cast.replacement.kind === 'photo' ||
          cast.replacement.kind === 'text') && (
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              loading={savingToBrand}
              disabled={saving || savingToBrand}
              onClick={() => void saveToBrand()}
            >
              {dict.characterCasting.saveToBrandButton}
            </Button>
            {savedToBrandNote && (
              <span className="text-xs text-silver-500">
                {savedToBrandNote}
              </span>
            )}
          </div>
        )}
    </div>
  );
}
