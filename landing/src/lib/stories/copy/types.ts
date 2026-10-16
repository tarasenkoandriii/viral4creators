/**
 * Форма текстов лендинга Story‑Tales — одна на пять локалей.
 *
 * Тексты живут не в общих `dictionaries/*.json`, а отдельными модулями,
 * которые импортирует только серверная страница `app/[locale]/stories`.
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
  privacy: { title: string; items: string[] };
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
