/**
 * Форма текстов лендинга Story‑Tales — одна на пять локалей.
 *
 * Тексты живут не в общих `dictionaries/*.json`, а отдельными модулями,
 * которые импортирует только серверная страница `app/(stories)/[locale]/stories`.
 * Причина та же, что у вырезки `persona` в `get-dictionary.ts`: общий
 * словарь целиком уходит клиентскому провайдеру и попадает в RSC-данные
 * КАЖДОЙ страницы лендинга — семейные тексты нечего возить в HTML
 * рекламной главной, блога и поздравлений.
 *
 * Паритет пяти локалей (одинаковые ключи, одинаковая длина списков,
 * непустые строки) держит `scripts/stories-copy.test.ts`, а форму на
 * этапе типов — этот интерфейс: пропущенный ключ — ошибка `tsc`.
 */

/** Рабочее написание интерфейса — с неразрывным дефисом (Р-STL-11). */
export const BRAND = 'Story‑Tales';

export interface TitledText {
  title: string;
  text: string;
}

export interface StoriesCopy {
  meta: { title: string; description: string };
  /**
   * Слоган владельца (Р-STL-16) — в первом экране и в финале. Только
   * слоган: ни обещания качества, ни эффекта.
   */
  tagline: string;
  skipLink: string;
  header: {
    navAriaLabel: string;
    brandHome: string;
    how: string;
    example: string;
    faq: string;
    languageLabel: string;
  };
  /** Подписи действий матрицы режимов (`lib/stories/cta.ts`). */
  cta: {
    how: string;
    example: string;
    /** «Узнать о запуске» — только с формой заявки (итерация 2). */
    lead: string;
    create: string;
    /** Раздел `#/stories` в Telegram (основное действие `prep`). */
    telegram: string;
    /** То же в браузере, если бота нет, а адрес TMA есть. */
    app: string;
  };
  hero: {
    badge: string;
    title: string;
    subtitle: string;
    micro: string;
    /** Видимая подпись под рисунком — обязательна без демо (§6.2, ST-LPL-02). */
    /** Подпись у кнопки раздела приложения: что там есть уже сейчас. */
    appNote: string;
    illustrationCaption: string;
    /** Описание рисунка для скринридера. */
    illustrationAlt: string;
    narratorCardLabel: string;
    taleCardLabel: string;
  };
  example: {
    title: string;
    lead: string;
    schemeLabel: string;
    /** Ровно три части: обращение → сказка → завершение. */
    parts: TitledText[];
    caption: string;
  };
  audience: {
    title: string;
    resultLabel: string;
    items: Array<{ title: string; situation: string; result: string }>;
  };
  how: {
    title: string;
    plannedBadge: string;
    lead: string;
    /** Ровно четыре шага исходника §6.5. */
    steps: string[];
    appLead: string;
    appLink: string;
    telegramLink: string;
  };
  narrator: {
    title: string;
    lead: string;
    items: TitledText[];
    sketch: TitledText;
  };
  catalog: { title: string; status: string; text: string; points: string[] };
  privacy: {
    title: string;
    items: string[];
    /** Пункт о запрете индексации — только пока он правда (не в `public`). */
    noindex: string;
  };
  /** Статус запуска (Р-STL-15): что есть сейчас и что появится. Без «пилота». */
  launch: {
    title: string;
    statusLabel: string;
    status: string;
    availableTitle: string;
    /** Только когда основная кнопка ведёт в приложение. */
    available: string[];
    /** Нейтральный вариант для отката без ссылки в приложение. */
    availableNeutral: string[];
    comingTitle: string;
    coming: string[];
    note: string;
  };
  faq: { title: string; items: Array<{ question: string; answer: string }> };
  final: {
    title: string;
    /** Только когда основная кнопка ведёт в приложение (ссылается на него). */
    text: string;
    /** Нейтральный вариант для отката без ссылки в приложение. */
    textNeutral: string;
  };
  /**
   * Режимы лендинга `pilot`/`public` (`STORY_TALES_LANDING`, Р-ST3-6):
   * строки, которые в этих режимах ЗАМЕЩАЮТ тексты `prep` — статус,
   * подпись у кнопки, путь, каталог, «Запуск», финал и два ответа FAQ
   * (языки и цена). Остальное — общее. В `pilot` и только в нём на
   * странице есть слово «пилот» и число семей (Р-STL-15 заменено
   * решением Р-ST3-6); прочие запреты текста те же (`stories-copy.test.ts`).
   */
  access: { pilot: StoriesAccessCopy; public: StoriesAccessCopy };
  /**
   * Тексты о том, что в `pilot`/`public` уже работает (аудит ST3-U-06/13/16):
   * замещают пункт «Семейный синтетический голос» блока рассказчика,
   * ответы FAQ о голосе (второй) и о ссылке (шестой) и пункт о снятии
   * ссылки в блоке приватности — настоящим временем.
   */
  opened: {
    narratorFamilyVoice: string;
    faqVoice: string;
    faqLink: string;
    privacyLink: string;
    /**
     * ST3-U-16: синтетического образа рассказчика у участников нет (только
     * у владельца) — FAQ о фото/скетче (третий), блок «Фото или скетч»,
     * шаг проверки (третий) и FAQ о предпросмотре (восьмой) — без «образа».
     */
    faqLook: string;
    faqPreview: string;
    sketchText: string;
    stepCheck: string;
  };
  /** Блок «что доступно» из `GET /api/public/story-capabilities` (итерация 2). */
  capabilities: StoriesCapabilitiesCopy;
  footer: {
    navAriaLabel: string;
    platform: string;
    operatorLabel: string;
    /** Оператор — из опубликованных реквизитов оферты (§12), без выдумок. */
    operator: string;
    /** Рабочий контакт — Telegram-бот платформы (Р-STL-19); без бота строки нет. */
    contactLabel: string;
    contactBot: string;
    offer: string;
    terms: string;
    privacy: string;
    termsAndPrivacy: string;
    narratorConsent: string;
    consentNote: string;
    /** Юридические документы одноязычные (русские) — честная пометка. */
    legalNoticeOtherLocale: string;
  };
}

export interface StoriesAccessCopy {
  metaDescription: string;
  badge: string;
  /** Значение строки «Статус» блока «Запуск». */
  status: string;
  /** Подпись у кнопки в приложение: где заявка/мастер; без личных данных здесь. */
  appNote: string;
  howBadge: string;
  howLead: string;
  /** Подводка к ссылкам в приложение, когда основным действием стала не она. */
  howAppLead: string;
  catalogStatus: string;
  catalogText: string;
  available: string[];
  availableNeutral: string[];
  comingTitle: string;
  coming: string[];
  note: string;
  finalText: string;
  finalTextNeutral: string;
  /** Ответ на седьмой вопрос FAQ (языки и истории). */
  faqLanguages: string;
  /** Ответ на девятый вопрос FAQ (цена и сроки). */
  faqPrice: string;
  /** Заголовок блока «что доступно». */
  capabilitiesTitle: string;
}

export interface StoriesCapabilitiesCopy {
  /** Подпись, когда данные пришли из приложения. */
  lead: string;
  /** Подпись, когда API недоступен и показаны статические данные. */
  staticLead: string;
  languagesLabel: string;
  talesLabel: string;
  /** Список историй не получен — где его увидеть. */
  talesEmpty: string;
  formatsLabel: string;
  priceLabel: string;
  /** Шаблон с `{price}` — сумма форматируется страницей (`Intl`). */
  priceFrom: string;
  priceNote: string;
  languageNames: { ru: string; uk: string; en: string; de: string; es: string };
  formatNames: { audio: string; video: string };
}
