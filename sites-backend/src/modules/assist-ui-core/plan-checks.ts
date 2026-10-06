/**
 * Проверка плана КОДОМ, не моделью (§5-бис.3 п.4, §5-бис.5, §5-бис.6):
 *  - цель существует в снимке (или в карте интерфейса страницы);
 *  - цель не в denylist кабинета и не в стоп-листе (`actionKindsFor`,
 *    по ВСЕМУ тексту цели, включая скрытую подпись — запрет только растёт);
 *  - значение поля взято из сказанного (`valueSaid`);
 *  - переход — только по ссылке со страницы и только на подтверждённый
 *    хост этого сайта; страница оплаты — никогда;
 *  - шаг, требующий настоящего жеста (`gesture`), — «нажмите сами»;
 *  - число шагов ≤ лимита правил;
 *  - класс риска считает код и может только ПОВЫСИТЬ мнение модели;
 *  - цель должна быть связана с командой по ВИДИМОМУ тексту или
 *    `data-assist-id` (скрытая подпись не засчитывается, §5-бис.6 п.7) —
 *    иначе «с подтверждением».
 * Первый шаг `manual`/`never` — последний: дальше план не идёт (то, что
 * после, обычно от него зависит), а человек видит подсветку и «нажмите сами».
 *
 * Шаги ПОСЛЕ навигации ссылаются не на снимок (его ещё нет), а на описание
 * цели (`after`: видимый текст/разметка/роль). Их проверяет тот же код
 * дважды: при построении — по описанию (стоп-лист, значения), при
 * продолжении на новой странице — по найденному элементу нового снимка
 * (`resolveAfterSteps`).
 */
import { uiMapHost } from '../site-core/ui-map/ui-map';
import {
  allowedAfterPnr,
  compFor,
  provisionalUndo,
  undoClass,
  worseUndo,
} from './chain';
import {
  type ActionKind,
  ADD_TO_CART_ID,
  ASSIST_ID_SYNONYMS,
  CONFIRM_KINDS,
  NEVER_KINDS,
  REVERSIBLE_ASSIST_IDS,
  actionKindsFor,
  paymentPath,
} from './action-words';
import {
  assistIdWords,
  normText,
  overlaps,
  saysFind,
  valueSaid,
} from './normalize';
import { withGoalExtras } from './memo-goal';
import { pathMatches, zoneAllowed } from './rules';
import { ASSIST_ID_RE, SNAP_REF_RE, cleanText } from './snapshot';
import {
  UI_RISKS,
  UI_ROLES,
  UI_STEP_KINDS,
  type UiComp,
  type UiExpect,
  type UiGesture,
  type UiPin,
  type UiPlanNote,
  type UiPlanStep,
  type UiRisk,
  type UiRole,
  type UiSnapElement,
  type UiSnapshot,
  type UiStepKind,
  type UiStopReason,
  type UiTarget,
  type UiUndo,
  type VoiceControlRules,
} from './types';

/** Элемент карты интерфейса страницы в промпте: `m1`…`m30`. */
export interface UiMapRef {
  ref: string;
  selector: string;
  label: string;
  tag: string;
}

export const MAP_REF_RE = /^m([1-9]\d?)$/;

/** Шаг, как его предложила модель (до проверки). */
export interface RawStep {
  kind: unknown;
  target?: unknown;
  value?: unknown;
  expect?: unknown;
  risk?: unknown;
  say?: unknown;
}

export interface PlanCheckInput {
  transcript: string;
  snapshot: UiSnapshot;
  map: UiMapRef[];
  steps: unknown;
  rules: VoiceControlRules;
  /** Подтверждённые хосты сайта (verified). */
  hosts: string[];
  /** `degraded` — только подсветка и «нажмите здесь» (§5-бис.11). */
  state: 'on' | 'degraded';
  /**
   * (мемо, §5-бис.17 п.3) Значения, которые КОД признал сказанными:
   * объявленные владельцем варианты слота `option`, чья голосовая форма
   * есть в команде, и даты, разобранные из сказанного слова. Модель сюда
   * ничего не добавляет — список собирает публичный код мемо.
   */
  trusted?: readonly string[];
  /**
   * (мемо) Закреплённые отпечатки целей по номеру СЫРОГО шага — переносятся
   * в проверенный шаг (сверка после перехода, `resolveAfterSteps`). Только
   * из версии мемо; поле `pin` в ответе модели не читается.
   */
  pins?: ReadonlyArray<UiPin | null>;
  /** (мемо) Шаги проверки цели сверх лимита шагов (ожидание без эффекта). */
  extraSteps?: number;
  /**
   * (Э6-тер) Подсказки голосовой карты по ссылке элемента снимка: имена и
   * синонимы владельца засчитываются как совпадение «цель ↔ команда»
   * (§5-кватер.8 п.5), риск карты — только НИЖНЯЯ граница (Р-51).
   */
  mapHints?: ReadonlyMap<string, MapHint>;
  /**
   * (Э6-тер (и)) Ставить шагам `comp` объявленную компенсацию (§5-бис.15
   * п.6): режим «Сайт». «Админка» кликами серверное не компенсирует
   * (п.3 п.3) — флаг не передаёт.
   */
  compensations?: boolean;
}

/** Подсказка голосовой карты для элемента снимка. */
export interface MapHint {
  key: string;
  names: readonly string[];
  floor: UiRisk;
  /** (Э6-тер (и)) «Как отменить» цели карты — объявленная пара владельца. */
  undo?: { assistId: string; at: string | null } | null;
}

export interface CheckedPlan {
  steps: UiPlanStep[];
  notes: UiPlanNote[];
  /** Есть шаг «с подтверждением» — нужна карточка «Да/Нет». */
  needsConfirm: boolean;
  /** (цепочки) Точка невозврата — номер шага или null (§5-бис.15 п.4). */
  pnr: number | null;
  /** Номер сырого шага для каждого проверенного (мемо: цепочка без дыр). */
  from: number[];
}

/** Факты о цели, по которым считается риск (элемент снимка или карты). */
export interface TargetFacts {
  text: string;
  hiddenLabel: string | null;
  assistId: string | null;
  role: UiRole | null;
  tag: string;
  href: string | null;
  submit: boolean;
  inForm: boolean;
  confirmZone: boolean;
  pd: boolean;
  toggle: boolean;
  gesture: UiGesture | null;
  inputType: string | null;
  disabled: boolean;
  heading: string | null;
  options: string[];
}

const RANK: Record<UiRisk, number> = {
  auto: 0,
  confirm: 1,
  manual: 2,
  never: 3,
};

/** Риск только растёт: код поднимает мнение модели, но никогда не опускает. */
export function raise(a: UiRisk, b: UiRisk): UiRisk {
  return RANK[a] >= RANK[b] ? a : b;
}

const TEXT_ROLES = new Set<UiRole>(['textbox', 'searchbox', 'combobox']);

/**
 * Поле ПД по ПОДПИСИ (§5-бис.5: «по autocomplete, type, подписи») — загрузчик
 * ставит `pd` по атрибутам; подпись «Ваше ім'я» без них — тоже ПД.
 */
export const PD_FIELD_LABEL =
  /(?:^|[^\p{L}])(ім'я|імʼя|имя|name|прізвище|фамилия|surname|по батькові|отчество|телефон|phone|mobile|e-?mail|пошта|почта|адрес\p{L}*|address|вулиц\p{L}*|улиц\p{L}*|street|квартир\p{L}*|індекс|индекс|zip|postcode|postal|дата народження|дата рождения|birth)(?!\p{L})/iu;

/** Слова, которые снимает разметка `add-to-cart` (порт `BUY` загрузчика). */
const BUY_WORDS = /(^|[^\p{L}])(купить|купити|buy now)/giu;

/** Подпись поля пароля, карты, одноразового кода (uk/ru/en). */
export const SENSITIVE_FIELD_LABEL =
  /(?:^|[^\p{L}])(парол\p{L}*|password|passcode|passwd|cvv2?|cvc2?|csc|номер карт\p{L}*|card number|credit card|debit card|одноразов\p{L}* код|код (?:з|із|из) смс|sms[- ]?code|one[- ]time|otp|pin|пін|пин)(?!\p{L})/iu;

/**
 * Значение списка «в корзину/у кошик/trash» — это корзина-«мусор»
 * (массовые действия, статус записи), а не корзина магазина: у `select`
 * смысла «добавить в корзину» нет (аудит Н-4).
 */
const SELECT_TRASH =
  /(?:^|[^\p{L}])(корзин\p{L}*|кошик\p{L}*|trash)(?!\p{L})/iu;

/**
 * Опасность выбранного значения списка (аудит Н-4): значение и подпись
 * выбранного варианта проходят тот же стоп-лист, что подпись цели клика
 * (`actionKindsFor`): «Удалить»/«Отменить заказ»/«Оплатить»/«В корзину»
 * в списке действий — это то же нажатие. `null` — не опасно.
 */
export function selectValueDanger(text: string): 'payment' | 'danger' | null {
  const kinds = actionKindsFor(text);
  if (kinds.includes('оплата')) return 'payment';
  if (kinds.some((k) => NEVER_KINDS.has(k)) || SELECT_TRASH.test(text))
    return 'danger';
  return null;
}

/**
 * Разрушительные глаголы повелительного наклонения в КОМАНДЕ (аудит Н-4;
 * то же, что «Админка» берёт для `apiPreference`): стоп-лист цели ловит
 * подпись «Скасувати замовлення», а человек говорит «скасуй», «видали»,
 * «спиши» — и целью модель может выбрать кнопку-иконку без подписи.
 * Текст — после `normText` (нижний регистр, пробелы).
 */
export const DESTRUCTIVE_COMMAND_VERBS: ReadonlyArray<
  readonly [RegExp, ActionKind]
> = [
  [
    /(^|\s)(видали(ть)?|видаліть|вилучи(ть)?|удали(те)?|delete|remove)(\s|$)/u,
    'удаление',
  ],
  [/(^|\s)(скасуй(те)?|отмени(те)?|cancel)(\s|$)/u, 'отмена заказа'],
  [
    /(^|\s)(поверни(ть)? (кошти|гроші)|оформи(ть)? повернення|верни(те)? деньги|оформи(те)? возврат|refund)(\s|$)/u,
    'возврат',
  ],
  [/(^|\s)(спиши(ть)?|списати|charge)(\s|$)/u, 'списание'],
];

/** Категории разрушительных глаголов команды (пусто — команда не такая). */
export function destructiveCommandKinds(transcript: string): ActionKind[] {
  const t = normText(transcript);
  return DESTRUCTIVE_COMMAND_VERBS.filter(([re]) => re.test(t)).map(
    ([, k]) => k,
  );
}

function factsOfElement(e: UiSnapElement): TargetFacts {
  return {
    text: e.text,
    hiddenLabel: e.hiddenLabel,
    assistId: e.assistId,
    role: e.role,
    tag: e.tag,
    href: e.href,
    submit: e.submit,
    inForm: e.inForm,
    confirmZone: e.confirmZone,
    pd: e.pd,
    toggle: e.toggle,
    gesture: e.gesture,
    inputType: e.inputType,
    disabled: e.disabled,
    heading: e.heading,
    options: e.options,
  };
}

function factsOfMap(m: UiMapRef): TargetFacts {
  const role: UiRole =
    m.tag === 'a'
      ? 'link'
      : m.tag === 'input' || m.tag === 'textarea'
        ? 'textbox'
        : m.tag === 'select'
          ? 'combobox'
          : 'button';
  return {
    text: m.label,
    hiddenLabel: null,
    assistId: null,
    role,
    tag: m.tag,
    href: null,
    // Карта не знает формы — консервативно: кнопка карты — «отправка».
    submit: m.tag === 'button',
    inForm: m.tag === 'button',
    confirmZone: false,
    pd: false,
    toggle: false,
    gesture: null,
    inputType: null,
    disabled: false,
    heading: null,
    options: [],
  };
}

/** Хост ссылки — среди подтверждённых хостов сайта (без www и регистра). */
export function onSiteHost(href: string, hosts: string[]): boolean {
  let h: string;
  try {
    h = uiMapHost(new URL(href).hostname);
  } catch {
    return false;
  }
  return hosts.some((x) => uiMapHost(x) === h);
}

function hrefPath(href: string | null): string | null {
  if (!href) return null;
  try {
    return new URL(href).pathname;
  } catch {
    return null;
  }
}

/** Цель связана с командой: видимый текст или разметка (НЕ скрытая подпись). */
export function targetMatches(t: TargetFacts, transcript: string): boolean {
  const own = [
    t.text,
    assistIdWords(t.assistId),
    t.assistId ? (ASSIST_ID_SYNONYMS[t.assistId] ?? '') : '',
  ].join(' ');
  return overlaps(transcript, own);
}

/**
 * Риск и причина для одного шага по фактам о цели. `null` в `risk` — шаг
 * вычёркивается (`reason` — почему).
 */
export function judgeStep(
  kind: UiStepKind,
  t: TargetFacts,
  value: string | null,
  ctx: {
    transcript: string;
    rules: VoiceControlRules;
    hosts: string[];
    pagePath: string | null;
    state: 'on' | 'degraded';
    trusted?: readonly string[];
    /** (Э6-тер) Имена цели в голосовой карте — тоже «цель ↔ команда». */
    names?: readonly string[];
  },
): { risk: UiRisk | null; reason: UiStopReason | null; nav: boolean } {
  const no = (reason: UiStopReason) => ({ risk: null, reason, nav: false });
  const never = (reason: UiStopReason) => ({
    risk: 'never' as UiRisk,
    reason,
    nav: false,
  });
  const manual = (reason: UiStopReason) => ({
    risk: 'manual' as UiRisk,
    reason,
    nav: false,
  });
  if (t.disabled && kind !== 'highlight' && kind !== 'scroll')
    return no('disabled');
  if (t.inputType === 'password' || t.inputType === 'file')
    return no('sensitive_field');

  // Запреты кабинета: слова в любой подписи, пути ссылок и самой страницы.
  const allText = normText(
    [t.text, t.hiddenLabel ?? '', assistIdWords(t.assistId)].join(' '),
  );
  if (ctx.rules.denyWords.some((w) => w && allText.includes(normText(w))))
    return never('denied');
  const path = hrefPath(t.href);
  if (path && ctx.rules.denyPaths.some((m) => pathMatches(path, m)))
    return never('denied');

  // Показать и прокрутить можно к любой цели снимка (ничего не меняет).
  if (kind === 'highlight' || kind === 'scroll')
    return { risk: 'auto', reason: null, nav: false };

  // Стоп-лист — по ВСЕМУ тексту (скрытая подпись только поднимает запрет).
  // `add-to-cart` снимает ТОЛЬКО «Купить/Купити/Buy now» (ложный
  // срабатыватель), не «Оформить заказ»/checkout рядом — как загрузчик.
  const probe = [t.text, t.hiddenLabel ?? '', assistIdWords(t.assistId)].join(
    ' ',
  );
  const kinds = actionKindsFor(
    t.assistId === ADD_TO_CART_ID ? probe.replace(BUY_WORDS, '$1 ') : probe,
    t.heading,
  );
  if (kinds.includes('оплата')) return never('payment');
  if (path && paymentPath(path)) return never('payment');
  if (kinds.some((k) => NEVER_KINDS.has(k))) return never('danger');

  if (t.href && !onSiteHost(t.href, ctx.hosts)) return manual('offhost');
  if (t.gesture) return manual('gesture');
  if (ctx.state === 'degraded') return manual('degraded');

  // Значение «сказано»: в команде — или признано кодом мемо (объявленный
  // вариант слота, разобранная дата; `trusted` собирает код, не модель).
  const said = (v: string) =>
    valueSaid(v, ctx.transcript) ||
    (ctx.trusted ?? []).some((x) => normText(x) === normText(v));

  // Поле поиска связано с командой «знайди/найди/find …» само по себе.
  const searchBox =
    t.role === 'searchbox' ||
    t.inputType === 'search' ||
    t.assistId === 'search';
  const matches =
    targetMatches(t, ctx.transcript) ||
    (searchBox && saysFind(ctx.transcript)) ||
    (ctx.names ?? []).some((n) => overlaps(ctx.transcript, n));
  const isText =
    (t.role !== null && TEXT_ROLES.has(t.role)) ||
    t.tag === 'textarea' ||
    (t.tag === 'input' && t.role !== 'checkbox' && t.role !== 'radio');

  // Поле пароля/карты/кода по ПОДПИСИ (§5-бис.5 «никогда»): сайты часто не
  // ставят `autocomplete=cc-*`/`type=password` — подпись видит человек.
  if (
    (kind === 'fill' || kind === 'select') &&
    SENSITIVE_FIELD_LABEL.test(
      [t.text, t.hiddenLabel ?? '', assistIdWords(t.assistId)].join(' '),
    )
  )
    return no('sensitive_field');

  switch (kind) {
    case 'fill': {
      if (!isText || t.tag === 'select') return no('bad_kind');
      if (!value || !said(value)) return no('value_not_said');
      const pd =
        t.pd || PD_FIELD_LABEL.test([t.text, t.hiddenLabel ?? ''].join(' '));
      const risk: UiRisk =
        pd || ctx.rules.confirmFill || !matches ? 'confirm' : 'auto';
      return { risk, reason: null, nav: false };
    }
    case 'select': {
      if (t.tag !== 'select' && t.role !== 'combobox') return no('bad_kind');
      // Аудит Н-4: выбор варианта — то же нажатие; значение и подпись
      // выбранного варианта — через стоп-лист (до «сказано ли»: опасное —
      // «никогда», а не тихо вычеркнутый шаг).
      if (value) {
        const chosen =
          t.options.find((o) => normText(o) === normText(value)) ?? '';
        const danger = selectValueDanger(`${value} ${chosen}`);
        if (danger) return never(danger);
      }
      if (!value || !said(value)) return no('value_not_said');
      if (
        t.options.length &&
        !t.options.some((o) => normText(o) === normText(value))
      )
        return no('value_not_said');
      return {
        risk: ctx.rules.confirmFill || !matches ? 'confirm' : 'auto',
        reason: null,
        nav: false,
      };
    }
    case 'check': {
      if (t.role !== 'checkbox' && t.role !== 'radio' && t.role !== 'switch')
        return no('bad_kind');
      return { risk: matches ? 'auto' : 'confirm', reason: null, nav: false };
    }
    case 'click': {
      if (t.role === 'link' || t.tag === 'a') {
        // Ссылка без адреса (`#`, javascript:) — это кнопка сайта.
        if (t.href)
          return {
            risk: matches ? 'auto' : 'confirm',
            reason: null,
            nav: true,
          };
      }
      if (t.toggle && !t.submit)
        return { risk: matches ? 'auto' : 'confirm', reason: null, nav: false };
      if (
        t.assistId &&
        REVERSIBLE_ASSIST_IDS.has(t.assistId) &&
        matches &&
        !t.confirmZone
      )
        return { risk: 'auto', reason: null, nav: t.submit };
      if (kinds.some((k) => CONFIRM_KINDS.has(k)))
        return { risk: 'confirm', reason: null, nav: t.submit || t.inForm };
      // Любая другая кнопка — с подтверждением (класс по умолчанию не «сразу»).
      return { risk: 'confirm', reason: null, nav: t.submit || t.inForm };
    }
    default:
      return no('bad_kind');
  }
}

function cleanExpect(raw: unknown): UiExpect | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: UiExpect = {};
  if (
    typeof o.path === 'string' &&
    o.path.length <= 300 &&
    /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/.test(o.path)
  )
    out.path = o.path;
  const appear = cleanText(o.appear, 80);
  if (appear) out.appear = appear;
  if (o.textChange === true) out.textChange = true;
  return Object.keys(out).length ? out : null;
}

function cleanSay(raw: unknown): string | null {
  return cleanText(raw, 200);
}

/** Описание цели шага после навигации (страницы ещё нет в снимке). */
export interface AfterTarget {
  text: string;
  assistId: string | null;
  role: UiRole | null;
}

function cleanAfter(raw: unknown): AfterTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const text = cleanText(o.text, 80) ?? '';
  const assistId =
    typeof o.assistId === 'string' && ASSIST_ID_RE.test(o.assistId)
      ? o.assistId
      : null;
  const role =
    typeof o.role === 'string' &&
    (UI_ROLES as readonly string[]).includes(o.role)
      ? (o.role as UiRole)
      : null;
  if (!text && !assistId) return null;
  return { text, assistId, role };
}

function afterFacts(a: AfterTarget): TargetFacts {
  return {
    text: a.text,
    hiddenLabel: null,
    assistId: a.assistId,
    role: a.role,
    tag: a.role === 'link' ? 'a' : 'button',
    href: null,
    submit: false,
    inForm: false,
    confirmZone: false,
    pd: false,
    // Вкладка по описанию — переключатель; окончательно решит новый снимок.
    toggle: a.role === 'tab',
    gesture: null,
    inputType: null,
    disabled: false,
    heading: null,
    options: [],
  };
}

/**
 * (Э6-тер (и)) Компенсация клика по цели снимка: пара — объявленная
 * (`hint.undo`) или встроенная стандартной разметки; страница отмены —
 * объявленная или адрес ссылки стандартной разметки ЭТОГО снимка на
 * подтверждённом хосте (`nav-cart`); страница вне разрешённых зон или под
 * запретом — компенсации нет («уберите сами»).
 */
function compOfStep(
  kind: UiStepKind,
  facts: TargetFacts,
  hint: MapHint | null,
  snapshot: UiSnapshot,
  hosts: string[],
  rules: VoiceControlRules,
): UiComp | null {
  if (kind !== 'click' || facts.submit) return null;
  const c = compFor({
    facts: {
      assistId: facts.assistId,
      heading: facts.heading,
      text: facts.text,
    },
    declared: hint?.undo ?? null,
    navPath: (navId) => {
      const links = snapshot.elements.filter(
        (e) => e.assistId === navId && !!e.href && onSiteHost(e.href, hosts),
      );
      return links.length ? hrefPath(links[0].href) : null;
    },
  });
  if (c && c.at !== null && !zoneAllowed(c.at, rules)) return null;
  return c;
}

function targetOf(
  ref: string,
  f: TargetFacts,
  selector: string | null,
): UiTarget {
  return {
    ref,
    assistId: f.assistId,
    role: f.role,
    text: f.text || f.assistId || '',
    selector,
    href: f.href,
  };
}

/**
 * Проверить план модели. Возвращает исполнимые шаги (с риском, причиной и
 * пометкой навигации) и заметки «чего не сделаю и почему».
 */
export function checkPlan(p: PlanCheckInput): CheckedPlan {
  const notes: UiPlanNote[] = [];
  const out: UiPlanStep[] = [];
  const from: number[] = [];
  const raw = Array.isArray(p.steps) ? p.steps : [];
  const byRef = new Map(p.snapshot.elements.map((e) => [e.ref, e]));
  const byMap = new Map(p.map.map((m) => [m.ref, m]));
  const byHref = new Map<string, UiSnapElement>();
  for (const e of p.snapshot.elements)
    if (e.href && !byHref.has(e.href)) byHref.set(e.href, e);
  let pagePath: string | null = null;
  try {
    pagePath = new URL(p.snapshot.url).pathname;
  } catch {
    pagePath = null;
  }
  const ctx = {
    transcript: p.transcript,
    rules: p.rules,
    hosts: p.hosts,
    pagePath,
    state: p.state,
    trusted: p.trusted,
  };
  let afterNav = false;
  let stopped = false;
  // Аудит Н-4: команда с разрушительным глаголом («видали», «скасуй»,
  // «спиши») — шаги с эффектом (не переход по ссылке) кликами не
  // исполняются: цель могла остаться без подписи (иконка), и стоп-лист цели
  // её не увидел. Обратимая разметка посетителя (корзина, избранное,
  // фильтр) — только «с подтверждением».
  const destructiveCommand = destructiveCommandKinds(p.transcript).length > 0;
  /** Точка невозврата (§5-бис.15 п.4) — первый исполнимый `irrev`. */
  let pnr: number | null = null;
  const maxSteps = p.rules.maxSteps + Math.max(0, p.extraSteps ?? 0);

  for (const [rawIndex, item] of raw.entries()) {
    if (stopped) break;
    if (out.length >= maxSteps) {
      notes.push({ code: 'limit', target: null });
      break;
    }
    if (!item || typeof item !== 'object') continue;
    const s = item as RawStep;
    let kind = s.kind as UiStepKind;
    if (!(UI_STEP_KINDS as readonly unknown[]).includes(kind)) {
      notes.push({ code: 'bad_kind', target: null });
      continue;
    }
    const modelRisk: UiRisk = (UI_RISKS as readonly unknown[]).includes(s.risk)
      ? (s.risk as UiRisk)
      : 'auto';
    const i = out.length;
    if (kind === 'say') {
      const say = cleanSay(s.say);
      if (say) from.push(rawIndex);
      out.push({
        i,
        kind,
        target: null,
        value: null,
        expect: null,
        risk: 'auto',
        reason: null,
        nav: false,
        say,
        undo: 'none',
      });
      continue;
    }
    if (kind === 'wait') {
      from.push(rawIndex);
      out.push({
        i,
        kind,
        target: null,
        value: null,
        // (мемо) Шаг цели: «счётчик ±N»/«поле = слот» — только у мемо.
        expect: p.pins
          ? withGoalExtras(cleanExpect(s.expect), s.expect)
          : cleanExpect(s.expect),
        risk: 'auto',
        reason: null,
        nav: false,
        say: null,
        undo: 'none',
      });
      continue;
    }

    // ── цель ──
    let facts: TargetFacts | null = null;
    let target: UiTarget | null = null;
    let after: AfterTarget | null = null;
    const ref = typeof s.target === 'string' ? s.target : null;
    // Переход ПОСЛЕ перехода — ссылка новой страницы: только по описанию
    // (`after`), не по ref/адресу старого снимка (иначе на новой странице
    // загрузчик нажмёт элемент с тем же номером — другую цель).
    if (kind === 'navigate' && afterNav) kind = 'click';
    if (kind === 'navigate') {
      // Переход — только по ссылке со страницы: адрес «из головы» модели
      // не принимается (§5-бис.3 п.4), это клик по найденной ссылке.
      const href = typeof s.target === 'string' ? s.target : null;
      const el =
        (href && byRef.get(href)) ||
        (href ? byHref.get(stripQuery(href) ?? '') : undefined);
      if (!el || !el.href) {
        notes.push({
          code:
            href && !SNAP_REF_RE.test(href) && !onSiteHost(href, p.hosts)
              ? 'offhost'
              : 'no_target',
          target: null,
        });
        continue;
      }
      kind = 'click';
      facts = factsOfElement(el);
      target = targetOf(el.ref, facts, null);
    } else if (ref && SNAP_REF_RE.test(ref) && !afterNav) {
      const el = byRef.get(ref);
      if (el) {
        facts = factsOfElement(el);
        target = targetOf(el.ref, facts, null);
      }
    } else if (ref && MAP_REF_RE.test(ref) && !afterNav) {
      const m = byMap.get(ref);
      if (m) {
        facts = factsOfMap(m);
        target = targetOf(m.ref, facts, m.selector);
      }
    } else if (afterNav) {
      after = cleanAfter(s.target);
      if (after) {
        facts = afterFacts(after);
        target = {
          ref: 'after',
          assistId: after.assistId,
          role: after.role,
          text: after.text,
          selector: null,
          href: null,
        };
      }
    } else if (kind === 'scroll' && s.target === undefined) {
      from.push(rawIndex);
      out.push({
        i,
        kind,
        target: null,
        value: null,
        expect: null,
        risk: 'auto',
        reason: null,
        nav: false,
        say: null,
        undo: 'none',
      });
      continue;
    }
    if (!facts || !target) {
      notes.push({ code: 'no_target', target: null });
      continue;
    }
    const value =
      kind === 'fill' || kind === 'select'
        ? typeof s.value === 'string'
          ? s.value.trim().slice(0, 200)
          : null
        : null;
    const hint =
      !after && p.mapHints ? (p.mapHints.get(target.ref) ?? null) : null;
    const j = judgeStep(
      kind,
      facts,
      value,
      hint ? { ...ctx, names: hint.names } : ctx,
    );
    if (j.risk === null) {
      notes.push({
        code: j.reason ?? 'no_target',
        target: target.text || null,
      });
      continue;
    }
    // (Э6-тер (и)) Объявленная компенсация — кодом, по разметке/карте.
    const comp =
      p.compensations && !after
        ? compOfStep(kind, facts, hint, p.snapshot, p.hosts, p.rules)
        : null;
    // Класс обратимости — КОДОМ (поле `undo` ответа модели не читается).
    const undo: UiUndo = after
      ? provisionalUndo(kind, after)
      : undoClass(kind, facts, j.nav, comp?.src === 'map');
    // Необратимый шаг — всегда не ниже «с подтверждением» (§5-бис.15 п.3 п.4).
    let risk = raise(j.risk, modelRisk);
    if (undo === 'irrev') risk = raise(risk, 'confirm');
    // Р-51: риск карты — нижняя граница, итог = max(расчёт кода, карта).
    if (hint) risk = raise(risk, hint.floor);
    let reason: UiStopReason | null = null;
    if (
      destructiveCommand &&
      (risk === 'auto' || risk === 'confirm') &&
      sideEffectKind(kind, facts)
    ) {
      if (facts.assistId && REVERSIBLE_ASSIST_IDS.has(facts.assistId))
        risk = raise(risk, 'confirm');
      else {
        risk = 'never';
        reason = 'danger';
      }
    }
    const executable = risk === 'auto' || risk === 'confirm';
    // Р-60: после ТН — только шаги без эффекта и переходы; второй
    // необратимый шаг — отдельной командой (план обрезается до него).
    if (executable && pnr !== null && !allowedAfterPnr(undo)) {
      notes.push({ code: 'second_pnr', target: target.text || null });
      break;
    }
    let expect = cleanExpect(s.expect);
    if (j.nav && facts.href && !expect?.path) {
      const hp = hrefPath(facts.href);
      if (hp) expect = { ...(expect ?? {}), path: hp };
    }
    const step: UiPlanStep = {
      i,
      kind,
      target,
      value,
      expect,
      risk,
      reason:
        risk === 'manual' || risk === 'never'
          ? (reason ??
            j.reason ??
            (hint?.floor === 'never' ? 'denied' : 'danger'))
          : null,
      nav: j.nav,
      say: null,
      undo,
      ...(p.pins?.[rawIndex] ? { pin: p.pins[rawIndex] } : {}),
      ...(hint ? { mapKey: hint.key } : {}),
      ...(comp && undo === 'comp' && executable ? { comp } : {}),
    };
    if (executable && undo === 'irrev' && pnr === null) pnr = out.length;
    from.push(rawIndex);
    out.push(step);
    if (risk === 'manual' || risk === 'never') {
      notes.push({
        code: step.reason as UiStopReason,
        target: target.text || null,
      });
      stopped = true;
    }
    if (j.nav) afterNav = true;
  }
  return {
    steps: out,
    notes,
    needsConfirm: out.some((s) => s.risk === 'confirm'),
    pnr,
    from,
  };
}

/** Шаг меняет данные (не переход по ссылке, не поле ввода). */
function sideEffectKind(kind: UiStepKind, t: TargetFacts): boolean {
  if (kind === 'select' || kind === 'check') return true;
  if (kind !== 'click') return false;
  return !(t.href && (t.role === 'link' || t.tag === 'a'));
}

function stripQuery(href: string): string | null {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Продолжение на новой странице (§4-бис.5, §5-бис.3 п.7): шаги `after`
 * получают настоящую цель из НОВОГО снимка (разметка → видимый текст с
 * ролью) и проходят те же проверки. Риск только растёт относительно
 * подтверждённого: стал «с подтверждением», а план шёл без карточки, —
 * `needsConfirm`; стал «никогда/нажмите сами» — шаг подсветки и конец.
 * Не нашлась цель — `unresolved` (план останавливается «нажмите сами»).
 */
export function resolveAfterSteps(p: {
  steps: UiPlanStep[];
  from: number;
  snapshot: UiSnapshot;
  transcript: string;
  rules: VoiceControlRules;
  hosts: string[];
  state: 'on' | 'degraded';
  trusted?: readonly string[];
  /**
   * (Э6-тер, аудит) Подсказки голосовой карты НОВОЙ страницы — как в
   * `checkPlan`: риск карты — нижняя граница и после перехода (Р-51).
   */
  mapHints?: PlanCheckInput['mapHints'];
  /** (Э6-тер (и)) Как в `checkPlan`: компенсации шагам `comp` («Сайт»). */
  compensations?: boolean;
}): {
  steps: UiPlanStep[];
  needsConfirm: boolean;
  unresolved: number | null;
  /** Почему цель не принята: нет/неоднозначна, вторая ТН, не тот отпечаток. */
  reason?: 'no_target' | 'second_pnr' | 'pin_mismatch';
} {
  const steps = p.steps.map((s) => ({ ...s }));
  let needsConfirm = false;
  let pagePath: string | null = null;
  try {
    pagePath = new URL(p.snapshot.url).pathname;
  } catch {
    pagePath = null;
  }
  const ctx = {
    transcript: p.transcript,
    rules: p.rules,
    hosts: p.hosts,
    pagePath,
    state: p.state,
    trusted: p.trusted,
  };
  let navSeen = false;
  const isPnr = (s: UiPlanStep) =>
    s.undo === 'irrev' && (s.risk === 'auto' || s.risk === 'confirm');
  for (let k = p.from; k < steps.length; k++) {
    const s = steps[k];
    if (navSeen) break; // следующая страница — следующее продолжение
    if (!s.target || s.target.ref !== 'after') {
      if (s.nav) navSeen = true;
      continue;
    }
    const want = s.target;
    const norm = normText(want.text);
    let found = p.snapshot.elements.filter((e) =>
      want.assistId ? e.assistId === want.assistId : normText(e.text) === norm,
    );
    // Роль из описания модели — только чтобы различить одинаковые подписи.
    if (found.length > 1 && want.role)
      found = found.filter((e) => e.role === want.role);
    if (found.length !== 1)
      return { steps, needsConfirm, unresolved: k, reason: 'no_target' };
    const el = found[0];
    // (мемо) Закреплённый отпечаток: та же разметка, но другая кнопка
    // («Купить в 1 клик» вместо «В кошик») — шаг не исполняется (§5-бис.17 п.5).
    if (s.pin && !pinMatches(s.pin, el))
      return { steps, needsConfirm, unresolved: k, reason: 'pin_mismatch' };
    const facts = factsOfElement(el);
    const hint = p.mapHints?.get(el.ref) ?? null;
    const j = judgeStep(
      s.kind,
      facts,
      s.value,
      hint ? { ...ctx, names: hint.names } : ctx,
    );
    if (j.risk === null)
      return { steps, needsConfirm, unresolved: k, reason: 'no_target' };
    const comp = p.compensations
      ? compOfStep(s.kind, facts, hint, p.snapshot, p.hosts, p.rules)
      : null;
    // Класс обратимости по настоящей цели — только ухудшение (§5-бис.15 п.3).
    const undo = worseUndo(
      s.undo ?? 'irrev',
      undoClass(s.kind, facts, j.nav, comp?.src === 'map'),
    );
    let risk = raise(j.risk, s.risk);
    if (undo === 'irrev') risk = raise(risk, 'confirm');
    if (hint) risk = raise(risk, hint.floor);
    const executable = risk === 'auto' || risk === 'confirm';
    // Р-60: ТН уже была раньше — второй необратимый/эффект после ТН — стоп.
    if (
      executable &&
      !allowedAfterPnr(undo) &&
      steps.slice(0, k).some((x) => isPnr(x))
    )
      return { steps, needsConfirm, unresolved: k, reason: 'second_pnr' };
    if (risk === 'confirm' && s.risk !== 'confirm') needsConfirm = true;
    const { comp: _prev, ...rest } = s;
    steps[k] = {
      ...rest,
      target: targetOf(el.ref, facts, null),
      risk,
      reason:
        risk === 'manual' || risk === 'never'
          ? (j.reason ?? (hint?.floor === 'never' ? 'denied' : 'danger'))
          : null,
      nav: j.nav,
      undo,
      ...(hint ? { mapKey: hint.key } : {}),
      ...(comp && undo === 'comp' && executable ? { comp } : {}),
    };
    if (risk === 'manual' || risk === 'never') {
      steps.length = k + 1;
      break;
    }
    if (j.nav) navSeen = true;
  }
  return { steps, needsConfirm, unresolved: null };
}

/**
 * Отпечаток совпал с живой целью (§5-бис.17 п.5): роль (если закреплена),
 * разметка и нормализованный видимый текст (подпись с «…» — по началу).
 */
export function pinMatches(pin: UiPin, el: UiSnapElement): boolean {
  if (pin.role && el.role !== pin.role) return false;
  if ((pin.assistId ?? null) !== (el.assistId ?? null)) return false;
  const want = normText(pin.text).replace(/…$/u, '');
  const live = normText(el.text).replace(/…$/u, '');
  if (!want) return !!pin.assistId;
  return live === want || (want.length >= 60 && live.startsWith(want));
}
