/**
 * Greeting Types — GREETING_VIDEO project type (ТЗ
 * TZ-Greeting-Video-Project-Type.md §3.2, §7).
 *
 * Mirrors the Prisma enums `GreetingOccasion`/`GreetingTone` by hand
 * (same reason as `ProjectType` in project.types.ts: this file type-checks
 * even where `prisma generate` hasn't run, see doc/TELEGRAM-ADMIN.md §5).
 * Keep in sync with `prisma/schema.prisma` — see the doc-comment on
 * `ProjectType` above for the risk of these two sources of truth diverging.
 */

/**
 * Этап 2 (фича №1 компаньон-ТЗ): семь поводов стали двадцатью четырьмя.
 * Порядок в `GREETING_OCCASIONS` — это порядок выпадающего списка в
 * визарде: сперва частые праздничные, затем семейные и рабочие, в конце
 * чувствительные и «другой повод». Алфавит здесь был бы хуже: он
 * поставил бы соболезнование между свадьбой и новосельем.
 *
 * Что каждый повод означает для промпта и какие тоны у него допустимы —
 * в `common/greeting-occasions.ts`, единственном источнике правды.
 */
export type GreetingOccasion =
  | 'BIRTHDAY'
  | 'WEDDING'
  | 'ANNIVERSARY'
  | 'NEW_YEAR'
  | 'CHRISTMAS'
  | 'GRADUATION'
  | 'VALENTINES_DAY'
  | 'WOMENS_DAY'
  | 'MOTHERS_DAY'
  | 'FATHERS_DAY'
  | 'DEFENDERS_DAY'
  | 'TEACHERS_DAY'
  | 'FIRST_SCHOOL_DAY'
  | 'NEW_BABY'
  | 'BAPTISM'
  | 'HOUSEWARMING'
  | 'PROMOTION'
  | 'RETIREMENT'
  | 'FAREWELL_COLLEAGUE'
  | 'CORPORATE'
  | 'APOLOGY'
  | 'GET_WELL'
  | 'CONDOLENCE'
  | 'OTHER';

export const GREETING_OCCASIONS: readonly GreetingOccasion[] = [
  'BIRTHDAY',
  'WEDDING',
  'ANNIVERSARY',
  'NEW_YEAR',
  'CHRISTMAS',
  'GRADUATION',
  'VALENTINES_DAY',
  'WOMENS_DAY',
  'MOTHERS_DAY',
  'FATHERS_DAY',
  'DEFENDERS_DAY',
  'TEACHERS_DAY',
  'FIRST_SCHOOL_DAY',
  'NEW_BABY',
  'BAPTISM',
  'HOUSEWARMING',
  'PROMOTION',
  'RETIREMENT',
  'FAREWELL_COLLEAGUE',
  'CORPORATE',
  'APOLOGY',
  'GET_WELL',
  'CONDOLENCE',
  'OTHER',
];

/**
 * Этап 2 (фича №3): два новых тона для чувствительных поводов. Не
 * «ещё два варианта на выбор»: `SUPPORTIVE`/`RESPECTFUL` доступны
 * только там, где их разрешает `greeting-occasions.ts`, а `FUNNY` там
 * наоборот запрещён — и проверяется это на сервере, не в интерфейсе.
 */
export type GreetingTone =
  | 'WARM'
  | 'FUNNY'
  | 'FORMAL'
  | 'SUPPORTIVE'
  | 'RESPECTFUL';

export const GREETING_TONES: readonly GreetingTone[] = [
  'WARM',
  'FUNNY',
  'FORMAL',
  'SUPPORTIVE',
  'RESPECTFUL',
];

/**
 * Кто в кадре (§5.3): 'grok' — референс-кадр + image-to-video без
 * лип-синка, голос закадровый; 'hedra' — говорящий аватар с лип-синком,
 * доступен только на PREMIUM (§7).
 */
export type GreetingPresenterProvider = 'grok' | 'hedra';

export const GREETING_PRESENTER_PROVIDERS: readonly GreetingPresenterProvider[] =
  ['grok', 'hedra'];

/**
 * Пересечение словарей GrokResolution ('480p'|'720p'|'1080p') и
 * HedraClientService/GenerateAvatarRequestDto ('540p'|'720p'|'1080p') —
 * ровно то же, на чём сходятся оба провайдера (§11.3 ТЗ: конфликта
 * словарей нет ни в одной комбинации тариф×провайдер таблицы §7). '480p'
 * встречается только на grok-пути (LITE), где hedra недоступна в принципе.
 */
export type GreetingResolution = '480p' | '720p' | '1080p';

export const GREETING_RESOLUTIONS: readonly GreetingResolution[] = [
  '480p',
  '720p',
  '1080p',
];

/**
 * GreetingBrief → Session.greetingBriefSnapshot (§3.2 «копия, не
 * ссылка» — тот же принцип, что ProductInformation/BrandManifestSnapshot,
 * см. project-session/snapshot.ts doc-comment). `resolvedPresenterProvider`/
 * `resolvedResolution` — то, что реально применяется ПОСЛЕ проверки
 * тарифа (§7 `resolveGreetingConfig`), может отличаться от того, что
 * попросил пользователь (`requestedPresenterProvider`/`requestedResolution`
 * пишутся как есть, для истории/отладки, но пайплайн генерации обязан
 * читать ТОЛЬКО resolved*-поля).
 */
export interface GreetingBriefSnapshot {
  sourceGreetingBriefId: string;

  occasion: GreetingOccasion;
  customOccasionText: string | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  /** Пусто, если пользователь не задал текст — сценарий ещё предстоит
   * сгенерировать (§5.2, PromptService/GreetingPromptService). */
  personalMessage: string | null;

  requestedPresenterProvider: GreetingPresenterProvider;
  resolvedPresenterProvider: GreetingPresenterProvider;
  requestedResolution: GreetingResolution;
  resolvedResolution: GreetingResolution;

  /** Копия снимка манифеста бренда, когда CORPORATE-бриф его указал
   * (§5.4) — то же поле `Session.brandManifestSnapshot`, отдельно не
   * дублируется здесь: `ProjectSessionService.createFromGreetingBrief`
   * заполняет оба поля сессии из одного `BrandManifest`. */
  brandManifestId: string | null;

  occasionDate: string | null;

  addedAt: string;
}

/**
 * GET/PATCH /sessions/:id/greeting-references response shape — reference
 * image for Grok reference-to-video, ACTIVE image already resolved
 * (original vs applied sketch, `common/active-image.ts`), same shape the
 * frontend already gets for scenes via `ReferenceCandidate`
 * (`thumbnailUrl`/`originalThumbnailUrl`/`variant`) — see
 * `GreetingReferenceService.toView`.
 */
export interface GreetingReferenceImageView {
  id: string;
  label: string;
  description: string | null;
  /** Активное изображение — оригинал или применённый скетч. */
  photoUrl: string;
  variant: 'original' | 'sketch';
  /** Оригинал — для сравнения «до/после»; `null`, если он удалён. */
  originalPhotoUrl: string | null;
  originalDeleted: boolean;
  createdAt: string;
}

/** GET/PATCH /projects/:id/greeting-brief response shape (§8 ТЗ). */
export interface GreetingBriefView {
  id: string;
  projectId: string;
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: GreetingPresenterProvider;
  resolution: GreetingResolution;
  brandManifestId: string | null;
  occasionDate: string | null;
  createdAt: string;
  updatedAt: string;
}

