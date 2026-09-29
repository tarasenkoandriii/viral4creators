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
 * ## Четыре маршрута одного мастера
 *
 * Поле `route` у хуков мастера — не формальность и не копипаста: оно
 * решает, на КАКОМ мастере элемент вообще бывает на экране.
 *
 * - `generate` — чистый мастер, шаги 1–2: оферта и выбор референса.
 *   Одиннадцать хуков.
 * - `generate-ready` — сессия с ГОТОВЫМ роликом. Девятнадцать хуков:
 *   весь степпер, разбор, состав кадра, товар, редактор промпта, фото
 *   товара, результат.
 * - `generate-prompt-pending` — сессия, дошедшая до промпта, промпт не
 *   написан. Четыре хука: релевантность и кнопка «Сгенерировать
 *   промпт».
 * - `generate-ready-to-render` — промпт одобрен, ролика нет. Шесть
 *   хуков: форма запуска рендера.
 *
 * Разделение на первые два — находка ВТОРОГО боевого прогона
 * (29.09.2026). Разделение оставшихся — разбор достижимости того же
 * дня, и он исправляет ошибку в прежней редакции этого же
 * доккомментария (уже вторую подряд, см. ниже).
 *
 * Прежняя редакция объявляла все двадцать девять хуков живущими на
 * `generate-ready`. Десять из них там не появляются НИКОГДА, и
 * причина у обеих групп одна и та же с разных сторон:
 *
 * - карточка релевантности и кнопка «Сгенерировать промпт» рисуются
 *   под `!prompt` — их прячет НАПИСАННЫЙ промпт;
 * - форма запуска рендера (формат, движок, длительность, «чего
 *   избежать», референс-слоты, кнопка «Сгенерировать») — под
 *   `generatedVideo?.status !== 'complete'` — её прячет ГОТОВЫЙ ролик.
 *
 * То есть сессия с готовым роликом показывает поверхности просмотра и
 * не показывает поверхности работы. Это не дефект интерфейса, а его
 * природа: законченное не может показывать органы управления тем, что
 * его производит. Каталог же утверждал обратное — и утверждение это
 * машинно-читаемое, из него берут и промпт, и валидатор, так что
 * ошибка тиражировалась в каждый сгенерированный сценарий.
 *
 * ## Чем это чинится
 *
 * `route-templates.ts` заводит имена, `fixture-seed.ts` — по сессии на
 * каждое состояние, `tutorial-scenario-runner.service.ts` подсевает
 * `localStorage.sessionId` нужной из трёх — ровно тем способом, каким
 * к своей сессии возвращается человек, открывший приложение назавтра.
 * Каталог отвечает за то, чтобы модель выбрала верное из четырёх имён:
 * промпт группирует хуки по `route` и печатает их как отдельные
 * экраны.
 *
 * ## Вторая ось, которой в каталоге НЕТ
 *
 * Право доступа. Три хука спрятаны ещё и за тарифом, а не только за
 * состоянием сессии: `relevance-panel` под `relevance.allowed`,
 * `reference-slots` под `referenceAssets.allowed`, `audit-panel` под
 * `audit.allowed`. Каталог этого не выражает сознательно: право
 * зависит от тарифа фикстурного пользователя, то есть от данных, а не
 * от кода, и зашитая здесь пометка устаревала бы молча при смене
 * тарифа. Если сценарий с одним из этих трёх падает на `waitFor` — в
 * первую очередь смотреть тариф фикстуры, а не экран.
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
  /**
   * Элемент есть на экране ВСЕГДА, но нажать его можно только после
   * того, как шаг пройден (находка боевого прогона 29.09.2026).
   *
   * Так устроены позиции степпера: `Stepper.tsx` рисует каждую
   * `<button disabled={!clickable}>`, и `clickable` истинно только у
   * пройденного шага. Модель читала описание «позиция «Товар» в
   * степпере мастера» как приглашение туда перейти и писала
   * `goto generate` → `click wizard-step-product` вторым шагом. На
   * свежем мастере эта кнопка выключена, puppeteer ждёт её тридцать
   * секунд и сдаётся: восемь сценариев из девяти падали так, съев
   * весь бюджет прогона.
   *
   * Ждать и проверять такие элементы можно всегда — они в DOM.
   */
  clickOnlyWhenVisited?: true;
}

export const QA_HOOKS: Record<string, QaHook> = {
  // ── Экран товара (`item`), шаг 1 обучалки ─────────────────────────
  'item-step-photo': {
    route: 'item',
    description: 'позиция «Фото» в степпере товара (click — открыть шаг)',
    clickOnlyWhenVisited: true,
  },
  'item-step-analogs': {
    route: 'item',
    description: 'позиция «Аналоги» в степпере товара',
    clickOnlyWhenVisited: true,
  },
  'item-step-voice': {
    route: 'item',
    description: 'позиция «Описание» в степпере товара',
    clickOnlyWhenVisited: true,
  },
  'item-step-price': {
    route: 'item',
    description: 'позиция «Цена» в степпере товара',
    clickOnlyWhenVisited: true,
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
    route: 'generate-ready',
    description:
      'позиция «Референс» в степпере мастера (click — вернуться на пройденный шаг)',
    clickOnlyWhenVisited: true,
  },
  'wizard-step-analysis': {
    route: 'generate-ready',
    description: 'позиция «Анализ» в степпере мастера',
    clickOnlyWhenVisited: true,
  },
  'wizard-step-product': {
    route: 'generate-ready',
    description: 'позиция «Товар» в степпере мастера',
    clickOnlyWhenVisited: true,
  },
  'wizard-step-prompt': {
    route: 'generate-ready',
    description: 'позиция «Промпт» в степпере мастера',
    clickOnlyWhenVisited: true,
  },
  'wizard-step-video': {
    route: 'generate-ready',
    description: 'позиция «Видео» в степпере мастера',
    clickOnlyWhenVisited: true,
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
    route: 'generate-ready',
    description: 'карточка разбора ролика по сценам (waitFor/assertVisible)',
  },
  'analysis-edit': {
    route: 'generate-ready',
    description: 'кнопка «Редактировать» разбор',
  },
  'analysis-continue': {
    route: 'generate-ready',
    description: 'кнопка «Далее» под разбором',
  },
  'character-casting': {
    route: 'generate-ready',
    description: 'карточка персонажей разбора (состав кадра)',
  },
  'scene-casting': {
    route: 'generate-ready',
    description: 'карточка сцен и массовки (состав кадра)',
  },

  // ── Товар внутри мастера ──────────────────────────────────────────
  'product-name-input': {
    route: 'generate-ready',
    description: 'поле названия товара в мастере (fill)',
  },
  'product-description-input': {
    route: 'generate-ready',
    description: 'поле описания товара в мастере (fill)',
  },
  'product-submit': {
    route: 'generate-ready',
    description: 'кнопка «Продолжить» после товара',
  },

  // ── Шаги 4 и 6: релевантность и промпт ────────────────────────────
  'relevance-panel': {
    route: 'generate-prompt-pending',
    description: 'карточка проверки релевантности (waitFor/assertVisible)',
  },
  'relevance-check': {
    route: 'generate-prompt-pending',
    clickCost: 'forbidden',
    description: 'кнопка «Проверить релевантность» — платный вызов Gemini',
  },
  'relevance-use-in-prompt': {
    route: 'generate-prompt-pending',
    description: 'чекбокс «Учитывать при генерации»',
  },
  'prompt-generate': {
    route: 'generate-prompt-pending',
    clickCost: 'forbidden',
    description: 'кнопка «Сгенерировать промпт» — платный вызов модели',
  },
  'prompt-editor': {
    route: 'generate-ready',
    description: 'поле текста промпта (waitFor, fill для правки)',
  },
  'prompt-approve': {
    route: 'generate-ready',
    description: 'кнопка одобрения промпта',
  },

  // ── Шаги 7 и 8: формат и рендер ───────────────────────────────────
  'product-photo-card': {
    route: 'generate-ready',
    description: 'карточка фото товара на шаге видео (waitFor/assertVisible)',
  },
  'video-provider': {
    route: 'generate-ready-to-render',
    description: 'блок выбора движка Grok/Veo (assertVisible)',
  },
  'aspect-ratio-picker': {
    route: 'generate-ready-to-render',
    description: 'блок выбора формата кадра (assertVisible)',
  },
  'reference-slots': {
    route: 'generate-ready-to-render',
    description: 'блок референс-картинок для модели (Standard+)',
  },
  'video-duration-input': {
    route: 'generate-ready-to-render',
    description: 'поле длительности ролика в секундах (fill числом 8–60)',
  },
  'video-avoid-input': {
    route: 'generate-ready-to-render',
    description: 'поле «Чего избежать» (fill)',
  },
  'video-generate': {
    route: 'generate-ready-to-render',
    clickCost: 'generation',
    description:
      'кнопка «Сгенерировать рекламный ролик» — ЗАПУСКАЕТ платный рендер',
  },

  // ── Шаг 9: результат ──────────────────────────────────────────────
  'video-result': {
    route: 'generate-ready',
    description: 'карточка готового ролика (waitFor/assertVisible)',
  },
  'audit-panel': {
    route: 'generate-ready',
    description: 'карточка проверки ролика на артефакты',
  },
  'open-postprod': {
    route: 'generate-ready',
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

  // ── Мастер поздравления (29.09.2026) ──────────────────────────────
  //
  // Девять карточек на ОДНОМ экране, степпер из четырёх позиций
  // скроллит к якорям — вкладок и отдельных URL внутри мастера нет.
  // Видно ли карточку, решает состояние ПОСЛЕДНЕЙ СЕССИИ ПРОЕКТА,
  // поэтому у каждого состояния свой фикстурный проект и свой маршрут:
  // `greeting-video` (сессии нет), `greeting-video-drafting` (сессия
  // есть, сценария нет), `greeting-video-ready` (сценарий собран).
  //
  // Экран у каждого хука объявлен здесь, а не выводится: разбор
  // достижимости 29.09.2026 показал, чем кончается обратное — десять
  // хуков мастера товара обещали экраны, где их не бывает, и восемь
  // сценариев из девяти падали на ожидании.
  //
  // Маршрут позиции степпера — ЭКРАН, ГДЕ ПО НЕЙ МОЖНО КЛИКНУТЬ, а не
  // тот, где она нарисована. Нарисованы все четыре везде;
  // `Stepper.tsx` делает кнопку живой, только если шаг НЕ текущий и у
  // него есть цель (`target !== null`). Разница стоила мастеру товара
  // восьми сценариев из девяти: модель читала описание как приглашение
  // перейти, а кнопка была выключена, и puppeteer ждал её тридцать
  // секунд. Раскладка по состояниям поздравления:
  //
  //   бриф без сессии  — текущий «Бриф», у остальных цели нет: живых нет;
  //   сессия без сценария — текущий «Фото»: живы «Бриф» и «Сценарий»;
  //   сценарий собран  — текущий «Сценарий»: живы «Бриф», «Фото», «Ролик».
  'greeting-step-brief': {
    route: 'greeting-video-drafting',
    description:
      'позиция «Бриф» в степпере поздравления (click — вернуться к брифу). На свежем проекте это ТЕКУЩИЙ шаг и кнопка выключена',
    clickOnlyWhenVisited: true,
  },
  'greeting-step-references': {
    route: 'greeting-video-ready',
    description:
      'позиция «Фото» в степпере поздравления. Пока сценарий не собран, это текущий шаг и кнопка выключена',
    clickOnlyWhenVisited: true,
  },
  'greeting-step-script': {
    route: 'greeting-video-drafting',
    description:
      'позиция «Сценарий» в степпере поздравления. Когда сценарий уже собран, это текущий шаг и кнопка выключена',
    clickOnlyWhenVisited: true,
  },
  'greeting-step-video': {
    route: 'greeting-video-ready',
    description:
      'позиция «Ролик» в степпере поздравления. Появляется вместе со сценарием',
    clickOnlyWhenVisited: true,
  },
  'greeting-brief-card': {
    route: 'greeting-video',
    description:
      'карточка брифа поздравления: повод, кому, от кого, тон (waitFor/assertVisible)',
  },
  'greeting-brief-save': {
    route: 'greeting-video',
    description: 'кнопка сохранения брифа поздравления',
  },
  'greeting-start': {
    route: 'greeting-video',
    description:
      'кнопка «начать» — заводит сессию поздравления. Есть ТОЛЬКО пока сессии нет',
  },
  'greeting-references-card': {
    route: 'greeting-video-drafting',
    description:
      'карточка референс-кадров поздравления. После сборки сценария остаётся на экране, но правки в ней запрещены',
  },
  'greeting-script-card': {
    route: 'greeting-video-drafting',
    description: 'карточка сценария поздравления (waitFor/assertVisible)',
  },
  'greeting-script-generate': {
    route: 'greeting-video-drafting',
    description:
      'кнопка «собрать сценарий». Видна ТОЛЬКО пока сценария нет; нажимать ЗАПРЕЩЕНО — это платный вызов модели',
    clickCost: 'forbidden',
  },
  'greeting-script-edit': {
    route: 'greeting-video-ready',
    description:
      'поле правки текста поздравления. Видно ТОЛЬКО когда сценарий уже собран',
  },
  'greeting-voice-card': {
    route: 'greeting-video-ready',
    description: 'карточка голоса отправителя',
  },
  'greeting-scenes-card': {
    route: 'greeting-video-ready',
    description: 'карточка раскадровки (сколько сцен в ролике)',
  },
  'greeting-sticker-card': {
    route: 'greeting-video-ready',
    description: 'карточка наклейки поверх кадра',
  },
  'greeting-cards-card': {
    route: 'greeting-video-ready',
    description: 'карточка титров — открывающей и закрывающей подписи',
  },
  'greeting-music-card': {
    route: 'greeting-video-ready',
    description: 'карточка музыкальной темы',
  },
  'greeting-video-card': {
    route: 'greeting-video-ready',
    description: 'карточка готового ролика поздравления',
  },
  'greeting-render': {
    route: 'greeting-video-ready',
    description:
      'кнопка запуска рендера поздравления — платная, нажимать только после triggerPaidOperation generation',
    clickCost: 'generation',
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
