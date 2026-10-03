/**
 * Голосовое управление интерфейсом — общие формы (Э6-бис, ТЗ помощника
 * §5-бис.3–6, §5-бис.9). Пакет `assist-ui-core` НЕЙТРАЛЬНЫЙ (§5-бис.3 п.3,
 * У-19, правило графа `ui-core-neutral` + `ui-core-no-db`): без доступа к
 * базе, не импортирует ни `assist-site-*`, ни `assist-admin-*`; знания и
 * настройки своего режима передаёт вызывающий модуль. Сегодня его зовёт
 * режим «Сайт» (`assist-site-voice-control/public`); «Админка» (Э6-бис (б),
 * после Э8) возьмёт тот же код проверок со своими настройками.
 *
 * Стык с загрузчиком и iframe (`widget/src/shared/ui-plan.ts` повторяет
 * формы — сверку держит `widget/scripts/ui-plan.test.ts`).
 */

/** Роль элемента в снимке — по тегу/`role`/типу поля. */
export const UI_ROLES = [
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'switch',
] as const;
export type UiRole = (typeof UI_ROLES)[number];

/**
 * Почему шаг нельзя исполнить синтетическим событием (§5-бис.3 «что
 * синтетический клик не может в принципе»): новая вкладка, файл,
 * скачивание, буфер обмена. Помечает загрузчик ЗАРАНЕЕ; сервер верит
 * пометке только в сторону запрета.
 */
export const UI_GESTURES = ['new_tab', 'file', 'download', 'copy'] as const;
export type UiGesture = (typeof UI_GESTURES)[number];

/**
 * Элемент снимка интерактивных элементов страницы (§5-бис.3 п.2). Значений
 * полей нет (кроме выбранной опции списка), подписи маскированы ещё в
 * загрузчике (`maskSensitiveEcho`-порт) и ещё раз здесь.
 */
export interface UiSnapElement {
  /** Ссылка шага на элемент: `e1`…`e150` (номер в снимке этой страницы). */
  ref: string;
  role: UiRole;
  tag: 'a' | 'button' | 'input' | 'select' | 'textarea' | 'other';
  /** Видимый текст (≤ 80) — то, что видит человек. */
  text: string;
  /**
   * Доступное имя, если оно расходится с видимым текстом (§5-бис.6 п.7):
   * `aria-label`/`title` злоумышленник контролирует свободнее — для
   * проверки «цель ↔ команда» НЕ засчитывается, в карточку не идёт.
   */
  hiddenLabel: string | null;
  /** `data-assist-id` разметки заказчика (§5-бис.4). */
  assistId: string | null;
  /** Тип поля `<input>` (text, search, email, tel, number…). */
  inputType: string | null;
  /** Ссылка: адрес без query и фрагмента (только http(s)). */
  href: string | null;
  disabled: boolean;
  checked: boolean | null;
  /** Выбранная опция списка (единственное «значение», которое уходит). */
  selected: string | null;
  /** Опции списка `<select>` (≤ 12, подписи). */
  options: string[];
  /** Ближайший заголовок раздела (≤ 80). */
  heading: string | null;
  /** Кнопка отправки формы (`type=submit` или кнопка без типа в `<form>`). */
  submit: boolean;
  /** Внутри `<form>` или `data-assist="confirm"` (любая отправка — с «Да»). */
  inForm: boolean;
  confirmZone: boolean;
  /** Поле персональных данных (имя, телефон, e-mail, адрес — по autocomplete/type). */
  pd: boolean;
  /** Открывает меню/вкладку/аккордеон (`aria-expanded`, `role=tab`, `<summary>`). */
  toggle: boolean;
  gesture: UiGesture | null;
  inView: boolean;
}

/** Снимок страницы — как пришёл из iframe после разбора. */
export interface UiSnapshot {
  url: string;
  title: string;
  elements: UiSnapElement[];
}

/** Шаги плана — словарь §5-бис.3 п.3. */
export const UI_STEP_KINDS = [
  'scroll',
  'click',
  'fill',
  'select',
  'check',
  'navigate',
  'wait',
  'highlight',
  'say',
] as const;
export type UiStepKind = (typeof UI_STEP_KINDS)[number];

/**
 * Класс риска (§5-бис.5): `auto` — сразу; `confirm` — после «Да»;
 * `manual` — не исполняется, подсветка и «нажмите сами» (другой домен,
 * жест, деградация); `never` — не исполняется вовсе (стоп-лист, пароль,
 * оплата) — подсветка только там, где уместно.
 */
export const UI_RISKS = ['auto', 'confirm', 'manual', 'never'] as const;
export type UiRisk = (typeof UI_RISKS)[number];

/** Ожидание результата шага (§5-бис.3 п.3) — проверяет загрузчик. */
export interface UiExpect {
  /** Путь новой страницы: точный или с `*` в конце. */
  path?: string;
  /** Появление элемента с этим видимым текстом (≤ 80). */
  appear?: string;
  /** Текст цели изменился (счётчик корзины и т.п.). */
  textChange?: boolean;
}

/** Цель шага — как её ищет загрузчик (§5-бис.3 п.6, порядок поиска). */
export interface UiTarget {
  ref: string;
  assistId: string | null;
  role: UiRole | null;
  /** Видимый текст — и подпись подсветки, и карточки подтверждения. */
  text: string;
  /** Селектор из карты интерфейса — последний путь поиска. */
  selector: string | null;
  href: string | null;
}

/** Проверенный шаг — то, что исполняет загрузчик. */
export interface UiPlanStep {
  i: number;
  kind: UiStepKind;
  target: UiTarget | null;
  /** Значение `fill`/`select` (только из сказанного). */
  value: string | null;
  expect: UiExpect | null;
  risk: UiRisk;
  /** Почему `manual`/`never` (код для журнала и текста посетителю). */
  reason: UiStopReason | null;
  /** Шаг может вызвать навигацию — `dispatched` ДО клика (§4-бис.5). */
  nav: boolean;
  /** Реплика `say` (≤ 200) — только текст в iframe. */
  say: string | null;
}

/** Почему шаг вычеркнут/не исполняется — словарь для журнала и TMA. */
export const UI_STOP_REASONS = [
  'no_target',
  'bad_kind',
  'denied',
  'danger',
  'payment',
  'sensitive_field',
  'value_not_said',
  'offhost',
  'gesture',
  'degraded',
  'limit',
  'disabled',
] as const;
export type UiStopReason = (typeof UI_STOP_REASONS)[number];

/** Что помощник делать не будет и почему (§5-бис.3 п.4) — показывается человеку. */
export interface UiPlanNote {
  code: UiStopReason;
  /** Видимый текст цели (если есть). */
  target: string | null;
}

/** Правила кабинета (§5-бис.2) — форма `assist_sites.voiceControlSiteRules`. */
export interface VoiceControlRules {
  schema: 1;
  /** Разрешённые зоны: маски путей (`/catalog*`); пусто — весь подтверждённый хост. */
  allowPaths: string[];
  /** Разрешённые зоны: CSS-селекторы контейнеров; пусто — вся страница. */
  allowSelectors: string[];
  /** Запрещённые элементы: селекторы (загрузчик выкидывает их из снимка). */
  denySelectors: string[];
  /** Запрещённые пути (маски): ни ссылок туда, ни действий там. */
  denyPaths: string[];
  /** Запрещённые слова в подписях целей (вдобавок к встроенному стоп-листу). */
  denyWords: string[];
  /** Подтверждение и для заполнения полей (по умолчанию — только отправка). */
  confirmFill: boolean;
  /** Лимит шагов на команду: «Сайт» 6, не выше 15. */
  maxSteps: number;
}

/**
 * Состояние переключателя (§5-бис.11, аудит 1.3): `off → test → on` и
 * `degraded`. Э6-бис (а) включает `off`/`on`; `test` (мастер Т-2) и
 * автоматический `degraded` (монитор Т-4) — часть (г): точки расширения
 * оставлены (публичный код уже понимает `degraded` — только подсветка).
 */
export const VOICE_CONTROL_STATES = ['off', 'test', 'on', 'degraded'] as const;
export type VoiceControlState = (typeof VOICE_CONTROL_STATES)[number];

/** Статусы плана (§5-бис.9). */
export const UI_PLAN_STATUSES = [
  'proposed',
  'confirmed',
  'running',
  'paused',
  'done',
  'stopped',
  'failed',
  'expired',
] as const;
export type UiPlanStatus = (typeof UI_PLAN_STATUSES)[number];

/** Итог шага в журнале (§5-бис.9) + `dispatched` до навигационного клика. */
export const UI_STEP_RESULTS = [
  'dispatched',
  'done',
  'skipped',
  'failed',
  'stopped',
  'manual',
] as const;
export type UiStepResult = (typeof UI_STEP_RESULTS)[number];
