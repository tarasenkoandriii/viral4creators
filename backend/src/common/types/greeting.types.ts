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

import type { SupportedLocale } from '../locale';

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

/**
 * Потолок длины «своего» повода (`customOccasionText`) — одна константа
 * для обоих DTO (создание и правка брифа). Фронтенд держит зеркало с тем
 * же именем в `frontend/src/types/project.ts`; раньше там стояло 120,
 * здесь 200 (Г-11 ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md).
 */
export const MAX_CUSTOM_OCCASION_LENGTH = 200;

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
 * Регистр повода — его класс по настроению (этап B ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.2).
 *
 * Зеркало Prisma-енума `GreetingRegister`. Порядок в
 * `GREETING_REGISTERS` — порядок СТРОГОСТИ, от праздничного к
 * траурному, и он значим: проверки «Особого повода» могут только поднять
 * регистр по этому списку, но никогда не опустить (`stricterRegister`).
 */
export type GreetingRegister =
  | 'CELEBRATORY'
  | 'WARM_NEUTRAL'
  | 'SOLEMN'
  | 'SENSITIVE'
  | 'MOURNING';

export const GREETING_REGISTERS: readonly GreetingRegister[] = [
  'CELEBRATORY',
  'WARM_NEUTRAL',
  'SOLEMN',
  'SENSITIVE',
  'MOURNING',
];

/** Откуда взялся регистр «Особого повода». */
export type GreetingRegisterSource =
  | 'user'
  | 'keywords'
  | 'classifier'
  | 'default';

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
 * «Кто в кадре» (этап G, ТЗ Greeting 2.0 §4.8): ИИ-ведущий или образ
 * персоны автора — фотографией или скетч-аватаром. Отдельно от
 * `GreetingPresenterProvider`: провайдер решает, КАК снимать (Grok или
 * говорящий аватар Hedra), а это — КОГО.
 */
export const GREETING_PRESENTER_VARIANTS = ['photo', 'sketch'] as const;
export type GreetingPresenterVariant =
  (typeof GREETING_PRESENTER_VARIANTS)[number];

export type GreetingPresenterChoice =
  | { kind: 'ai' }
  | { kind: 'persona'; lookId: string; variant: GreetingPresenterVariant };

/**
 * Образ ведущего, СКОПИРОВАННЫЙ в снимок сессии (§4.8): удаление образа
 * или его скетча не ломает уже снятый ролик — файл остаётся под путём
 * образа до уборки, а ссылка и путь зафиксированы здесь.
 */
export interface GreetingPresenterSnapshot {
  lookId: string;
  /** Подпись образа — для промпта и экрана. */
  label: string;
  /** Активное изображение выбранного варианта (фото или скетч). */
  url: string;
  pathname: string | null;
  variant: GreetingPresenterVariant;
}

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
  /**
   * Регистр «Особого повода» (этап B). Только у OTHER; у поводов из
   * каталога регистр задаёт каталог, и это поле `null`. Необязательное —
   * снимки, сделанные до этапа B, его не несут и читаются как «тёплый
   * нейтральный» (`registerOfBrief`), то есть строже прежнего
   * «праздничного по умолчанию».
   */
  occasionRegister?: GreetingRegister | null;
  registerSource?: GreetingRegisterSource | null;
  /**
   * Ответ человека о настроении (этап D, §3.4) — отдельно от итога, чтобы
   * подъём регистра словами или классификатором его не стирал. Снимки до
   * этой колонки его не несут: ответ берётся из `occasionRegister`, только
   * если победил сам человек (`storedUserRegister`).
   */
  userOccasionRegister?: GreetingRegister | null;
  /**
   * Язык поздравления (этап C, §3.8). Необязательное: снимки до этапа C
   * его не несут и читаются по языку интерфейса сессии
   * (`scriptLanguageOf`), как и раньше фактически происходило.
   */
  scriptLanguage?: SupportedLocale | null;
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
   * Голос каталога Soniox (S2): реплику, как у клона, произносит НАШ
   * синтез поверх немого рендера Grok (у Hedra — речь аватара), только
   * провайдером Soniox. Взаимоисключающе с `senderVoice` и
   * `presetVoiceId` — говорящий в ролике один.
   *
   * Отдельным полем, а не внутри `senderVoice`: там клон Resemble со
   * своими инвариантами (владелец, готовность, персона), а у Soniox
   * `voiceId: null` осмыслен — «голос Soniox по умолчанию», — и внутри
   * `senderVoice` его не отличить от «ничего не выбрано».
   */
  sonioxVoice?: GreetingSonioxVoice | null;

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

  /**
   * Титульная карточка и закрывающая подпись (фичи №38/№39) — текст,
   * который отправитель написал сам.
   *
   * По умолчанию пусто, и титульная карточка особенно: она называет
   * получателя в первую же секунду, а это ровно то, чего нельзя
   * делать для сюрприза (см. «сюрприз без спойлера» на лендинге).
   * Включает её отправитель осознанно.
   */
  cards?: GreetingCards | null;

  /**
   * Наклейка поверх кадра (фича №8) — копия выбранного стикера.
   *
   * `url` указывает в НАШЕ хранилище, не на Pixabay: их условия
   * прямо запрещают постоянный хотлинк («permanent hotlinking of
   * images is not allowed… please download them to your server
   * first»). `sourceUrl` при этом сохраняется — он нужен, чтобы
   * показать человеку, откуда картинка.
   */
  sticker?: GreetingStickerSelection | null;

  /**
   * Сколько сцен снимать (фича №7). Нет поля или `1` — как раньше,
   * один непрерывный кадр.
   *
   * Сцены описываются раскадровкой в промпте и рендерятся ОДНИМ
   * вызовом, поэтому ни с чем не конфликтуют: пресетный голос
   * произносит реплику один раз на весь ролик, сколько бы в нём ни
   * было склеек.
   */
  sceneCount?: number;

  /**
   * Ведущий-образ персоны (этап G, §4.8) — копия, не ссылка. Нет поля или
   * `null` — ИИ-ведущий, как до этапа G.
   */
  presenter?: GreetingPresenterSnapshot | null;
  /**
   * В ролике есть лицо или голос персоны автора: образ-ведущий или личный
   * бренд-бук. Такой ролик никогда не продаётся на аукционе (§4.7, Т-8) и
   * попадает в витрину только с отдельной галочкой автора (§4.9).
   */
  usesPersona?: boolean;
  /**
   * Галочка автора «можно показать в витрине» для ролика с персоной
   * (§4.9) — ставится при публикации страницы. Без неё оператор не может
   * отметить страницу в витрину.
   */
  personaShowcaseConsentAt?: string | null;

  addedAt: string;
}

/** Выбранная наклейка — то, что нужно и постобработке, и экрану. */
export interface GreetingStickerSelection {
  id: string;
  /** Наш блоб. Именно он уходит в задачу ffmpeg. */
  url: string;
  /** Путь в хранилище — для уборки вместе с сессией. */
  pathname: string;
  /** Страница источника: показывается рядом с выбором. */
  sourceUrl: string;
  source: 'pixabay';
  placement: string;
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
  /**
   * Это клон голоса персоны автора (`UserVoice.personaId`, этап G, §4.6):
   * ролик с ним — ролик с персоной (`usesPersona`), он не продаётся и не
   * идёт в витрину без галочки. Нет поля — записи до этапа G.
   */
  personaVoice?: boolean;
}

/**
 * Выбранный голос Soniox (S2). `voiceId: null` — голос Soniox по
 * умолчанию (`SONIOX_TTS_VOICE`/Maya); `label` — имя из каталога для
 * экрана, у голоса по умолчанию `null`.
 */
export interface GreetingSonioxVoice {
  voiceId: string | null;
  label: string | null;
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
   * на чужой хост (файла у нас нет, удалять нечего), `library` —
   * найденный в библиотеке со свободной лицензией (Freesound, Jamendo,
   * Mubert) и скачанный к нам.
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
  source?: 'catalog' | 'upload' | 'link' | 'library';
  /**
   * Поводы темы каталога на момент выбора (этап B) — копия
   * `GreetingMusicTheme.occasions`: `null` — тема «для любого повода».
   * Нужна проверке перед рендером (`evaluateGreetingPolicy`), которая
   * каталога не читает. Нет поля — снимок до этапа B: проверка такую
   * тему пропускает, а не блокирует задним числом.
   */
  occasions?: GreetingOccasion[] | null;
  /** Путь в хранилище — только у загруженных, для уборки. */
  pathname?: string;
  /** Когда пользователь подтвердил права на этот файл. */
  rightsConfirmedAt?: string;
  /**
   * Строка упоминания автора — только у треков, лицензия которых её
   * требует (CC-BY и родственные).
   *
   * Хранится в снимке, а не собирается на лету, по той же причине,
   * что и всё остальное здесь: каталог провайдера живёт своей жизнью,
   * а обязательство упомянуть автора возникло в момент выбора и
   * относится к ЭТОМУ ролику.
   */
  attribution?: string;
  /** Метка лицензии, как её понял разбор: `CC0-1.0`, `CC-BY-4.0`… */
  licenseType?: string;
  /** Страница лицензии — для проверки и для ссылки. */
  sourceUrl?: string;
}

/**
 * Текст карточек поздравления (фичи №38/№39). Отрисовка — в
 * `common/greeting-cards.ts`; здесь только то, что написал человек.
 */
export interface GreetingCards {
  title?: string | null;
  closing?: string | null;
  /**
   * Шрифт и цвет карточек из бренд-бука (этап G, Г-6) — ключи белого
   * списка `common/greeting-cards.ts`. Нет — Arial белым, как раньше.
   */
  style?: GreetingCardStyle | null;
}

/**
 * Стиль карточек: ключи белого списка, а не произвольные имя шрифта и
 * цвет — шрифт должен быть у ffmpeg-сервиса, а цвет — читаться на тёмной
 * плашке (см. `CARD_FONTS`/`CARD_COLORS` в `common/greeting-cards.ts`).
 */
export interface GreetingCardStyle {
  font: string;
  color: string;
}

/**
 * GET/PATCH /sessions/:id/greeting-cards. `suggested` — заготовки из
 * брифа, которые экран подставляет в пустые поля; значениями они не
 * становятся, пока человек не нажмёт.
 */
export interface GreetingCardsView {
  cards: GreetingCards;
  suggested: GreetingCards;
}

/** Экран выбора числа сцен (фича №7). */
export interface GreetingScenesView {
  sceneCount: number;
  maxScenes: number;
  /** По скольку секунд выйдут сцены при текущем выборе. */
  durations: number[];
}

/** Экран выбора наклейки: кандидаты плюс выбранное. */
export interface GreetingStickerView {
  results: Array<{
    id: string;
    previewUrl: string;
    sourceUrl: string;
    tags: string;
  }>;
  selected: GreetingStickerSelection | null;
  /** Поиск не настроен на стенде — экран скажет об этом честно. */
  configured: boolean;
  /** Этап B: разрешены ли наклейки регистру повода (§3.3 ТЗ). */
  allowed?: boolean;
}

/** Выбор музыкальной темы — то, что видит экран мастера. */
export interface GreetingMusicView {
  /** Темы, подходящие поводу сессии; пусто — каталог не наполнен. */
  themes: GreetingMusicTheme[];
  selected: GreetingMusicSelection | null;
  /** Найденное в библиотеке по последнему запросу. */
  library?: GreetingMusicCandidate[];
  /**
   * Хоть один источник библиотеки настроен на стенде.
   *
   * Поле ОБЯЗАТЕЛЬНОЕ намеренно. Пока оно было необязательным, его
   * проставлял один ответ из пяти — поиск, — и экран показывал блок
   * поиска как рабочий там, где искать негде. Обязательность делает
   * пропуск ошибкой компиляции, а не тихой неправдой в интерфейсе.
   */
  libraryEnabled: boolean;
}

/** Кандидат из библиотеки — то, что экран показывает и даёт послушать. */
export interface GreetingMusicCandidate {
  provider: string;
  providerTrackId: string;
  title: string;
  artist: string | null;
  durationSec: number;
  previewUrl: string | null;
  licenseType: string;
  /** Пусто — упоминание автора не требуется. */
  attribution: string | null;
}

export interface GreetingVoiceView {
  senderVoice: GreetingSenderVoice | null;
  presetVoiceId: string | null;
  sonioxVoice: GreetingSonioxVoice | null;
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
  /**
   * Лица на фото (этап G, Г-8): `true` — проверка нашла лицо; `false` —
   * не нашла; `null` — не проверялось или проверка была недоступна.
   */
  hasFace: boolean | null;
  /** Лицо есть, согласия нет — фото не уйдёт в модель, пока не подтвердят
   * согласие или не превратят его в скетч с заменой лица. */
  needsFaceConsent: boolean;
  faceConsentAt: string | null;
  /** Проверка лица не дала ответа — согласие нужно «на всякий случай». */
  faceCheckUnavailable: boolean;
}

/** GET/PATCH /projects/:id/greeting-brief response shape (§8 ТЗ). */
export interface GreetingBriefView {
  id: string;
  projectId: string;
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  /** Регистр «Особого повода» после всех проверок (§3.4); у каталожных — `null`. */
  occasionRegister: GreetingRegister | null;
  registerSource: GreetingRegisterSource | null;
  /**
   * Ответ человека о настроении (этап D) — даже если итог поднят словами
   * или классификатором; интерфейс подставляет его, а не переспрашивает.
   */
  userOccasionRegister: GreetingRegister | null;
  /** Язык поздравления; `null` — не выбран, берётся язык интерфейса. */
  scriptLanguage: SupportedLocale | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: GreetingPresenterProvider;
  resolution: GreetingResolution;
  brandManifestId: string | null;
  occasionDate: string | null;
  /** «Кто в кадре» (этап G, §4.8). */
  presenter: GreetingPresenterChoice;
  createdAt: string;
  updatedAt: string;
}
