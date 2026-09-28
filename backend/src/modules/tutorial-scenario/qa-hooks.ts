/**
 * Каталог хуков `data-qa` TMA для сценариев обучалки — этап I ТЗ
 * `docs-tz/TZ-Tutorial-Video-Voiced.md`.
 *
 * ## Зачем
 *
 * До этапа промпт генератора просил модель писать «семантические
 * плейсхолдеры вида [data-qa="..."], которые оператор поправит на
 * настоящие». Во фронтенде при этом был ОДИН `data-qa` —
 * `client-site-explore`, к десяти шагам обучалки не относящийся. Значит
 * каждый сгенерированный сценарий падал на первом `click`/`fill`, а
 * ролик собирается только из успешного прогона: генерация сценариев
 * работала и стоила денег, а видео не получалось ни одного, пока человек
 * не перепишет руками пятьдесят сценариев по десять шагов.
 *
 * Тот же урок, что с маршрутами (`ROUTE_DESCRIPTIONS`, этап 106):
 * придуманные моделью имена не совпадают с продуктом никогда. Решение то
 * же — ЗАКРЫТЫЙ список настоящих значений в промпт и отказ валидатора на
 * всём, что не из списка.
 *
 * ## Один источник, две проверки
 *
 * - Промпт (`tutorial-scenario-prompt.ts`) перечисляет модели ключи
 *   отсюда, и отсюда же валидатор генератора берёт допустимые селекторы.
 * - Шов `check-docs.mjs` («хуки data-qa») требует, чтобы каждый ключ
 *   встречался во `frontend/src` буквально как `data-qa="ключ"` или
 *   `'ключ'` в таблице хуков степпера/вкладок. Переименовали кнопку во
 *   фронтенде и забыли каталог — CI падает, а не ночной прогон.
 *
 * ## Почему не импорт из фронтенда
 *
 * Та же причина, что у `route-templates.ts`: фронтенд и бэкенд —
 * отдельные пакеты без кросс-импорта. Копия здесь осознанная, её держит
 * шов.
 *
 * ## Селекторы — не текст
 *
 * Интерфейс открывается на пяти языках, а сценарий один на локаль. Хук
 * одинаков во всех локалях; подпись кнопки — нет. Поэтому клики и
 * заполнение идут только по хукам, а текст сравнивает `assertText`.
 *
 * ## Чего каталог не обещает
 *
 * Что элемент ЕСТЬ на экране в момент шага. Шаги 3–8 мастера требуют
 * сессии с разбором и промптом, а фикстура сегодня держит только сессию
 * с готовым роликом; хуки этих шагов верны, но до фикстуры с нужным
 * состоянием такие сценарии будут падать на `waitFor` — честно и с
 * понятной причиной, а не на выдуманном селекторе.
 */

import { WizardPaidOperation } from './scenario-steps.types';

export interface QaHook {
  /** Маршрут из `ROUTE_DESCRIPTIONS`, на экране которого живёт элемент. */
  route: string;
  /** Что это за элемент и что с ним делать — текст для промпта. */
  description: string;
  /**
   * Клик по элементу тратит деньги (найдено аудитом этапа I).
   *
   * - операция из `WIZARD_PAID_OPERATIONS` — клик допустим, только если
   *   ПРЯМО перед ним стоит `triggerPaidOperation` с этой операцией:
   *   так сценарий получает `costly` и ждёт одобрения оператора;
   * - `'forbidden'` — вызов, которого в `WIZARD_PAID_OPERATIONS` нет
   *   (разбор, релевантность, промпт): задекларировать его модель не
   *   может, значит клик прошёл бы мимо гейта одобрения и тратил бы
   *   деньги каждую ночь. Такие кнопки можно ждать и проверять, но не
   *   нажимать.
   */
  clickCost?: WizardPaidOperation | 'forbidden';
}

export const QA_HOOKS: Record<string, QaHook> = {
  // ── Экран товара (`item`), шаг 1 обучалки ─────────────────────────
  'item-step-photo': {
    route: 'item',
    description: 'позиция «Фото» в степпере товара (click — открыть шаг)',
  },
  'item-step-analogs': {
    route: 'item',
    description: 'позиция «Аналоги» в степпере товара',
  },
  'item-step-voice': {
    route: 'item',
    description: 'позиция «Описание» в степпере товара',
  },
  'item-step-price': {
    route: 'item',
    description: 'позиция «Цена» в степпере товара',
  },
  'item-photo-card': {
    route: 'item',
    description: 'карточка шага фото товара (waitFor/assertVisible)',
  },
  'item-photo-skip': {
    route: 'item',
    description: 'кнопка «перейти к описанию без фото»',
  },
  'item-analogs-next': {
    route: 'item',
    description: 'кнопка «Далее» на шаге аналогов',
  },
  'item-description-input': {
    route: 'item',
    description: 'поле описания товара (fill)',
  },
  'item-description-save': {
    route: 'item',
    description: 'кнопка «Сохранить» описание',
  },
  'item-voice-next': {
    route: 'item',
    description: 'кнопка «Далее» на шаге описания (сохраняет и ведёт к цене)',
  },
  'item-price-input': {
    route: 'item',
    description: 'поле цены (fill числом)',
  },
  'item-price-save': {
    route: 'item',
    description: 'кнопка «Сохранить и вернуться» на шаге цены',
  },

  // ── Мастер (`generate`): оферта и степпер ─────────────────────────
  'terms-accept-checkbox': {
    route: 'generate',
    description:
      'чекбокс согласия с офертой — виден только до первого согласия',
  },
  'terms-accept-submit': {
    route: 'generate',
    description: 'кнопка подтверждения согласия с офертой',
  },
  'wizard-step-upload': {
    route: 'generate',
    description:
      'позиция «Референс» в степпере мастера (click — вернуться на пройденный шаг)',
  },
  'wizard-step-analysis': {
    route: 'generate',
    description: 'позиция «Анализ» в степпере мастера',
  },
  'wizard-step-product': {
    route: 'generate',
    description: 'позиция «Товар» в степпере мастера',
  },
  'wizard-step-prompt': {
    route: 'generate',
    description: 'позиция «Промпт» в степпере мастера',
  },
  'wizard-step-video': {
    route: 'generate',
    description: 'позиция «Видео» в степпере мастера',
  },

  // ── Шаг 2: референс ───────────────────────────────────────────────
  'reference-card': {
    route: 'generate',
    description: 'карточка выбора референса (waitFor/assertVisible)',
  },
  'reference-tab-library': {
    route: 'generate',
    description: 'вкладка «Библиотека» готовых разборов',
  },
  'reference-tab-search': {
    route: 'generate',
    description: 'вкладка «Поиск по YouTube»',
  },
  'reference-tab-link': {
    route: 'generate',
    description: 'вкладка «Ссылка»',
  },
  'reference-tab-file': {
    route: 'generate',
    description: 'вкладка «Файл» (выбрать файл сценарий не может)',
  },
  'reference-link-input': {
    route: 'generate',
    description: 'поле ссылки на YouTube (fill адресом ролика)',
  },
  'reference-link-submit': {
    route: 'generate',
    clickCost: 'forbidden',
    description:
      'кнопка «Использовать это видео» — ЗАПУСКАЕТ платный разбор Gemini',
  },
  'youtube-search-input': {
    route: 'generate',
    description: 'поле поиска по YouTube (fill запросом)',
  },
  'youtube-search-submit': {
    route: 'generate',
    description: 'кнопка «Найти» поиска по YouTube',
  },

  // ── Шаги 3 и 5: разбор и состав кадра ─────────────────────────────
  'analysis-card': {
    route: 'generate',
    description: 'карточка разбора ролика по сценам (waitFor/assertVisible)',
  },
  'analysis-edit': {
    route: 'generate',
    description: 'кнопка «Редактировать» разбор',
  },
  'analysis-continue': {
    route: 'generate',
    description: 'кнопка «Далее» под разбором',
  },
  'character-casting': {
    route: 'generate',
    description: 'карточка персонажей разбора (состав кадра)',
  },
  'scene-casting': {
    route: 'generate',
    description: 'карточка сцен и массовки (состав кадра)',
  },

  // ── Товар внутри мастера ──────────────────────────────────────────
  'product-name-input': {
    route: 'generate',
    description: 'поле названия товара в мастере (fill)',
  },
  'product-description-input': {
    route: 'generate',
    description: 'поле описания товара в мастере (fill)',
  },
  'product-submit': {
    route: 'generate',
    description: 'кнопка «Продолжить» после товара',
  },

  // ── Шаги 4 и 6: релевантность и промпт ────────────────────────────
  'relevance-panel': {
    route: 'generate',
    description: 'карточка проверки релевантности (waitFor/assertVisible)',
  },
  'relevance-check': {
    route: 'generate',
    clickCost: 'forbidden',
    description: 'кнопка «Проверить релевантность» — платный вызов Gemini',
  },
  'relevance-use-in-prompt': {
    route: 'generate',
    description: 'чекбокс «Учитывать при генерации»',
  },
  'prompt-generate': {
    route: 'generate',
    clickCost: 'forbidden',
    description: 'кнопка «Сгенерировать промпт» — платный вызов модели',
  },
  'prompt-editor': {
    route: 'generate',
    description: 'поле текста промпта (waitFor, fill для правки)',
  },
  'prompt-approve': {
    route: 'generate',
    description: 'кнопка одобрения промпта',
  },

  // ── Шаги 7 и 8: формат и рендер ───────────────────────────────────
  'product-photo-card': {
    route: 'generate',
    description: 'карточка фото товара на шаге видео (waitFor/assertVisible)',
  },
  'video-provider': {
    route: 'generate',
    description: 'блок выбора движка Grok/Veo (assertVisible)',
  },
  'aspect-ratio-picker': {
    route: 'generate',
    description: 'блок выбора формата кадра (assertVisible)',
  },
  'reference-slots': {
    route: 'generate',
    description: 'блок референс-картинок для модели (Standard+)',
  },
  'video-duration-input': {
    route: 'generate',
    description: 'поле длительности ролика в секундах (fill числом 8–60)',
  },
  'video-avoid-input': {
    route: 'generate',
    description: 'поле «Чего избежать» (fill)',
  },
  'video-generate': {
    route: 'generate',
    clickCost: 'generation',
    description:
      'кнопка «Сгенерировать рекламный ролик» — ЗАПУСКАЕТ платный рендер',
  },

  // ── Шаг 9: результат ──────────────────────────────────────────────
  'video-result': {
    route: 'generate',
    description: 'карточка готового ролика (waitFor/assertVisible)',
  },
  'audit-panel': {
    route: 'generate',
    description: 'карточка проверки ролика на артефакты',
  },
  'open-postprod': {
    route: 'generate',
    description: 'кнопка «Открыть в Постпрод»',
  },

  // ── Шаг 10: постпрод одного ролика (`postprod-video`) ─────────────
  'revoice-panel': {
    route: 'postprod-video',
    description:
      'карточка переозвучки (видна только у ролика со своим голосом)',
  },
  'export-panel': {
    route: 'postprod-video',
    description: 'карточка экспорта под площадки',
  },
  'publish-panel': {
    route: 'postprod-video',
    description: 'карточка публикации',
  },
};

/** Селектор хука ровно в той форме, которую пишет модель и ждёт раннер. */
export function qaSelector(key: string): string {
  return `[data-qa="${key}"]`;
}

const SELECTOR_SHAPE = /^\[data-qa="([a-z0-9-]+)"\]$/;

/**
 * Ключ хука из селектора — или `null`, если селектор не в форме
 * `[data-qa="ключ"]` либо ключа нет в каталоге.
 */
export function knownQaHook(selector: string): string | null {
  const key = SELECTOR_SHAPE.exec(selector.trim())?.[1];
  return key && Object.prototype.hasOwnProperty.call(QA_HOOKS, key)
    ? key
    : null;
}
