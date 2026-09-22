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

  /**
   * Голос отправителя для озвучки (фича №34 компаньон-ТЗ) — свой клон
   * из `UserVoice`, выбранный ДЛЯ ЭТОЙ СЕССИИ.
   *
   * Живёт в снимке брифа, а не в манифесте бренда, по двум причинам.
   * Первая: у бытового поздравления манифеста нет вовсе (он приходит
   * только с CORPORATE-брифом, §5.4), а голос нужен именно тем, у кого
   * бренда нет. Вторая: манифест — стиль СЕРИИ, он заморожен, чтобы
   * задним числом не менять уже отснятое; голос отправителя же
   * относится к одному поздравлению и от ролика к ролику меняется
   * (записал дед — озвучили дедом, записала мама — мамой).
   *
   * Копия, а не ссылка, тем же принципом, что и всё остальное в
   * снимке: клон можно удалить у себя в кабинете, и ролик, который на
   * него ссылался бы по id, потерял бы озвучку задним числом.
   * `resembleVoiceId` при этом всё равно может протухнуть на стороне
   * Resemble — синтез тогда штатно проваливается в `postprod`
   * (`outcome.ok === false`), а не роняет постобработку.
   */
  senderVoice?: GreetingSenderVoice | null;

  /**
   * Пресетный голос xAI, которым ведущий говорит В КАДРЕ (фича из
   * доп. запроса 22.09.2026, `reference_audios` у Grok).
   *
   * Взаимоисключающе с `senderVoice`: либо реплику произносит модель
   * своим липсинком, либо мы кладём поверх свою дорожку. Оба сразу —
   * это ровно то двоение, от которого уходили.
   *
   * Почему это вообще нужно рядом с №34: наша дорожка никогда не
   * совпадёт с губами — мы накладываем звук на готовую картинку. У
   * модели липсинк настоящий. Взамен теряем клон отправителя (роестр
   * только пресетный), пословное выравнивание для субтитров и
   * гарантию дословности текста.
   */
  presetVoiceId?: string | null;

  /**
   * Музыкальная подложка (фича №4) — копия выбранной темы, не ссылка
   * на каталог.
   *
   * Копия по той же причине, что и у `senderVoice`: каталог правится
   * из админки, и ролик, ссылавшийся на тему по id, после правки
   * каталога тихо поменял бы музыку — или остался бы без неё. Плюс
   * постобработке тогда не нужно читать настройки платформы вовсе.
   */
  musicTheme?: GreetingMusicSelection | null;

  addedAt: string;
}

/**
 * Выбранный голос отправителя — ровно то, что нужно постобработке
 * (`resembleVoiceId`), плюс то, что нужно экрану (`label`), плюс id
 * записи, чтобы фронтенд мог отметить выбранный элемент в списке
 * клонов, не сравнивая строки провайдера.
 */
export interface GreetingSenderVoice {
  userVoiceId: string;
  resembleVoiceId: string;
  label: string;
}

/**
 * GET/PATCH /sessions/:id/greeting-voice — весь выбор голоса разом.
 *
 * Два поля, а не одно перечисление, потому что источники разные (свой
 * клон против роестра xAI), но заняты они быть могут только по
 * очереди: сервис при записи одного гасит другой.
 */
export interface GreetingMusicTheme {
  id: string;
  title: string;
  /** Публичный URL файла. Только https: ссылка уходит ffmpeg-сервису. */
  url: string;
  /**
   * Поводы, которым тема подходит. `null` — подходит любому.
   *
   * Смысл поля ровно один: у соболезнования и дня рождения не может
   * быть общей подложки ни при каком тоне — тот же довод, по которому
   * декорации сцены приходят от повода, а не от тона
   * (`GREETING_OCCASION_SPECS`).
   */
  occasions: GreetingOccasion[] | null;
}

/** Копия выбранной темы в снимке брифа — см. `GreetingBriefSnapshot.musicTheme`. */
export interface GreetingMusicSelection {
  id: string;
  title: string;
  url: string;
  /**
   * Откуда трек: `catalog` — тема из каталога платформы, `upload` —
   * файл, который загрузил сам пользователь, `link` — его же ссылка
   * на чужой хост (файла у нас нет, удалять нечего).
   *
   * Отличать важно по двум причинам. Первая: за свой файл права
   * подтвердил пользователь (`rightsConfirmedAt`), за каталог —
   * владелец продукта; при разборе претензии это разные разговоры.
   * Вторая: загруженный файл живёт под префиксом сессии и удаляется
   * вместе с ней (`common/blob-paths.ts`), каталожный — нет.
   *
   * Отсутствие поля читается как `catalog`: так выглядят записи до
   * появления загрузки.
   */
  source?: 'catalog' | 'upload' | 'link';
  /** Путь в хранилище — только у загруженных, для уборки. */
  pathname?: string;
  /** Когда пользователь подтвердил права на этот файл. */
  rightsConfirmedAt?: string;
}

/** Выбор музыкальной темы — то, что видит экран мастера. */
export interface GreetingMusicView {
  /** Темы, подходящие поводу сессии; пусто — каталог не наполнен. */
  themes: GreetingMusicTheme[];
  selected: GreetingMusicSelection | null;
}

export interface GreetingVoiceView {
  senderVoice: GreetingSenderVoice | null;
  presetVoiceId: string | null;
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
