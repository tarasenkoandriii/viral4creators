/**
 * Каталог поводов и тонов поздравления — этап 2 плана
 * docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md (фичи №1 и №3
 * компаньон-ТЗ).
 *
 * Почему отдельный файл, а не пара map'ов в `GreetingPromptService`.
 * Компаньон-ТЗ оценивает «расширить GREETING_OCCASIONS до 20+» как S —
 * дни работы, правка enum и словарей. Аудит (находка 1.8) с этим не
 * согласился, и вот почему: повод в этом продукте не метка. От него
 * зависит, ЧТО именно Gemini напишет и как будет выглядеть сцена. Без
 * инструкции на каждый повод «Соболезнование» сгенерирует поздравление
 * в том же бодром тоне, что «День рождения», только со словом
 * «соболезную», — это не мелкий дефект текста, это продукт, который
 * пишет неуместное сообщение в самый неподходящий момент человеческой
 * жизни.
 *
 * Поэтому у каждого повода здесь четыре вещи, а не одна подпись:
 *  - `label` — как повод называется в промпте (русский: промпт
 *    сценария написан по-русски, см. `draftPersonalMessage`);
 *  - `intent` — что это за сообщение по сути. Это и есть та самая
 *    «промптовая ветка»: одна строка, которая отличает поздравление от
 *    сочувствия, извинения и поддержки;
 *  - `sceneMood` — как должна выглядеть сцена (английский: уходит в
 *    видео-промпт Grok/Hedra рядом с остальным английским описанием);
 *  - `tones` — какие тоны вообще допустимы. Проверяется НА СЕРВЕРЕ
 *    (`GreetingBriefService`), а не прячется в интерфейсе: §3
 *    компаньон-ТЗ требует именно этого, и правильно — интерфейс можно
 *    обойти запросом к API, а неуместный тон в соболезновании обойти
 *    нечем.
 *
 * `festive: false` отдельно от `tones`: он отвечает не за тон речи, а
 * за запасной текст и за то, можно ли вообще «поздравлять» (см.
 * `fallbackMessage`). Соболезнование с уважительным тоном — всё ещё не
 * поздравление.
 */

import { GreetingOccasion, GreetingTone } from './types/greeting.types';

export interface GreetingOccasionSpec {
  label: string;
  intent: string;
  sceneMood: string;
  tones: readonly GreetingTone[];
  /** Праздничный ли повод — решает вид запасного текста и декораций. */
  festive: boolean;
}

/** Обычный набор тонов — три исходных, которые были до этапа 2. */
const EVERYDAY_TONES: readonly GreetingTone[] = ['WARM', 'FUNNY', 'FORMAL'];

const FESTIVE_SCENE =
  'bright, cheerful setting with soft festive decor; warm light; celebratory but tasteful';
const CALM_SCENE =
  'quiet, restrained setting; soft muted colours; no decorations, no confetti, no balloons';

export const GREETING_OCCASION_SPECS: Readonly<
  Record<GreetingOccasion, GreetingOccasionSpec>
> = {
  BIRTHDAY: {
    label: 'день рождения',
    intent: 'Поздравь с днём рождения, пожелай хорошего года впереди.',
    sceneMood: FESTIVE_SCENE,
    tones: EVERYDAY_TONES,
    festive: true,
  },
  WEDDING: {
    label: 'свадьба',
    intent:
      'Поздравь молодожёнов со свадьбой, пожелай счастливой совместной жизни.',
    sceneMood: FESTIVE_SCENE,
    tones: EVERYDAY_TONES,
    festive: true,
  },
  ANNIVERSARY: {
    label: 'годовщина',
    intent: 'Поздравь с годовщиной, отметь пройденный вместе путь.',
    sceneMood: FESTIVE_SCENE,
    tones: EVERYDAY_TONES,
    festive: true,
  },
  NEW_YEAR: {
    label: 'Новый год',
    intent: 'Поздравь с Новым годом, пожелай хорошего наступающего года.',
    sceneMood: 'winter holiday setting with soft lights; warm, cosy mood',
    tones: EVERYDAY_TONES,
    festive: true,
  },
  CHRISTMAS: {
    label: 'Рождество',
    intent: 'Поздравь с Рождеством, пожелай мира и тепла в доме.',
    sceneMood: 'warm Christmas setting with soft lights; calm, cosy mood',
    tones: EVERYDAY_TONES,
    festive: true,
  },
  GRADUATION: {
    label: 'выпускной',
    intent:
      'Поздравь с окончанием учёбы, отметь достижение и пожелай удачи дальше.',
    sceneMood: FESTIVE_SCENE,
    tones: EVERYDAY_TONES,
    festive: true,
  },
  VALENTINES_DAY: {
    label: 'День святого Валентина',
    intent: 'Скажи тёплые слова любимому человеку в День святого Валентина.',
    sceneMood: 'soft romantic setting, warm light; tasteful, not kitschy',
    tones: EVERYDAY_TONES,
    festive: true,
  },
  WOMENS_DAY: {
    label: 'Международный женский день',
    intent:
      'Поздравь с женским днём — по-человечески, без клише про «хранительницу очага».',
    sceneMood: 'light spring setting with fresh flowers; bright, airy mood',
    tones: EVERYDAY_TONES,
    festive: true,
  },
  MOTHERS_DAY: {
    label: 'День матери',
    intent: 'Поздравь с Днём матери, скажи слова благодарности.',
    sceneMood: 'warm home setting with soft light; tender mood',
    tones: EVERYDAY_TONES,
    festive: true,
  },
  FATHERS_DAY: {
    label: 'День отца',
    intent: 'Поздравь с Днём отца, скажи слова благодарности.',
    sceneMood: 'warm home setting with soft light; sincere mood',
    tones: EVERYDAY_TONES,
    festive: true,
  },
  /**
   * Намеренно без даты в названии. Компаньон-ТЗ предлагало «23 Февраля /
   * День защитника», опираясь на «валюту UAH → Украина/СНГ», — но это
   * два разных праздника в разных странах и разные дни, а у продукта
   * пять локалей. Код повода нейтрален, конкретное название даёт
   * словарь своей локали.
   */
  DEFENDERS_DAY: {
    label: 'День защитников и защитниц',
    intent:
      'Поздравь с Днём защитников и защитниц, скажи слова уважения и благодарности.',
    sceneMood: 'restrained, dignified setting; calm, respectful mood',
    tones: ['WARM', 'FORMAL', 'RESPECTFUL'],
    festive: false,
  },
  TEACHERS_DAY: {
    label: 'День учителя',
    intent: 'Поздравь с Днём учителя, поблагодари за работу.',
    sceneMood: FESTIVE_SCENE,
    tones: EVERYDAY_TONES,
    festive: true,
  },
  FIRST_SCHOOL_DAY: {
    label: 'первый день в школе',
    intent:
      'Поздравь с началом учебного года, пожелай лёгкой учёбы и хороших друзей.',
    sceneMood: FESTIVE_SCENE,
    tones: EVERYDAY_TONES,
    festive: true,
  },
  NEW_BABY: {
    label: 'рождение ребёнка',
    intent:
      'Поздравь с рождением ребёнка, пожелай здоровья малышу и родителям.',
    sceneMood: 'soft, gentle setting in light pastel colours; tender mood',
    tones: EVERYDAY_TONES,
    festive: true,
  },
  BAPTISM: {
    label: 'крестины',
    intent: 'Поздравь с крестинами сдержанно и тепло, без шуток.',
    sceneMood: 'calm, light setting; quiet and solemn mood',
    tones: ['WARM', 'FORMAL', 'RESPECTFUL'],
    festive: false,
  },
  HOUSEWARMING: {
    label: 'новоселье',
    intent: 'Поздравь с новосельем, пожелай уюта в новом доме.',
    sceneMood: FESTIVE_SCENE,
    tones: EVERYDAY_TONES,
    festive: true,
  },
  PROMOTION: {
    label: 'повышение или новая работа',
    intent: 'Поздравь с повышением или новой работой, отметь заслуженность.',
    sceneMood: 'clean modern setting; confident, upbeat mood',
    tones: EVERYDAY_TONES,
    festive: true,
  },
  RETIREMENT: {
    label: 'выход на пенсию',
    intent:
      'Поздравь с выходом на пенсию, поблагодари за годы работы и пожелай хорошего отдыха.',
    sceneMood: 'warm, calm setting; grateful mood',
    tones: EVERYDAY_TONES,
    festive: true,
  },
  FAREWELL_COLLEAGUE: {
    label: 'прощание с коллегой',
    intent:
      'Попрощайся с коллегой, поблагодари за совместную работу и пожелай успеха на новом месте.',
    sceneMood: 'friendly office-like setting; warm but composed mood',
    tones: EVERYDAY_TONES,
    festive: false,
  },
  CORPORATE: {
    label: 'корпоративное поздравление',
    intent:
      'Поздравь от имени компании: по-деловому, но по-человечески, без канцелярита.',
    sceneMood: 'clean professional setting; composed, friendly mood',
    tones: EVERYDAY_TONES,
    festive: true,
  },
  /**
   * Три чувствительных повода. `FUNNY` у них отсутствует не по вкусовым
   * соображениям: шутка в соболезновании — это не неудачный тон, это
   * вред, нанесённый человеку в худший день его жизни.
   */
  APOLOGY: {
    label: 'извинение',
    intent:
      'Это ИЗВИНЕНИЕ, а не поздравление. Признай вину прямо, без оправданий и без шуток, не поздравляй и ничего не желай. Не используй восклицательные знаки.',
    sceneMood: CALM_SCENE,
    tones: ['WARM', 'RESPECTFUL'],
    festive: false,
  },
  GET_WELL: {
    label: 'пожелание выздоровления',
    intent:
      'Это слова ПОДДЕРЖКИ болеющему человеку. Не поздравляй: пожелай сил и скорого выздоровления, не шути про болезнь, не давай медицинских советов и не обещай, что всё точно будет хорошо.',
    sceneMood: CALM_SCENE,
    tones: ['WARM', 'SUPPORTIVE'],
    festive: false,
  },
  CONDOLENCE: {
    label: 'соболезнование',
    intent:
      'Это СОБОЛЕЗНОВАНИЕ. Не поздравляй, не желай радости и веселья, не используй восклицательные знаки и праздничные слова. Вырази сочувствие сдержанно и коротко, предложи поддержку.',
    sceneMood: CALM_SCENE,
    tones: ['RESPECTFUL', 'SUPPORTIVE'],
    festive: false,
  },
  OTHER: {
    label: 'особый повод',
    intent:
      'Повод описан пользователем своими словами — опирайся на это описание и не подменяй его типовым поздравлением.',
    sceneMood: 'neutral, well-lit setting appropriate for a personal message',
    tones: EVERYDAY_TONES,
    festive: true,
  },
};

export const GREETING_TONE_LABELS: Readonly<Record<GreetingTone, string>> = {
  WARM: 'тёплый, душевный',
  FUNNY: 'с юмором, но уважительно',
  FORMAL: 'официальный, сдержанный',
  SUPPORTIVE: 'поддерживающий, ободряющий, без наигранного оптимизма',
  RESPECTFUL: 'уважительный и сдержанный, без праздничности',
};

/** Допустим ли тон для повода. */
export function toneAllowedFor(
  occasion: GreetingOccasion,
  tone: GreetingTone,
): boolean {
  return GREETING_OCCASION_SPECS[occasion].tones.includes(tone);
}

export function allowedTonesFor(
  occasion: GreetingOccasion,
): readonly GreetingTone[] {
  return GREETING_OCCASION_SPECS[occasion].tones;
}

/**
 * Тон по умолчанию, когда пользователь его не выбрал.
 *
 * Раньше в этом месте стояло жёсткое `'WARM'`. С появлением
 * чувствительных поводов это стало ловушкой: у CONDOLENCE тон `WARM`
 * недопустим, и бриф-соболезнование без явного тона упал бы на
 * собственной же валидации при первой правке. Первый допустимый тон
 * повода — значение, которое всегда проходит проверку, поэтому порядок
 * в `tones` не произволен: там первым стоит тот, который уместен по
 * умолчанию.
 */
export function defaultToneFor(occasion: GreetingOccasion): GreetingTone {
  return GREETING_OCCASION_SPECS[occasion].tones[0];
}

/**
 * Запасной текст, когда Gemini не ответил. Прежняя версия была одна на
 * все поводы и начиналась словом «поздравляем» — для соболезнования и
 * извинения это ровно та ошибка, ради которой написан весь этот файл.
 */
export function fallbackMessage(
  occasion: GreetingOccasion,
  recipientName: string,
  occasionText: string,
): string {
  const spec = GREETING_OCCASION_SPECS[occasion];
  if (occasion === 'CONDOLENCE') {
    return `${recipientName}, примите наши искренние соболезнования. Мы рядом.`;
  }
  if (occasion === 'APOLOGY') {
    return `${recipientName}, простите нас. Нам действительно жаль.`;
  }
  if (occasion === 'GET_WELL') {
    return `${recipientName}, сил вам и скорейшего выздоровления.`;
  }
  if (!spec.festive) {
    return `${recipientName}, эти слова — для вас.`;
  }
  return `${recipientName}, поздравляем с ${
    occasion === 'OTHER' ? 'этим особым днём' : occasionText
  }! Пусть всё будет хорошо.`;
}
