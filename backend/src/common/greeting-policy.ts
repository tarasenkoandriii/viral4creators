/**
 * Политика правил ролика-поздравления по регистру повода — этап B ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` (§3.1–§3.4, §3.9).
 *
 * ## Зачем отдельный файл
 *
 * До этапа B с поводом сверялся только тон (`greeting-occasions.ts`),
 * а остальные правила ролика — наклейка, музыка, раскадровка, лицо
 * ведущего — жили сами по себе. Отсюда шутливое соболезнование через
 * «Особый повод» (Г-1), конфетти и улыбка в траурном ролике (Г-2).
 *
 * Здесь все правила выводятся из ОДНОЙ таблицы — `REGISTER_POLICY` — по
 * регистру повода. Модуль чистый (без Nest и Prisma): его читают и
 * сервисы, и промпты, и публичный `GET /greeting/policy`, а тест
 * перебирает все комбинации, не поднимая DI.
 *
 * ## Главное правило
 *
 * Регистр «Особого повода» определяется тремя сигналами — выбором
 * человека, ключевыми словами и классификатором — и итог равен САМОМУ
 * СТРОГОМУ из них. Ни один сигнал не может опустить регистр, выбранный
 * другим (`stricterRegister`). Ошибка в сторону строгости стоит одной
 * недоступной шутки; ошибка в сторону праздника — шутливого ролика
 * человеку в худший день его жизни.
 */

import {
  GREETING_OCCASION_SPECS,
  GREETING_TONE_LABELS,
} from './greeting-occasions';
import { MAX_GREETING_SCENES } from './greeting-scenes';
import {
  GREETING_REGISTERS,
  GreetingOccasion,
  GreetingRegister,
  GreetingRegisterSource,
  GreetingTone,
} from './types/greeting.types';

export interface RegisterPolicy {
  /** Праздник ли это — решает запреты праздничной атрибутики. */
  festive: boolean;
  /** Тоны «Особого повода» в этом регистре; первый — умолчание. */
  otherTones: readonly GreetingTone[];
  /** Сцена «Особого повода» (у каталожных — `sceneMood` каталога). */
  otherSceneMood: string;
  /** Как настроение обстановки звучит в запросе вариантов сеттинга (рус.). */
  settingMood: string;
  /** Можно ли наклейку. Свободный поиск Pixabay настроением не ограничить. */
  stickers: boolean;
  /** Потолок сцен раскадровки. */
  maxScenes: number;
  /**
   * Темы каталога без поводов (`occasions: null`) — считаются ли
   * подходящими. Раньше `null` значило «любому поводу»; для серьёзных
   * регистров это оставляло праздничную подложку открытой.
   */
  catalogUniversalThemes: boolean;
  /** Своя музыка разрешена всегда; здесь — нужно ли предупреждение. */
  ownMusicWarning: boolean;
  /** Проверять ли готовый текст на праздничность (§3.7). */
  strictText: boolean;
  /** Набор ракурсов раскадровки (`greeting-scenes.ts`). */
  beats: 'festive' | 'neutral' | 'solemn' | 'calm';
}

const CALM_SCENE =
  'quiet, restrained setting; soft muted colours; no decorations, no confetti, no balloons';

export const REGISTER_POLICY: Readonly<
  Record<GreetingRegister, RegisterPolicy>
> = {
  CELEBRATORY: {
    festive: true,
    otherTones: ['WARM', 'FUNNY', 'FORMAL'],
    otherSceneMood:
      'bright, cheerful setting with soft festive decor; warm light; celebratory but tasteful',
    settingMood: 'праздничное',
    stickers: true,
    maxScenes: MAX_GREETING_SCENES,
    catalogUniversalThemes: true,
    ownMusicWarning: false,
    strictText: false,
    beats: 'festive',
  },
  WARM_NEUTRAL: {
    festive: false,
    otherTones: ['WARM', 'FUNNY', 'FORMAL'],
    otherSceneMood:
      'neutral, well-lit setting appropriate for a personal message; no party decorations',
    settingMood: 'тёплое, но без праздничной атрибутики',
    stickers: true,
    maxScenes: MAX_GREETING_SCENES,
    catalogUniversalThemes: true,
    ownMusicWarning: false,
    strictText: false,
    beats: 'neutral',
  },
  SOLEMN: {
    festive: false,
    otherTones: ['WARM', 'FORMAL', 'RESPECTFUL'],
    otherSceneMood:
      'restrained, dignified setting; calm, respectful mood; no party decorations',
    settingMood: 'торжественное и сдержанное, без праздничной атрибутики',
    stickers: false,
    maxScenes: 3,
    catalogUniversalThemes: false,
    ownMusicWarning: false,
    strictText: false,
    beats: 'solemn',
  },
  SENSITIVE: {
    festive: false,
    otherTones: ['WARM', 'SUPPORTIVE', 'RESPECTFUL'],
    otherSceneMood: CALM_SCENE,
    settingMood: 'спокойное и деликатное, без праздничной атрибутики',
    stickers: false,
    maxScenes: 2,
    catalogUniversalThemes: false,
    ownMusicWarning: true,
    strictText: true,
    beats: 'calm',
  },
  MOURNING: {
    festive: false,
    otherTones: ['RESPECTFUL', 'SUPPORTIVE'],
    otherSceneMood: CALM_SCENE,
    settingMood: 'траурное: тихое, приглушённое, без праздничной атрибутики',
    stickers: false,
    maxScenes: 2,
    catalogUniversalThemes: false,
    ownMusicWarning: true,
    strictText: true,
    beats: 'calm',
  },
};

// ── Регистр ──────────────────────────────────────────────────────────────

export function isGreetingRegister(v: unknown): v is GreetingRegister {
  return (GREETING_REGISTERS as readonly unknown[]).includes(v);
}

/** Строже — значит дальше по `GREETING_REGISTERS`. */
export function stricterRegister(
  a: GreetingRegister,
  b: GreetingRegister | null | undefined,
): GreetingRegister {
  if (!b) return a;
  return GREETING_REGISTERS.indexOf(b) > GREETING_REGISTERS.indexOf(a) ? b : a;
}

/**
 * Регистр брифа или снимка. У каталожных поводов — из каталога, у OTHER —
 * сохранённый итог §3.4, а без него (снимки до этапа B) — базовый
 * регистр OTHER, тёплый нейтральный.
 */
export function registerOfBrief(brief: {
  occasion: GreetingOccasion;
  occasionRegister?: GreetingRegister | null;
}): GreetingRegister {
  const base = GREETING_OCCASION_SPECS[brief.occasion].register;
  if (brief.occasion !== 'OTHER') return base;
  return brief.occasionRegister ?? base;
}

/**
 * Детерминированный пол по ключевым словам (§3.4 п.2).
 *
 * Только однозначные основы. «Смерт», «умер», «умерл» сюда НЕ входят
 * намеренно: «до смерти рада за тебя», «умереть со смеху» — обычный
 * праздничный текст. Украинское «жалоба» (траур) тоже не входит: по-русски
 * это «претензия», и один список на пять языков её перепутал бы. Всё
 * неоднозначное — дело классификатора, который смотрит на смысл.
 *
 * Тот же приём, что у `celebrity-likeness.ts`: узкие триггеры, высокая
 * точность.
 */
const MOURNING_PATTERNS: readonly RegExp[] = [
  // ru / uk
  /похорон/i,
  /поховання/i,
  /помин(к|ал|ан)/i,
  /соболезн/i,
  /співчут/i,
  /скончал/i,
  /ушл[аи]? из жизни|ушёл из жизни|ушел из жизни/i,
  /светл(ая|ой) памят/i,
  /вечн(ая|ой) памят/i,
  /світл(а|ої) пам/i,
  /вічн(а|ої) пам/i,
  /царств[оа] небесн/i,
  /последний путь|останн(ій|ю) пут/i,
  /годовщин[аыу] смерти|річниц[яю] смерті/i,
  /\bтраур/i,
  // en
  /\bfuneral/i,
  /\bcondolence/i,
  /\bbereavement/i,
  /passed away/i,
  /memorial service/i,
  /rest in peace/i,
  /in loving memory/i,
  // de
  /beerdigung/i,
  /beisetzung/i,
  /\bbeileid/i,
  /trauerfeier/i,
  /\bverstorben/i,
  // es
  /\bfuneral/i,
  /pésame/i,
  /condolencia/i,
  /\bvelorio/i,
  /descanse en paz/i,
  /\bfalleci/i,
];

/** Совпавший фрагмент — для честного объяснения на экране. */
export function mourningKeyword(
  text: string | null | undefined,
): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  for (const re of MOURNING_PATTERNS) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
}

export interface OtherRegisterSignals {
  /** Выбор человека — вопрос «какое это событие по настроению». */
  user?: GreetingRegister | null;
  /** Описание повода словами. */
  text?: string | null;
  /** Ответ классификатора; `null` — не вызывали или сбой. */
  classifier?: GreetingRegister | null;
}

export interface ResolvedRegister {
  register: GreetingRegister;
  source: GreetingRegisterSource;
  /** Совпавшее ключевое слово — если регистр поднят им. */
  keyword: string | null;
}

/**
 * Итоговый регистр «Особого повода» = самый строгий из сигналов (§3.4).
 *
 * Без выбора человека стартовая точка — базовый регистр OTHER (тёплый
 * нейтральный), а НЕ праздничный: до этапа B интерфейс вопроса не задаёт,
 * и молчание не должно превращаться в праздник.
 */
export function resolveOtherRegister(
  s: OtherRegisterSignals,
): ResolvedRegister {
  let register: GreetingRegister =
    s.user ?? GREETING_OCCASION_SPECS.OTHER.register;
  let source: GreetingRegisterSource = s.user ? 'user' : 'default';

  const keyword = mourningKeyword(s.text);
  if (keyword && stricterRegister(register, 'MOURNING') !== register) {
    register = 'MOURNING';
    source = 'keywords';
  }
  if (s.classifier && stricterRegister(register, s.classifier) !== register) {
    register = s.classifier;
    source = 'classifier';
  }
  return { register, source, keyword: source === 'keywords' ? keyword : null };
}

// ── Тоны ─────────────────────────────────────────────────────────────────

export function tonesFor(
  occasion: GreetingOccasion,
  register: GreetingRegister,
): readonly GreetingTone[] {
  return occasion === 'OTHER'
    ? REGISTER_POLICY[register].otherTones
    : GREETING_OCCASION_SPECS[occasion].tones;
}

export function toneAllowedForRegister(
  occasion: GreetingOccasion,
  register: GreetingRegister,
  tone: GreetingTone,
): boolean {
  return tonesFor(occasion, register).includes(tone);
}

export function defaultToneForRegister(
  occasion: GreetingOccasion,
  register: GreetingRegister,
): GreetingTone {
  return tonesFor(occasion, register)[0];
}

// ── Сцена и лицо ведущего ────────────────────────────────────────────────

export function sceneMoodFor(
  occasion: GreetingOccasion,
  register: GreetingRegister,
): string {
  return occasion === 'OTHER'
    ? REGISTER_POLICY[register].otherSceneMood
    : GREETING_OCCASION_SPECS[occasion].sceneMood;
}

export function isFestiveRegister(register: GreetingRegister): boolean {
  return REGISTER_POLICY[register].festive;
}

/**
 * Как тон выглядит НА ЛИЦЕ — базовая таблица. Раньше жила в
 * `greeting-frame-prompt.ts` и знала только тон, а видео-промпт писал
 * «smiling» безусловно (Г-2). Теперь лицо — одно на кадр и видео и
 * зависит от регистра.
 */
const TONE_LOOK: Readonly<Record<GreetingTone, string>> = {
  WARM: 'warm, genuine smile; relaxed and friendly',
  FUNNY: 'playful, light-hearted expression; a hint of mischief, never mocking',
  FORMAL: 'composed, polite, professional expression',
  SUPPORTIVE: 'calm, kind, attentive expression; gentle, not cheerful',
  RESPECTFUL: 'serious, respectful, quiet expression; no smile',
};

export function presenterExpression(
  occasion: GreetingOccasion,
  register: GreetingRegister,
  tone: GreetingTone,
): string {
  switch (register) {
    case 'MOURNING':
      return 'serious, quiet, compassionate expression; no smile';
    case 'SENSITIVE':
      if (occasion === 'APOLOGY') {
        return 'sincere, serious, regretful expression; no smile';
      }
      if (tone === 'WARM') {
        return 'soft, kind expression; at most a gentle, reassuring smile';
      }
      return TONE_LOOK[tone];
    case 'SOLEMN':
      return tone === 'RESPECTFUL'
        ? TONE_LOOK.RESPECTFUL
        : 'composed, dignified expression; no broad smile';
    default:
      return TONE_LOOK[tone];
  }
}

/** Настроение ведущего одной фразой для видео-промпта. */
export function presenterMood(
  register: GreetingRegister,
  tone: GreetingTone,
): string {
  if (register === 'MOURNING') return 'quiet and compassionate';
  switch (tone) {
    case 'FUNNY':
      return 'playful and lighthearted';
    case 'FORMAL':
      return 'composed and professional';
    case 'RESPECTFUL':
      return 'quiet and respectful';
    case 'SUPPORTIVE':
      return 'gentle and reassuring';
    default:
      return register === 'SENSITIVE'
        ? 'sincere and gentle'
        : 'warm and sincere';
  }
}

// ── Проверка набора правил ───────────────────────────────────────────────

export type MusicSource = 'catalog' | 'upload' | 'link' | 'library';

export interface PolicyInput {
  occasion: GreetingOccasion;
  occasionRegister?: GreetingRegister | null;
  tone: GreetingTone;
  /** Выбрана ли наклейка. */
  sticker?: boolean;
  /** Выбранная музыка: источник и (для каталога) поводы темы. */
  music?: {
    source?: MusicSource | null;
    occasions?: readonly GreetingOccasion[] | null;
  } | null;
  sceneCount?: number | null;
}

export type PolicyField = 'tone' | 'sticker' | 'music' | 'sceneCount';

export interface PolicyViolation {
  field: PolicyField;
  code: string;
  /** Человеческое объяснение — уходит в ответ 400 как есть. */
  message: string;
}

export interface PolicyVerdict {
  ok: boolean;
  register: GreetingRegister;
  violations: PolicyViolation[];
}

const REGISTER_NAME: Readonly<Record<GreetingRegister, string>> = {
  CELEBRATORY: 'праздничного повода',
  WARM_NEUTRAL: 'этого повода',
  SOLEMN: 'торжественного повода',
  SENSITIVE: 'деликатного повода',
  MOURNING: 'траурного повода',
};

/** Подходит ли тема каталога поводу и регистру. */
export function catalogThemeAllowed(
  occasion: GreetingOccasion,
  register: GreetingRegister,
  themeOccasions: readonly GreetingOccasion[] | null | undefined,
): boolean {
  // `undefined` — неизвестно (выбор сделан до этапа B): не блокируем
  // задним числом то, что тогда было допустимо.
  if (themeOccasions === undefined) return true;
  if (themeOccasions === null) {
    return REGISTER_POLICY[register].catalogUniversalThemes;
  }
  return themeOccasions.includes(occasion);
}

/**
 * Весь набор правил за один проход (§3.1). Чистая функция: зовётся и
 * при записи каждого правила, и перед рендером — «проверка у денег»,
 * потому что снимок мог быть собран до того, как правило вступило в силу.
 */
export function evaluateGreetingPolicy(input: PolicyInput): PolicyVerdict {
  const register = registerOfBrief(input);
  const policy = REGISTER_POLICY[register];
  const violations: PolicyViolation[] = [];
  const who = REGISTER_NAME[register];

  if (!toneAllowedForRegister(input.occasion, register, input.tone)) {
    violations.push({
      field: 'tone',
      code: 'tone-not-allowed',
      message: `Тон «${GREETING_TONE_LABELS[input.tone]}» недоступен для ${who}. Допустимые: ${tonesFor(
        input.occasion,
        register,
      )
        // Подпись для человека и код для клиента API: код нужен тому, кто
        // строит запрос, подпись — тому, кто читает отказ на экране.
        .map((t) => `«${GREETING_TONE_LABELS[t]}» (${t})`)
        .join(', ')}.`,
    });
  }
  if (input.sticker && !policy.stickers) {
    violations.push({
      field: 'sticker',
      code: 'sticker-not-allowed',
      message: `Наклейки недоступны для ${who}.`,
    });
  }
  const music = input.music;
  if (
    music &&
    (music.source ?? 'catalog') === 'catalog' &&
    !catalogThemeAllowed(input.occasion, register, music.occasions)
  ) {
    violations.push({
      field: 'music',
      code: 'theme-not-allowed',
      message: `Эта музыкальная тема не подходит для ${who}. Выберите другую или добавьте свою.`,
    });
  }
  const scenes = input.sceneCount ?? 1;
  if (scenes > policy.maxScenes) {
    violations.push({
      field: 'sceneCount',
      code: 'too-many-scenes',
      message: `Для ${who} — не больше ${policy.maxScenes} ${policy.maxScenes === 1 ? 'сцены' : 'сцен'}.`,
    });
  }
  return { ok: violations.length === 0, register, violations };
}

/** Текст отказа одной строкой — для `BadRequestException`. */
export function policyMessage(verdict: PolicyVerdict): string {
  return verdict.violations.map((v) => v.message).join(' ');
}

// ── Проверка готового текста (§3.7) ──────────────────────────────────────

/**
 * Праздничные приметы в тексте, написанном моделью для деликатного и
 * траурного регистров. Модель просят не поздравлять (`intent` повода), но
 * просьба — не гарантия; здесь она становится проверкой.
 *
 * Проверяется ТОЛЬКО сгенерированный текст. Свой текст человека за стиль
 * не блокируется — это его слова (§3.7).
 */
const FESTIVE_MARKERS: readonly RegExp[] = [
  /поздравл/i,
  /вітаю|привітан/i,
  /congratulat/i,
  /с (днём|днем) рождения|с праздник/i,
  // Этап C: текст теперь бывает на пяти языках (§3.8) — приметы
  // праздника по-немецки и по-испански. Узкие: «feier» задевал
  // «Trauerfeier» (траурное слово из списка выше), а «celebr» —
  // «celebrate his life», обычную фразу соболезнования.
  /glückwunsch|gratulier|alles gute zum/i,
  /felicidad|felicidades|felicitaci|enhorabuena|feliz cumple/i,
  /happy (birthday|anniversary)/i,
  /[!¡]/,
  /\bура\b/i,
  /\){2,}|😂|😄|😁|🎉|🥳/u,
  /ха-ха|хаха|haha|jaja/i,
];

export function textFitsRegister(
  register: GreetingRegister,
  text: string,
): boolean {
  if (!REGISTER_POLICY[register].strictText) return true;
  return !FESTIVE_MARKERS.some((re) => re.test(text));
}

// ── Публичная таблица для интерфейса (GET /greeting/policy) ──────────────

export interface GreetingPolicyView {
  registers: Array<{
    register: GreetingRegister;
    festive: boolean;
    stickers: boolean;
    maxScenes: number;
    catalogUniversalThemes: boolean;
    ownMusicWarning: boolean;
    otherTones: readonly GreetingTone[];
  }>;
  occasions: Array<{
    occasion: GreetingOccasion;
    register: GreetingRegister;
    tones: readonly GreetingTone[];
  }>;
}

export function greetingPolicyView(): GreetingPolicyView {
  return {
    registers: GREETING_REGISTERS.map((register) => {
      const p = REGISTER_POLICY[register];
      return {
        register,
        festive: p.festive,
        stickers: p.stickers,
        maxScenes: p.maxScenes,
        catalogUniversalThemes: p.catalogUniversalThemes,
        ownMusicWarning: p.ownMusicWarning,
        otherTones: p.otherTones,
      };
    }),
    occasions: (Object.keys(GREETING_OCCASION_SPECS) as GreetingOccasion[]).map(
      (occasion) => ({
        occasion,
        register: GREETING_OCCASION_SPECS[occasion].register,
        tones: GREETING_OCCASION_SPECS[occasion].tones,
      }),
    ),
  };
}

// ── Регистр брифа целиком (создание и правка) ────────────────────────────

export interface BriefRegisterInput {
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  /** Явный выбор человека (вопрос о настроении), если был. */
  userRegister?: GreetingRegister | null;
  /**
   * Ранее полученный ответ классификатора — чтобы не платить за вызов
   * повторно, когда описание повода не менялось.
   */
  knownClassifier?: GreetingRegister | null;
}

export interface BriefRegister {
  /** `null` у каталожных поводов: их регистр задаёт каталог. */
  occasionRegister: GreetingRegister | null;
  registerSource: GreetingRegisterSource | null;
  keyword: string | null;
}

/**
 * Регистр брифа по всем трём сигналам §3.4. Классификатор зовётся, только
 * если есть что поднимать (итог ещё не траурный) и нет готового ответа;
 * его отсутствие или сбой — просто «сигнала нет».
 */
export async function resolveBriefRegister(
  input: BriefRegisterInput,
  classify?: (text: string) => Promise<GreetingRegister | null>,
): Promise<BriefRegister> {
  if (input.occasion !== 'OTHER') {
    return { occasionRegister: null, registerSource: null, keyword: null };
  }
  const text = input.customOccasionText ?? '';
  let resolved = resolveOtherRegister({ user: input.userRegister, text });
  let classifier = input.knownClassifier ?? null;
  if (classifier === null && resolved.register !== 'MOURNING' && classify) {
    classifier = await classify(text);
  }
  if (classifier) {
    resolved = resolveOtherRegister({
      user: input.userRegister,
      text,
      classifier,
    });
  }
  return {
    occasionRegister: resolved.register,
    registerSource: resolved.source,
    keyword: resolved.keyword,
  };
}

/**
 * Текст отказа по тону с объяснением, ПОЧЕМУ регистр такой: «в описании
 * есть слово «похороны»» понятнее, чем голое «тон недопустим» (§3.4).
 */
export function toneRefusal(
  occasion: GreetingOccasion,
  register: GreetingRegister,
  tone: GreetingTone,
  keyword: string | null,
): string {
  const verdict = evaluateGreetingPolicy({
    occasion,
    occasionRegister: register,
    tone,
  });
  const why = keyword ? `В описании повода есть «${keyword}». ` : '';
  return `${why}${policyMessage(verdict)}`.trim();
}
