/**
 * Закрытые списки фраз голосового разбора и ответы без модели:
 * нормализация реплики, согласие на генерацию, «да»/«нет», справка и
 * навигация по шагам (K6).
 *
 * Отдельно от проверки значений — потому что это чистые таблицы слов на
 * пяти языках, которые правят чаще всего (добавить синоним) и сверяют
 * спеками перебором; держать их рядом с логикой значило бы листать
 * тысячу строк, чтобы добавить одно слово. Зависят только от контракта.
 * Внешний вход — по-прежнему `greeting-voice-intent.ts` (реэкспорт).
 */

import { SUPPORTED_LOCALES, SupportedLocale } from './locale';
import { VoiceNavigateTarget } from './greeting-voice-contract';

// ── Нормализация реплики и закрытые списки ──────────────────────────────

/**
 * Реплика для сравнения со списками: нижний регистр, «ё» как «е»,
 * апострофы выброшены (укр. «п'ять», англ. «that's»), прочие знаки — в
 * пробел, пробелы схлопнуты.
 */
export function normalizeUtterance(text: string | null | undefined): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/['’ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Вежливые слова, которые не меняют смысла короткой команды. */
const POLITE_WORDS: readonly string[] = [
  'пожалуйста',
  'будь ласка',
  'please',
  'bitte',
  'por favor',
];

export function stripPolite(normalized: string): string {
  let t = ` ${normalized} `;
  for (const w of POLITE_WORDS) t = t.split(` ${w} `).join(' ');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Закрытый список согласия на генерацию (§4А.7.4), по языкам. Только
 * явные команды: «генерируй», «создавай», «согласен». НЕ «да», НЕ «ага»,
 * НЕ «ок» — «да» — обычное слово разговора, и оплатить рендер словом,
 * которое человек мог сказать соседу, нельзя (спек проверяет, что
 * ни одно из слов подтверждения сюда не попало).
 *
 * Списки — в нормализованной форме (`normalizeUtterance`).
 */
export const CONSENT_PHRASES: Readonly<
  Record<SupportedLocale, readonly string[]>
> = {
  ru: [
    'генерируй',
    'генерируйте',
    'генерируй ролик',
    'генерируй видео',
    'создавай',
    'создавайте',
    'создавай ролик',
    'создавай видео',
    'согласен',
    'согласна',
    'запускай генерацию',
  ],
  uk: [
    'генеруй',
    'генеруйте',
    'генеруй ролик',
    'генеруй відео',
    'створюй',
    'створюйте',
    'створюй ролик',
    'створюй відео',
    'згоден',
    'згодна',
    'запускай генерацію',
  ],
  en: [
    'generate',
    'generate it',
    'generate the video',
    'generate video',
    'create it',
    'i agree',
  ],
  de: [
    'generieren',
    'generiere',
    'generiere das video',
    'generiere video',
    'erstellen',
    'erstelle',
    'einverstanden',
    'ich bin einverstanden',
  ],
  es: [
    'genera',
    'generar',
    'genera el video',
    'genera el vídeo',
    'genera video',
    'genera vídeo',
    'crea',
    'crear',
    'de acuerdo',
    'estoy de acuerdo',
    'acepto',
  ],
};

/** Как подсказать согласие человеку — первая фраза списка его языка. */
export function consentHint(locale: SupportedLocale): string {
  return CONSENT_PHRASES[locale][0];
}

/**
 * Вся реплика — фраза из закрытого списка (с точностью до вежливых
 * слов). Не «содержит»: «не генерируй пока» содержит «генерируй».
 */
export function isConsentPhrase(text: string | null | undefined): boolean {
  const t = stripPolite(normalizeUtterance(text));
  if (!t) return false;
  return SUPPORTED_LOCALES.some((l) => CONSENT_PHRASES[l].includes(t));
}

/**
 * Короткие ответы на карточку «я понял так». Отдельный путь без модели:
 * «да» и «нет» — самые частые реплики, и платить за их разбор незачем.
 * Только ЦЕЛАЯ реплика: «нет, имя Марина» — не отмена, а уточнение, и
 * оно уходит модели.
 */
export const CONFIRM_PHRASES: readonly string[] = [
  'да',
  'верно',
  'все верно',
  'правильно',
  'подтверждаю',
  'так',
  'вірно',
  'все вірно',
  'підтверджую',
  'yes',
  'correct',
  'thats right',
  'confirm',
  'ja',
  'richtig',
  'stimmt',
  'si',
  'sí',
  'correcto',
  'confirmo',
];

export const CANCEL_PHRASES: readonly string[] = [
  // Короткое uk «Ні» может распознаваться как «Не»: только отмена карточки.
  'не',
  'нет',
  'не так',
  'неверно',
  'отмена',
  'отмени',
  'ні',
  'невірно',
  'скасуй',
  'скасувати',
  'no',
  'cancel',
  'wrong',
  'nein',
  'falsch',
  'abbrechen',
  'cancelar',
  'incorrecto',
];

export function quickPendingAnswer(
  text: string | null | undefined,
): 'confirm' | 'cancel' | null {
  const t = stripPolite(normalizeUtterance(text));
  if (!t) return null;
  // «Согласен» при карточке на экране — ответ на неё (см. `resolveIntent`).
  if (CONFIRM_PHRASES.includes(t) || isConsentPhrase(t)) return 'confirm';
  if (CANCEL_PHRASES.includes(t)) return 'cancel';
  return null;
}

// ── K6: навигация и справка без модели (§4А.7.2, §4А.7.3) ──────────────

/**
 * «Помощь», «что здесь», «как это работает» — на пяти языках. Закрытый
 * список по образцу `CONFIRM_PHRASES`: самые короткие и частые реплики
 * не должны стоить платного разбора. Всё, чего здесь нет, по-прежнему
 * понимает модель (`help` в промпте) — список лишь срезает очевидное.
 * Нормализованная форма (`normalizeUtterance`): без знаков, «ё» → «е».
 */
export const HELP_PHRASES: Readonly<
  Record<SupportedLocale, readonly string[]>
> = {
  ru: [
    'помощь',
    'помоги',
    'помогите',
    'справка',
    'информация',
    'инфо',
    'что здесь',
    'что тут',
    'что это',
    'что это такое',
    'как это работает',
    'как это устроено',
    'что здесь делать',
    'что тут делать',
    'что делать',
    'объясни',
    'подскажи',
  ],
  uk: [
    'допомога',
    'допоможи',
    'допоможіть',
    'довідка',
    'інформація',
    'інфо',
    'що тут',
    'що це',
    'що це таке',
    'як це працює',
    'що тут робити',
    'що робити',
    'поясни',
    'підкажи',
  ],
  en: [
    'help',
    'help me',
    'info',
    'information',
    'whats this',
    'what is this',
    'whats here',
    'what is here',
    'how does this work',
    'how does it work',
    'how it works',
    'what do i do here',
    'what should i do',
    'explain',
  ],
  de: [
    'hilfe',
    'info',
    'infos',
    'information',
    'informationen',
    'was ist das',
    'was ist hier',
    'wie funktioniert das',
    'wie geht das',
    'was soll ich hier tun',
    'was muss ich tun',
    'erklär mal',
    'erkläre',
  ],
  es: [
    'ayuda',
    'ayúdame',
    'ayudame',
    'info',
    'información',
    'informacion',
    'qué es esto',
    'que es esto',
    'qué hay aquí',
    'que hay aqui',
    'cómo funciona',
    'como funciona',
    'cómo funciona esto',
    'como funciona esto',
    'qué hago aquí',
    'que hago aqui',
    'explícame',
    'explicame',
  ],
};

/** «Дальше» и «назад» — целой репликой, на пяти языках. */
export const NAV_STEP_PHRASES: Readonly<
  Record<SupportedLocale, Readonly<Record<'next' | 'back', readonly string[]>>>
> = {
  ru: {
    next: [
      'дальше',
      'далее',
      'вперед',
      'следующий',
      'следующий шаг',
      'на следующий шаг',
      'к следующему шагу',
      'идем дальше',
      'давай дальше',
    ],
    back: [
      'назад',
      'обратно',
      'вернись',
      'вернись назад',
      'шаг назад',
      'предыдущий шаг',
      'на предыдущий шаг',
      'к предыдущему шагу',
    ],
  },
  uk: {
    next: [
      'далі',
      'вперед',
      'наступний',
      'наступний крок',
      'на наступний крок',
      'до наступного кроку',
      'йдемо далі',
      'давай далі',
    ],
    back: [
      'назад',
      'повернись',
      'повернись назад',
      'крок назад',
      'попередній крок',
      'на попередній крок',
      'до попереднього кроку',
    ],
  },
  en: {
    next: ['next', 'next step', 'go next', 'forward', 'go forward', 'move on'],
    back: ['back', 'go back', 'previous', 'previous step', 'step back'],
  },
  de: {
    next: ['weiter', 'nächster schritt', 'zum nächsten schritt', 'vorwärts'],
    back: [
      'zurück',
      'geh zurück',
      'gehe zurück',
      'schritt zurück',
      'vorheriger schritt',
      'zum vorherigen schritt',
    ],
  },
  es: {
    next: ['siguiente', 'siguiente paso', 'al siguiente paso', 'adelante'],
    back: [
      'atrás',
      'atras',
      'volver',
      'vuelve',
      'vuelve atrás',
      'vuelve atras',
      'anterior',
      'paso anterior',
      'al paso anterior',
    ],
  },
};

type NamedStep = Exclude<VoiceNavigateTarget, 'next' | 'back'>;

/**
 * Имена четырёх позиций степпера в речи («сценарий», «к сценарию») и
 * глаголы перехода. Это слова, а не второй список шагов: какие шаги
 * есть и куда можно, решает клиент по `greetingSteps`/`toStepsView`
 * (§4А.7.2); сервер лишь узнаёт в реплике одну из шести закрытых целей.
 */
export const NAV_STEP_WORDS: Readonly<
  Record<SupportedLocale, Readonly<Record<NamedStep, readonly string[]>>>
> = {
  ru: {
    brief: ['бриф', 'брифу', 'повод', 'поводу'],
    references: [
      'фото',
      'фотографии',
      'фотографиям',
      'референсы',
      'референсам',
      'картинки',
      'картинкам',
    ],
    script: ['сценарий', 'сценарию'],
    video: ['видео', 'ролик', 'ролику'],
  },
  uk: {
    brief: ['бриф', 'брифу', 'привід', 'приводу'],
    references: [
      'фото',
      'фотографії',
      'фотографій',
      'референси',
      'референсів',
      'картинки',
    ],
    script: ['сценарій', 'сценарію'],
    video: ['відео', 'ролик', 'ролика', 'ролику'],
  },
  en: {
    brief: ['brief', 'the brief', 'occasion', 'the occasion'],
    references: [
      'photos',
      'the photos',
      'references',
      'the references',
      'reference images',
      'the reference images',
      'images',
    ],
    script: ['script', 'the script'],
    video: ['video', 'the video'],
  },
  de: {
    brief: ['brief', 'briefing', 'anlass', 'den brief', 'das briefing'],
    references: [
      'fotos',
      'die fotos',
      'bilder',
      'die bilder',
      'referenzen',
      'referenzbilder',
      'die referenzbilder',
    ],
    script: ['skript', 'das skript', 'drehbuch', 'das drehbuch'],
    video: ['video', 'das video'],
  },
  es: {
    brief: ['brief', 'el brief', 'ocasión', 'ocasion', 'la ocasión'],
    references: [
      'fotos',
      'las fotos',
      'imágenes',
      'imagenes',
      'las imágenes',
      'referencias',
      'las referencias',
    ],
    script: ['guion', 'guión', 'el guion', 'el guión'],
    video: ['video', 'vídeo', 'el video', 'el vídeo'],
  },
};

/** Глаголы перед именем шага; пустая строка — имя само по себе. */
export const NAV_STEP_PREFIXES: Readonly<
  Record<SupportedLocale, readonly string[]>
> = {
  ru: [
    '',
    'к',
    'на',
    'перейди к',
    'перейди на',
    'открой',
    'покажи',
    'вернись к',
    'вернись на',
    'давай к',
    'иди к',
  ],
  uk: [
    '',
    'до',
    'на',
    'перейди до',
    'перейди на',
    'відкрий',
    'покажи',
    'повернись до',
    'повернись на',
    'давай до',
  ],
  en: [
    '',
    'to',
    'go to',
    'open',
    'show',
    'show me',
    'back to',
    'go back to',
    'take me to',
  ],
  de: [
    '',
    'zu',
    'zum',
    'zur',
    'zu den',
    'geh zu',
    'geh zum',
    'gehe zu',
    'gehe zum',
    'öffne',
    'zeig',
    'zeig mir',
    'zurück zu',
    'zurück zum',
  ],
  es: [
    '',
    'a',
    'al',
    'ir a',
    'ir al',
    've a',
    've al',
    'abre',
    'muestra',
    'muéstrame',
    'vuelve a',
    'vuelve al',
    'llévame a',
    'llévame al',
  ],
};

export type QuickNavigationIntent =
  | { kind: 'navigate'; to: VoiceNavigateTarget }
  | { kind: 'help' };

/** Реплика → интент; собирается один раз из списков выше. */
const QUICK_NAVIGATION: ReadonlyMap<string, QuickNavigationIntent> = (() => {
  const map = new Map<string, QuickNavigationIntent>();
  for (const l of SUPPORTED_LOCALES) {
    for (const p of HELP_PHRASES[l]) map.set(p, { kind: 'help' });
    for (const to of ['next', 'back'] as const) {
      for (const p of NAV_STEP_PHRASES[l][to]) {
        map.set(p, { kind: 'navigate', to });
      }
    }
    for (const to of Object.keys(NAV_STEP_WORDS[l]) as NamedStep[]) {
      for (const word of NAV_STEP_WORDS[l][to]) {
        for (const prefix of NAV_STEP_PREFIXES[l]) {
          map.set(prefix ? `${prefix} ${word}` : word, {
            kind: 'navigate',
            to,
          });
        }
      }
    }
  }
  return map;
})();

/**
 * «Дальше», «к сценарию», «что здесь?» — без модели. Только ЦЕЛАЯ
 * реплика (с точностью до вежливых слов): «дальше напиши, что она
 * любит море» — диктовка, и она уходит модели. Цель — всегда из
 * закрытого `VOICE_NAVIGATE_TARGETS`. Вызывается только без карточки
 * «я понял так» на экране: при ней короткое «назад» может значить
 * «нет», и это решает модель, видящая карточку.
 */
export function quickNavigationAnswer(
  text: string | null | undefined,
): QuickNavigationIntent | null {
  const t = stripPolite(normalizeUtterance(text));
  if (!t) return null;
  return QUICK_NAVIGATION.get(t) ?? null;
}
