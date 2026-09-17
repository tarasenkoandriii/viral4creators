/**
 * Режимы сервиса — lite / standard / premium (ТЗ §23, этап 29).
 *
 * Одна таблица возможностей на весь продукт: и бэкенд (что запрещать),
 * и интерфейс (что показывать под замком) читают её отсюда. Держать
 * матрицу в одном месте важнее, чем красиво: границы пакетов будут
 * двигаться, и двигать их нужно правкой одной структуры, а не поиском
 * условий по коду.
 *
 * Что означают режимы (со слов владельца продукта):
 *  - **lite** (по умолчанию) — «минимальная генерация после разбора»:
 *    референс → разбор → товар → промпт → ролик в 16:9 или 9:16.
 *    В будущем станет условно-бесплатным за лайк каналу проекта и
 *    рассылку семи ссылок (контроль публикации ссылок — позже);
 *  - **standard** — весь функционал, кроме библиотеки разборов;
 *  - **premium** — всё, включая библиотеку.
 *
 * Сейчас все три пакета бесплатны и переключаются самим пользователем
 * (`PLANS_BILLING_ENABLED=false`). Когда появится оплата, переключение
 * станет покупкой — код проверки прав от этого не изменится.
 */

import { SupportedLocale } from './locale';
import { normaliseAspectRatio, veoFrameFor } from './aspect-ratio';

export type PlanId = 'LITE' | 'STANDARD' | 'PREMIUM';

export const PLAN_IDS: readonly PlanId[] = ['LITE', 'STANDARD', 'PREMIUM'];

/** Возможности, которые пакет либо даёт, либо нет. */
export type PlanFeature =
  /** Библиотека разборов: рекомендации и «взять готовый разбор» (§21). */
  | 'library'
  /** Проверка релевантности референса товару (§18.3). */
  | 'relevance'
  /** Аудит готового ролика на артефакты (§11). */
  | 'audit'
  /** Очередь публикации (§8). */
  | 'publication'
  /** Манифест бренда: стиль, голос, персонажи, сцены (§12, §17.1). */
  | 'brandManifest'
  /** Свои сцены и ручной выбор трёх слотов референс-изображений (§17). */
  | 'referenceAssets'
  /** Замена персонажа своим фото или персонажем бренда (§10.2). */
  | 'characterReplacement'
  /** Форматы кадра сверх двух родных для Veo (§16). */
  | 'customAspectRatio'
  /**
   * Полная модель Veo (`quality: 'standard'`) вместо Lite — в 2,7 раза
   * дороже за секунду (§26.1). До этапа 47 (В-2.6) параметр принимался
   * от кого угодно телом запроса и ничем не проверялся: один вызов
   * съедал две трети общего гостевого потолка. Интерфейс пока всегда
   * шлёт `fast`; признак закрывает путь, а не открывает кнопку.
   */
  | 'fullQualityVideo'
  /**
   * Пилот говорящего AI-аватара (Hedra Character-3 + Resemble),
   * doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §4.1, этап 72. По умолчанию
   * `false` на ВСЕХ тарифах до конца пилота — доступ только через
   * admin-only `ActorsController` (§5.3 документа), это не пользовательская
   * кнопка. Признак существует уже сейчас, чтобы `planAllows()`/
   * `featureDeniedMessage()` были готовы к тому дню, когда пилот
   * откроется пользователям (вероятно Premium — см. §4.1).
   */
  | 'avatarLipsync'
  /**
   * Клонирование голоса пользователем (этап 73, TODO п.32,
   * doc/AI-ACTORS-NO-REFERENCE-SPEC.md §3.5/§3.6.1) — открытый вопрос
   * «тот же гейт, что brandManifest, или отдельный» решён отдельным
   * признаком: коммерчески это может измениться независимо от
   * brandManifest (например продаваться отдельной надбавкой), а
   * технически завести новый флаг стоит ровно одну строку. По
   * умолчанию — тот же тариф, что brandManifest (Standard и выше),
   * это МОЖНО пересмотреть отдельно, не трогая эту декларацию типа.
   */
  | 'voiceCloning'
  /**
   * Режим озвучки `dub` (voice-mode.ts, §15.1) — заменяет звук Veo
   * целиком, а не микширует его в фон, как `voiceover`. Доп. запрос
   * владельца продукта: явно более дорогой/премиальный уровень
   * озвучки, поэтому отдельный признак, а не тот же `brandManifest`
   * (Standard и выше), которым уже гейтится `voiceover` — сам факт
   * входа в манифест бренда. `voiceover` дополнительного признака не
   * получает: он и есть «обычная» озвучка, доступная всем, кому вообще
   * доступен манифест бренда.
   */
  | 'voiceDub'
  /**
   * Обучалка по сайту заказчика (doc/CLIENT-SITE-TUTORIAL-SPEC.md §9,
   * этап 111) — пошаговый визард, который водит headless-браузер по
   * ЧУЖОМУ сайту и собирает из этого обучающее видео. Гейтится строже
   * обычного шага визарда не из-за ИИ (его здесь нет вовсе), а из-за
   * секунд владения контейнером с Chromium: каждый раунд — это свежий
   * запуск браузера, а live-вход (§7.4) держит его минутами. Тот же
   * тариф, что `brandManifest` — Standard и выше.
   */
  | 'siteTutorial';

export interface PlanDefinition {
  id: PlanId;
  title: string;
  /** Одна строка для карточки выбора. */
  summary: string;
  features: Readonly<Record<PlanFeature, boolean>>;
  /** Разрешённые соотношения сторон; пустой список = любые. */
  aspectRatios: readonly string[];
}

/** Соотношения, которые Veo рендерит нативно — минимум, доступный всем. */
export const NATIVE_ASPECT_RATIOS = ['16:9', '9:16'] as const;

const ALL: Record<PlanFeature, boolean> = {
  library: true,
  relevance: true,
  audit: true,
  publication: true,
  brandManifest: true,
  referenceAssets: true,
  characterReplacement: true,
  customAspectRatio: true,
  fullQualityVideo: true,
  // Этап 72: пилот аватара не даётся ни одному тарифу через это поле —
  // `ALL: true` здесь означало бы «доступно всем», а решение (§4.1,
  // §5.3 документа) обратное: `false` на всех трёх ниже, доступ только
  // оператору напрямую через ActorsController, минуя PlanService.
  avatarLipsync: false,
  // Этап 73: тот же тариф, что brandManifest ниже (Standard и выше) —
  // временное решение открытого вопроса §3.6.1, см. доккомментарий типа.
  voiceCloning: true,
  // По умолчанию доступен (как library) — конкретные тарифы ниже сужают.
  voiceDub: true,
  // Этап 111: Standard и выше, как brandManifest — LITE сужает ниже.
  siteTutorial: true,
};

export const PLANS: Readonly<Record<PlanId, PlanDefinition>> = {
  LITE: {
    id: 'LITE',
    title: 'Lite',
    summary:
      'Разбор референса и генерация ролика в 16:9 или 9:16 — самый короткий путь от примера к результату.',
    features: {
      ...ALL,
      library: false,
      relevance: false,
      audit: false,
      publication: false,
      brandManifest: false,
      referenceAssets: false,
      characterReplacement: false,
      customAspectRatio: false,
      fullQualityVideo: false,
      voiceCloning: false,
      voiceDub: false,
      siteTutorial: false,
    },
    aspectRatios: NATIVE_ASPECT_RATIOS,
  },
  STANDARD: {
    id: 'STANDARD',
    title: 'Standard',
    summary:
      'Весь функционал сервиса, кроме библиотеки готовых разборов и дубляжа: бренд, персонажи, сцены, релевантность, аудит, публикация, любые форматы кадра, озвучка своим голосом поверх звука Veo.',
    features: { ...ALL, library: false, voiceDub: false },
    aspectRatios: [],
  },
  PREMIUM: {
    id: 'PREMIUM',
    title: 'Premium',
    summary:
      'Всё вместе с библиотекой разборов и дубляжом (полная замена звука Veo своим голосом): готовые сценарии под аудиторию вашего товара и мгновенный разбор уже виденных роликов.',
    features: { ...ALL },
    aspectRatios: [],
  },
};

/**
 * Локализованные `title`/`summary` (аудит 2026-09-08, Г-5.2): `PLANS`
 * выше остаётся канонической русской структурой — от неё зависят
 * `features`/`aspectRatios`, которые читают проверки прав по всему
 * бэкенду, трогать их набор строк не нужно и рискованно. Здесь —
 * ТОЛЬКО текст для карточки выбора режима (`GET/PATCH /me/plan`),
 * который раньше уходил клиенту по-русски независимо от локали
 * интерфейса. `title` — имя пакета (Lite/Standard/Premium), одинаковое
 * во всех локалях: это имя продукта, а не описание, переводить нечего.
 */
const PLAN_SUMMARY: Readonly<Record<SupportedLocale, Record<PlanId, string>>> =
  {
    ru: {
      LITE: 'Разбор референса и генерация ролика в 16:9 или 9:16 — самый короткий путь от примера к результату.',
      STANDARD:
        'Весь функционал сервиса, кроме библиотеки готовых разборов и дубляжа: бренд, персонажи, сцены, релевантность, аудит, публикация, любые форматы кадра, озвучка своим голосом поверх звука Veo.',
      PREMIUM:
        'Всё вместе с библиотекой разборов и дубляжом (полная замена звука Veo своим голосом): готовые сценарии под аудиторию вашего товара и мгновенный разбор уже виденных роликов.',
    },
    uk: {
      LITE: 'Аналіз референсу та генерація ролика у форматі 16:9 або 9:16 — найкоротший шлях від прикладу до результату.',
      STANDARD:
        'Весь функціонал сервісу, крім бібліотеки готових розборів і дубляжу: бренд, персонажі, сцени, релевантність, аудит, публікація, будь-які формати кадру, озвучка власним голосом поверх звуку Veo.',
      PREMIUM:
        'Все разом із бібліотекою розборів і дубляжем (повна заміна звуку Veo власним голосом): готові сценарії під аудиторію вашого товару та миттєвий розбір уже бачених роликів.',
    },
    en: {
      LITE: 'Reference analysis and video generation in 16:9 or 9:16 — the shortest path from example to result.',
      STANDARD:
        "Everything the service offers except the analysis library and dub: brand, characters, scenes, relevance, audit, publishing, any aspect ratio, your own voice mixed over Veo's sound.",
      PREMIUM:
        "Everything, including the analysis library and dub (your own voice fully replacing Veo's sound): ready-made scripts tailored to your product's audience and instant analysis of videos you've already seen.",
    },
    de: {
      LITE: 'Referenzanalyse und Videogenerierung im Format 16:9 oder 9:16 — der kürzeste Weg vom Beispiel zum Ergebnis.',
      STANDARD:
        'Der gesamte Funktionsumfang außer der Analysebibliothek und der Synchronisation: Marke, Charaktere, Szenen, Relevanz, Audit, Veröffentlichung, beliebige Seitenverhältnisse, eigene Stimme über den Veo-Ton gemischt.',
      PREMIUM:
        'Alles inklusive Analysebibliothek und Synchronisation (eigene Stimme ersetzt den Veo-Ton vollständig): fertige Skripte für die Zielgruppe Ihres Produkts und sofortige Analyse bereits gesehener Videos.',
    },
    es: {
      LITE: 'Análisis de referencia y generación de video en 16:9 o 9:16 — el camino más corto del ejemplo al resultado.',
      STANDARD:
        'Todas las funciones del servicio excepto la biblioteca de análisis y el doblaje: marca, personajes, escenas, relevancia, auditoría, publicación, cualquier relación de aspecto, tu propia voz mezclada sobre el sonido de Veo.',
      PREMIUM:
        'Todo junto con la biblioteca de análisis y el doblaje (tu propia voz reemplaza por completo el sonido de Veo): guiones listos para la audiencia de tu producto y análisis instantáneo de videos ya vistos.',
    },
  };

/** `PLANS`, переведённый под запрошенную локаль — для ответа клиенту. */
export function plansFor(
  locale: SupportedLocale,
): Readonly<Record<PlanId, PlanDefinition>> {
  // `?? PLAN_SUMMARY.ru` — на случай локали, обошедшей типы в рантайме
  // (значение не из `normalizeLocale`): честный русский текст лучше,
  // чем упасть на отдающем клиенту ответе `GET /me/plan`.
  const summary = PLAN_SUMMARY[locale] ?? PLAN_SUMMARY.ru;
  return {
    LITE: { ...PLANS.LITE, summary: summary.LITE },
    STANDARD: { ...PLANS.STANDARD, summary: summary.STANDARD },
    PREMIUM: { ...PLANS.PREMIUM, summary: summary.PREMIUM },
  };
}

export const DEFAULT_PLAN: PlanId = 'LITE';

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as string[]).includes(value);
}

/** Режим пользователя; всё непонятное (null, старое значение) → lite. */
export function planOf(value: unknown): PlanId {
  return isPlanId(value) ? value : DEFAULT_PLAN;
}

export function planAllows(plan: PlanId, feature: PlanFeature): boolean {
  return PLANS[plan].features[feature];
}

/** Минимальный пакет, в котором возможность есть — для текста «доступно в …». */
export function minimalPlanFor(feature: PlanFeature): PlanId {
  return PLAN_IDS.find((id) => PLANS[id].features[feature]) ?? 'PREMIUM';
}

export function allowsAspectRatio(plan: PlanId, ratio: string): boolean {
  const allowed = PLANS[plan].aspectRatios;
  return allowed.length === 0 || allowed.includes(ratio);
}

/**
 * Какой формат кадра на самом деле будет отрендерен — с учётом режима
 * (Б-2.4 второго аудита, этап 120).
 *
 * Тут две разные ситуации, и разводить их обязательно:
 *
 * - формат ВЫБРАН явно. Это осознанное действие, и если режим его не
 *   позволяет, честный ответ — отказ (его и бросает вызывающий по
 *   `denied`). Так это работало и раньше.
 * - формат НЕ выбран и берётся из референса. Человек ничего не просил,
 *   он просто загрузил своё видео — отказывать ему не за что. Но и
 *   рендерить в закрытом для его режима формате нельзя: до этого этапа
 *   Lite, загрузивший референс 1080×1350, получал ролик 4:5 и
 *   оплаченную обрезку ffmpeg, то есть замок держался только тем, что
 *   интерфейс туда не пускает. Теперь такой формат приводится к
 *   ближайшему нативному (`veoFrameFor`) — он доступен в любом режиме.
 *
 * Возвращает и признак приведения: вызывающему есть что записать в лог
 * и в сессию, а пользователю — что показать.
 */
export function resolveTargetAspectRatio(
  plan: PlanId,
  requested: string | null | undefined,
  detected: string | null | undefined,
): { target: string; denied: string | null; clamped: boolean } {
  const explicit = normaliseAspectRatio(requested);
  if (explicit) {
    return allowsAspectRatio(plan, explicit)
      ? { target: explicit, denied: null, clamped: false }
      : // `target` — уже приведённый, а не запрошенный: вызывающий
        // обязан смотреть на `denied` и отказывать, но если однажды
        // забудет, отрендерится разрешённый формат, а не закрытый.
        {
          target: clampToAllowed(plan, explicit),
          denied: explicit,
          clamped: true,
        };
  }
  const wanted = normaliseAspectRatio(detected) ?? '9:16';
  if (allowsAspectRatio(plan, wanted)) {
    return { target: wanted, denied: null, clamped: false };
  }
  return { target: clampToAllowed(plan, wanted), denied: null, clamped: true };
}

/**
 * Ближайший РАЗРЕШЁННЫЙ формат. Обычно это нативный кадр Veo — он есть
 * в списке любого режима, — но список режима это данные, а не
 * константа: режим «только вертикаль» (`['9:16']`) вполне возможен, и
 * тогда ландшафтный референс приводить к `16:9` нельзя. Проверяем, а не
 * предполагаем: тихо отрендерить формат, закрытый режимом, — ровно тот
 * дефект (Б-2.4), который этот код и закрывает.
 */
function clampToAllowed(plan: PlanId, wanted: string): string {
  const native = veoFrameFor(wanted);
  if (allowsAspectRatio(plan, native)) return native;
  return PLANS[plan].aspectRatios[0] ?? native;
}

/** Человеческий текст отказа — его увидит пользователь, поэтому без жаргона. */
export function featureDeniedMessage(feature: PlanFeature): string {
  const need = PLANS[minimalPlanFor(feature)].title;
  const what: Record<PlanFeature, string> = {
    library: 'Библиотека готовых разборов',
    relevance: 'Проверка релевантности референса',
    audit: 'Проверка ролика на артефакты',
    publication: 'Очередь публикации',
    brandManifest: 'Манифест бренда',
    referenceAssets: 'Свои сцены и ручной выбор референс-изображений',
    characterReplacement: 'Замена персонажей своим фото',
    customAspectRatio: 'Другие форматы кадра',
    fullQualityVideo: 'Полная модель Veo',
    avatarLipsync: 'Говорящий AI-аватар (пилот)',
    voiceCloning: 'Клонирование своего голоса',
    voiceDub: 'Дубляж (полная замена звука Veo своим голосом)',
    siteTutorial: 'Обучающее видео по сайту заказчика',
  };
  return `${what[feature]} доступна в режиме ${need}. Сейчас все режимы бесплатны — переключитесь в настройках режима.`;
}

/**
 * Каким режимом считать деньги: самостоятельно выбранный режим потолок
 * не поднимает, пока оплата не включена. Когда `PLANS_BILLING_ENABLED`
 * станет true, смена режима будет покупкой, и флаг перестанет что-либо
 * значить — оплаченный режим считается по своему потолку.
 */
export function spendPlanOf(
  plan: PlanId,
  selfService: boolean,
  env: {
    PLANS_BILLING_ENABLED?: string;
    [key: string]: string | undefined;
  } = process.env,
): PlanId {
  if (env.PLANS_BILLING_ENABLED === 'true') return plan;
  return selfService ? DEFAULT_PLAN : plan;
}
