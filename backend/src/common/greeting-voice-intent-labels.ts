/**
 * Подписи значений для карточки «я понял так» — этап K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2 п.3.
 *
 * КОПИЯ подписей из словарей фронтенда (`frontend/src/dictionaries/*.json`,
 * раздел `greetingVideoWizard`): человек в карточке подтверждения должен
 * увидеть ТЕ ЖЕ слова, что на кнопках брифа, иначе «Тон: С юмором» на
 * экране и «Тон: весёлый» в карточке читаются как два разных выбора.
 * Кросс-импорта между пакетами нет (тот же довод, что у `qa-hooks.ts`),
 * поэтому копия осознанная, а держит её спек
 * `greeting-voice-intent-labels.spec.ts`: он сверяет каждую строку со
 * словарями и падает на первой разошедшейся.
 */

import type { SupportedLocale } from './locale';

export const OCCASION_LABELS: Readonly<
  Record<SupportedLocale, Readonly<Record<string, string>>>
> = {
  ru: {
    BIRTHDAY: 'День рождения',
    WEDDING: 'Свадьба',
    ANNIVERSARY: 'Годовщина',
    NEW_YEAR: 'Новый год',
    CHRISTMAS: 'Рождество',
    GRADUATION: 'Выпускной',
    VALENTINES_DAY: 'День святого Валентина',
    WOMENS_DAY: 'Женский день',
    MOTHERS_DAY: 'День матери',
    FATHERS_DAY: 'День отца',
    DEFENDERS_DAY: 'День защитников и защитниц',
    TEACHERS_DAY: 'День учителя',
    FIRST_SCHOOL_DAY: 'Первый день в школе',
    NEW_BABY: 'Рождение ребёнка',
    BAPTISM: 'Крестины',
    HOUSEWARMING: 'Новоселье',
    PROMOTION: 'Повышение или новая работа',
    RETIREMENT: 'Выход на пенсию',
    FAREWELL_COLLEAGUE: 'Прощание с коллегой',
    CORPORATE: 'Корпоративное поздравление',
    APOLOGY: 'Извинение',
    GET_WELL: 'Выздоравливай',
    CONDOLENCE: 'Соболезнование',
    OTHER: 'Другой повод',
  },
  uk: {
    BIRTHDAY: 'День народження',
    WEDDING: 'Весілля',
    ANNIVERSARY: 'Річниця',
    NEW_YEAR: 'Новий рік',
    CHRISTMAS: 'Різдво',
    GRADUATION: 'Випускний',
    VALENTINES_DAY: 'День святого Валентина',
    WOMENS_DAY: 'Жіночий день',
    MOTHERS_DAY: 'День матері',
    FATHERS_DAY: 'День батька',
    DEFENDERS_DAY: 'День захисників і захисниць',
    TEACHERS_DAY: 'День вчителя',
    FIRST_SCHOOL_DAY: 'Перший день у школі',
    NEW_BABY: 'Народження дитини',
    BAPTISM: 'Хрестини',
    HOUSEWARMING: 'Новосілля',
    PROMOTION: 'Підвищення або нова робота',
    RETIREMENT: 'Вихід на пенсію',
    FAREWELL_COLLEAGUE: 'Прощання з колегою',
    CORPORATE: 'Корпоративне привітання',
    APOLOGY: 'Вибачення',
    GET_WELL: 'Одужуй',
    CONDOLENCE: 'Співчуття',
    OTHER: 'Інший привід',
  },
  en: {
    BIRTHDAY: 'Birthday',
    WEDDING: 'Wedding',
    ANNIVERSARY: 'Anniversary',
    NEW_YEAR: 'New Year',
    CHRISTMAS: 'Christmas',
    GRADUATION: 'Graduation',
    VALENTINES_DAY: "Valentine's Day",
    WOMENS_DAY: "Women's Day",
    MOTHERS_DAY: "Mother's Day",
    FATHERS_DAY: "Father's Day",
    DEFENDERS_DAY: 'Defenders Day',
    TEACHERS_DAY: "Teacher's Day",
    FIRST_SCHOOL_DAY: 'First day of school',
    NEW_BABY: 'New baby',
    BAPTISM: 'Christening',
    HOUSEWARMING: 'Housewarming',
    PROMOTION: 'Promotion or new job',
    RETIREMENT: 'Retirement',
    FAREWELL_COLLEAGUE: 'Farewell to a colleague',
    CORPORATE: 'Corporate greeting',
    APOLOGY: 'Apology',
    GET_WELL: 'Get well soon',
    CONDOLENCE: 'Condolence',
    OTHER: 'Other occasion',
  },
  de: {
    BIRTHDAY: 'Geburtstag',
    WEDDING: 'Hochzeit',
    ANNIVERSARY: 'Jahrestag',
    NEW_YEAR: 'Neujahr',
    CHRISTMAS: 'Weihnachten',
    GRADUATION: 'Abschluss',
    VALENTINES_DAY: 'Valentinstag',
    WOMENS_DAY: 'Frauentag',
    MOTHERS_DAY: 'Muttertag',
    FATHERS_DAY: 'Vatertag',
    DEFENDERS_DAY: 'Tag der Verteidiger',
    TEACHERS_DAY: 'Lehrertag',
    FIRST_SCHOOL_DAY: 'Erster Schultag',
    NEW_BABY: 'Geburt eines Kindes',
    BAPTISM: 'Taufe',
    HOUSEWARMING: 'Einweihungsfeier',
    PROMOTION: 'Beförderung oder neuer Job',
    RETIREMENT: 'Ruhestand',
    FAREWELL_COLLEAGUE: 'Abschied von einer Kollegin oder einem Kollegen',
    CORPORATE: 'Firmengruß',
    APOLOGY: 'Entschuldigung',
    GET_WELL: 'Gute Besserung',
    CONDOLENCE: 'Beileid',
    OTHER: 'Anderer Anlass',
  },
  es: {
    BIRTHDAY: 'Cumpleaños',
    WEDDING: 'Boda',
    ANNIVERSARY: 'Aniversario',
    NEW_YEAR: 'Año Nuevo',
    CHRISTMAS: 'Navidad',
    GRADUATION: 'Graduación',
    VALENTINES_DAY: 'San Valentín',
    WOMENS_DAY: 'Día de la Mujer',
    MOTHERS_DAY: 'Día de la Madre',
    FATHERS_DAY: 'Día del Padre',
    DEFENDERS_DAY: 'Día de los Defensores',
    TEACHERS_DAY: 'Día del Maestro',
    FIRST_SCHOOL_DAY: 'Primer día de escuela',
    NEW_BABY: 'Nacimiento de un bebé',
    BAPTISM: 'Bautizo',
    HOUSEWARMING: 'Estreno de casa',
    PROMOTION: 'Ascenso o nuevo trabajo',
    RETIREMENT: 'Jubilación',
    FAREWELL_COLLEAGUE: 'Despedida de un colega',
    CORPORATE: 'Felicitación corporativa',
    APOLOGY: 'Disculpa',
    GET_WELL: 'Que te mejores',
    CONDOLENCE: 'Pésame',
    OTHER: 'Otra ocasión',
  },
};

export const TONE_LABELS: Readonly<
  Record<SupportedLocale, Readonly<Record<string, string>>>
> = {
  ru: {
    WARM: 'Тёплый, душевный',
    FUNNY: 'С юмором',
    FORMAL: 'Официальный',
    SUPPORTIVE: 'Поддерживающий',
    RESPECTFUL: 'Уважительный, сдержанный',
  },
  uk: {
    WARM: 'Теплий, щирий',
    FUNNY: 'З гумором',
    FORMAL: 'Офіційний',
    SUPPORTIVE: 'Підтримувальний',
    RESPECTFUL: 'Шанобливий, стриманий',
  },
  en: {
    WARM: 'Warm, heartfelt',
    FUNNY: 'Playful',
    FORMAL: 'Formal',
    SUPPORTIVE: 'Supportive',
    RESPECTFUL: 'Respectful, restrained',
  },
  de: {
    WARM: 'Warm, herzlich',
    FUNNY: 'Verspielt',
    FORMAL: 'Formell',
    SUPPORTIVE: 'Unterstützend',
    RESPECTFUL: 'Respektvoll, zurückhaltend',
  },
  es: {
    WARM: 'Cálido, sincero',
    FUNNY: 'Divertido',
    FORMAL: 'Formal',
    SUPPORTIVE: 'De apoyo',
    RESPECTFUL: 'Respetuoso, contenido',
  },
};

export const PRESENTER_HEDRA_LABEL: Readonly<Record<SupportedLocale, string>> =
  {
    ru: 'Говорящий аватар (Hedra)',
    uk: 'Говорючий аватар (Hedra)',
    en: 'Talking avatar (Hedra)',
    de: 'Sprechender Avatar (Hedra)',
    es: 'Avatar parlante (Hedra)',
  };

export const TONE_UNAVAILABLE: Readonly<Record<SupportedLocale, string>> = {
  ru: 'недоступен для этого повода',
  uk: 'недоступний для цього приводу',
  en: 'not available for this occasion',
  de: 'für diesen Anlass nicht verfügbar',
  es: 'no disponible para esta ocasión',
};

export const HEDRA_PREMIUM_ONLY: Readonly<Record<SupportedLocale, string>> = {
  ru: 'Доступно только на тарифе PREMIUM',
  uk: 'Доступно лише на тарифі PREMIUM',
  en: 'Available on the PREMIUM plan only',
  de: 'Nur im PREMIUM-Tarif verfügbar',
  es: 'Disponible solo en el plan PREMIUM',
};

/**
 * Подписи полей брифа — как над полями на экране (дословно). Названия
 * полей в карточке и переспросе выводятся из них (`fieldTitle` в
 * `greeting-voice-intent.ts`): «От кого (необязательно)» → «От кого».
 */
export const BRIEF_FIELD_LABELS: Readonly<
  Record<SupportedLocale, Readonly<Record<string, string>>>
> = {
  ru: {
    occasionLabel: 'Повод',
    customOccasionLabel: 'Какой именно повод',
    moodLabel: 'Какое это событие по настроению?',
    recipientNameLabel: 'Кому',
    senderNameLabel: 'От кого (необязательно)',
    toneLabel: 'Тон',
    personalMessageLabel: 'Текст поздравления (необязательно)',
    scriptLanguageLabel: 'Язык поздравления',
    presenterProviderLabel: 'Ведущий',
    resolutionLabel: 'Качество',
    occasionDateLabel: 'Дата события (необязательно)',
  },
  uk: {
    occasionLabel: 'Привід',
    customOccasionLabel: 'Який саме привід',
    moodLabel: 'Який настрій у цієї події?',
    recipientNameLabel: 'Кому',
    senderNameLabel: "Від кого (необов'язково)",
    toneLabel: 'Тон',
    personalMessageLabel: "Текст привітання (необов'язково)",
    scriptLanguageLabel: 'Мова привітання',
    presenterProviderLabel: 'Ведучий',
    resolutionLabel: 'Якість',
    occasionDateLabel: "Дата події (необов'язково)",
  },
  en: {
    occasionLabel: 'Occasion',
    customOccasionLabel: "What's the occasion",
    moodLabel: 'What is the mood of this occasion?',
    recipientNameLabel: 'Recipient',
    senderNameLabel: 'From (optional)',
    toneLabel: 'Tone',
    personalMessageLabel: 'Greeting text (optional)',
    scriptLanguageLabel: 'Greeting language',
    presenterProviderLabel: 'Presenter',
    resolutionLabel: 'Quality',
    occasionDateLabel: 'Event date (optional)',
  },
  de: {
    occasionLabel: 'Anlass',
    customOccasionLabel: 'Welcher Anlass genau',
    moodLabel: 'Welche Stimmung hat dieser Anlass?',
    recipientNameLabel: 'Empfänger',
    senderNameLabel: 'Von (optional)',
    toneLabel: 'Ton',
    personalMessageLabel: 'Grußtext (optional)',
    scriptLanguageLabel: 'Sprache des Grußes',
    presenterProviderLabel: 'Moderator',
    resolutionLabel: 'Qualität',
    occasionDateLabel: 'Datum des Ereignisses (optional)',
  },
  es: {
    occasionLabel: 'Ocasión',
    customOccasionLabel: '¿Cuál es la ocasión?',
    moodLabel: '¿Qué tono emocional tiene esta ocasión?',
    recipientNameLabel: 'Destinatario',
    senderNameLabel: 'De parte de (opcional)',
    toneLabel: 'Tono',
    personalMessageLabel: 'Texto de felicitación (opcional)',
    scriptLanguageLabel: 'Idioma de la felicitación',
    presenterProviderLabel: 'Presentador',
    resolutionLabel: 'Calidad',
    occasionDateLabel: 'Fecha del evento (opcional)',
  },
};

/**
 * Подписи и причины карточек сессии (K5) — как на экране, дословно.
 * Названия элементов в карточке «я понял так» и переспросе выводятся из
 * них (`SESSION_FIELD_NAMES`), причины отказа — ТЕ ЖЕ строки, что экран
 * показывает у недоступного (§4А.7.1: «отказ той же причиной»).
 */
export const SESSION_SCREEN_LABELS: Readonly<
  Record<SupportedLocale, Readonly<Record<string, string>>>
> = {
  ru: {
    referenceLabelLabel: 'Подпись',
    referenceDescLabel: 'Описание (необязательно)',
    editScriptLabel: 'Текст сообщения',
    senderVoiceHeading: 'Голос отправителя',
    musicHeading: 'Музыка',
    musicLibrarySearch: 'Искать',
    cardsHeading: 'Подписи в кадре',
    cardsTitleLabel: 'В начале',
    cardsClosingLabel: 'В конце',
    stickerHeading: 'Наклейка',
    stickerSearch: 'Найти',
    stickerPicked: 'Где показывать:',
    scenesHeading: 'Сколько сцен',
    stickerUnavailable:
      'Наклейки недоступны для этого повода: поиск картинок нельзя ограничить настроением.',
    referencesLockedHint:
      'Сценарий уже собран, поэтому фото закрыты для правки. Они откроются снова, когда сценарий сбросится: так бывает после сохранения брифа с новым поводом, именами, тоном, текстом, языком или ведущим — рядом с «Сохранено» появится «соберите сценарий заново».',
    scriptEmpty: 'Сценарий ещё не собран.',
  },
  uk: {
    referenceLabelLabel: 'Підпис',
    referenceDescLabel: "Опис (необов'язково)",
    editScriptLabel: 'Текст повідомлення',
    senderVoiceHeading: 'Голос відправника',
    musicHeading: 'Музика',
    musicLibrarySearch: 'Шукати',
    cardsHeading: 'Підписи в кадрі',
    cardsTitleLabel: 'На початку',
    cardsClosingLabel: 'Наприкінці',
    stickerHeading: 'Наліпка',
    stickerSearch: 'Знайти',
    stickerPicked: 'Де показувати:',
    scenesHeading: 'Скільки сцен',
    stickerUnavailable:
      'Наліпки недоступні для цього приводу: пошук картинок не можна обмежити настроєм.',
    referencesLockedHint:
      'Сценарій уже зібрано, тому фото закриті для правки. Вони відкриються знову, коли сценарій скинеться: так буває після збереження брифу з новим приводом, іменами, тоном, текстом, мовою або ведучим — поруч зі «Збережено» зʼявиться «зберіть сценарій заново».',
    scriptEmpty: 'Сценарій ще не зібрано.',
  },
  en: {
    referenceLabelLabel: 'Label',
    referenceDescLabel: 'Description (optional)',
    editScriptLabel: 'Message text',
    senderVoiceHeading: "Sender's voice",
    musicHeading: 'Music',
    musicLibrarySearch: 'Search',
    cardsHeading: 'On-screen captions',
    cardsTitleLabel: 'At the start',
    cardsClosingLabel: 'At the end',
    stickerHeading: 'Sticker',
    stickerSearch: 'Search',
    stickerPicked: 'Where to put it:',
    scenesHeading: 'How many shots',
    stickerUnavailable:
      "Stickers are not available for this occasion: image search can't be limited by mood.",
    referencesLockedHint:
      'The script is already built, so photos are locked. They unlock when the script is reset: this happens after you save the brief with a new occasion, names, tone, text, language or presenter — “build the script again” will appear next to “Saved”.',
    scriptEmpty: 'No script generated yet.',
  },
  de: {
    referenceLabelLabel: 'Beschriftung',
    referenceDescLabel: 'Beschreibung (optional)',
    editScriptLabel: 'Text der Nachricht',
    senderVoiceHeading: 'Stimme des Absenders',
    musicHeading: 'Musik',
    musicLibrarySearch: 'Suchen',
    cardsHeading: 'Einblendungen',
    cardsTitleLabel: 'Am Anfang',
    cardsClosingLabel: 'Am Ende',
    stickerHeading: 'Sticker',
    stickerSearch: 'Suchen',
    stickerPicked: 'Wohin damit:',
    scenesHeading: 'Wie viele Einstellungen',
    stickerUnavailable:
      'Sticker sind für diesen Anlass nicht verfügbar: Die Bildsuche lässt sich nicht nach Stimmung einschränken.',
    referencesLockedHint:
      'Das Skript steht bereits, daher sind die Fotos gesperrt. Sie werden wieder frei, wenn das Skript zurückgesetzt wird: nach dem Speichern des Briefings mit neuem Anlass, Namen, Ton, Text, Sprache oder Moderator — neben „Gespeichert“ erscheint dann „Skript neu erstellen“.',
    scriptEmpty: 'Noch kein Skript generiert.',
  },
  es: {
    referenceLabelLabel: 'Etiqueta',
    referenceDescLabel: 'Descripción (opcional)',
    editScriptLabel: 'Texto del mensaje',
    senderVoiceHeading: 'Voz del remitente',
    musicHeading: 'Música',
    musicLibrarySearch: 'Buscar',
    cardsHeading: 'Rótulos en pantalla',
    cardsTitleLabel: 'Al principio',
    cardsClosingLabel: 'Al final',
    stickerHeading: 'Pegatina',
    stickerSearch: 'Buscar',
    stickerPicked: 'Dónde colocarla:',
    scenesHeading: 'Cuántos planos',
    stickerUnavailable:
      'Las pegatinas no están disponibles para esta ocasión: la búsqueda de imágenes no se puede limitar por ánimo.',
    referencesLockedHint:
      'El guion ya está montado, así que las fotos están bloqueadas. Se desbloquean cuando el guion se restablece: ocurre al guardar el brief con otra ocasión, nombres, tono, texto, idioma o presentador; junto a «Guardado» aparecerá «vuelve a montar el guion».',
    scriptEmpty: 'Aún no se ha generado ningún guion.',
  },
};
