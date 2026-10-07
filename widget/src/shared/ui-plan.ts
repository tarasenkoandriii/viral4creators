/**
 * Голосовое управление «Сайтом» (Э6-бис (а), ТЗ помощника §5-бис.3–6) —
 * общее для iframe-чата и ленивого чанка загрузчика `act.js`: формы снимка и
 * шагов (повтор `sites-backend/src/modules/assist-ui-core/types.ts`; сверку
 * держит `scripts/ui-plan.test.ts`), строгий разбор шагов из сообщений,
 * маскирование подписей (порт `maskSensitiveEcho`) и стоп-лист настоящей цели
 * (порт словаря `assist-ui-core/action-words.ts` — проверка в момент
 * исполнения, §5-бис.6 п.5).
 *
 * Сервер решает всё; загрузчик только ЕЩЁ РАЗ отказывает по живому DOM
 * (элемент мог поменяться между снимком и кликом) — никогда не разрешает
 * то, что сервер запретил.
 */

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

export type UiGesture = 'new_tab' | 'file' | 'download' | 'copy';

/** Элемент снимка — то, что уходит на сервер (подписи уже маскированы). */
export interface SnapElement {
  ref: string;
  role: UiRole;
  tag: 'a' | 'button' | 'input' | 'select' | 'textarea' | 'other';
  text: string;
  hiddenLabel: string | null;
  assistId: string | null;
  inputType: string | null;
  href: string | null;
  disabled: boolean;
  checked: boolean | null;
  selected: string | null;
  options: string[];
  heading: string | null;
  submit: boolean;
  inForm: boolean;
  confirmZone: boolean;
  pd: boolean;
  toggle: boolean;
  gesture: UiGesture | null;
  inView: boolean;
  /** Э6-тер (и): `data-assist-undo` (закрытый список) и `-at` (путь) — если есть. */
  undo?: string;
  undoAt?: string | null;
}

export interface Snapshot {
  url: string;
  title: string;
  elements: SnapElement[];
}

export type UiStepKind =
  | 'scroll'
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'navigate'
  | 'wait'
  | 'highlight'
  | 'say';
export type UiRisk = 'auto' | 'confirm' | 'manual' | 'never';
export type UiStepState =
  | 'pending'
  | 'dispatched'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'stopped'
  | 'manual';
/** Итог шага от загрузчика (сервер — `UI_STEP_RESULTS`). */
export type UiStepResult = Exclude<UiStepState, 'pending'>;

export interface UiTarget {
  ref: string;
  assistId: string | null;
  role: UiRole | null;
  text: string;
  selector: string | null;
  href: string | null;
}

export interface UiStep {
  i: number;
  kind: UiStepKind;
  target: UiTarget | null;
  value: string | null;
  expect: { path?: string; appear?: string; textChange?: boolean } | null;
  risk: UiRisk;
  reason: string | null;
  nav: boolean;
  say: string | null;
  state: UiStepState;
}

const KINDS: readonly string[] = [
  'scroll',
  'click',
  'fill',
  'select',
  'check',
  'navigate',
  'wait',
  'highlight',
  'say',
];
const RISKS: readonly string[] = ['auto', 'confirm', 'manual', 'never'];
const STATES: readonly string[] = [
  'pending',
  'dispatched',
  'done',
  'skipped',
  'failed',
  'stopped',
  'manual',
];
export const STEP_RESULTS: readonly UiStepResult[] = [
  'dispatched',
  'done',
  'skipped',
  'failed',
  'stopped',
  'manual',
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length <= max ? v : null;

export const PLAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const ASSIST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** Ссылка шага на элемент снимка/карты/«после перехода». */
const TARGET_REF = /^(e[1-9]\d{0,2}|m[1-9]\d?|after)$/;

/** Селектор карты — печатный CSS без `<`, обратных кавычек и управляющих. */
function selectorOk(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return s.length <= 200 && !/[\u0000-\u001f\u007f<`]/.test(s);
}

function target(v: unknown): UiTarget | null {
  if (!isObj(v)) return null;
  const ref = str(v.ref, 8);
  if (!ref || !TARGET_REF.test(ref)) return null;
  const role =
    typeof v.role === 'string' &&
    (UI_ROLES as readonly string[]).includes(v.role)
      ? (v.role as UiRole)
      : null;
  const sel = str(v.selector, 200);
  const href = str(v.href, 300);
  return {
    ref,
    assistId:
      typeof v.assistId === 'string' && ASSIST_ID.test(v.assistId)
        ? v.assistId
        : null,
    role,
    text: str(v.text, 81) ?? '',
    selector: sel && selectorOk(sel) ? sel : null,
    href: href && /^https?:\/\//.test(href) ? href : null,
  };
}

/** Строгий разбор шага (сервер → iframe → загрузчик); мусор — null. */
export function parseStep(v: unknown): UiStep | null {
  if (!isObj(v)) return null;
  if (typeof v.kind !== 'string' || KINDS.indexOf(v.kind) < 0) return null;
  if (typeof v.risk !== 'string' || RISKS.indexOf(v.risk) < 0) return null;
  const i = v.i;
  if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i > 20)
    return null;
  const t =
    v.target === null || v.target === undefined ? null : target(v.target);
  if (v.target && !t) return null;
  const e = isObj(v.expect) ? v.expect : null;
  const expect = e
    ? {
        ...(typeof e.path === 'string' &&
        e.path.length <= 300 &&
        e.path[0] === '/'
          ? { path: e.path }
          : {}),
        ...(typeof e.appear === 'string' && e.appear.length <= 81
          ? { appear: e.appear }
          : {}),
        ...(e.textChange === true ? { textChange: true } : {}),
      }
    : null;
  const state =
    typeof v.state === 'string' && STATES.indexOf(v.state) >= 0
      ? (v.state as UiStepState)
      : 'pending';
  return {
    i,
    kind: v.kind as UiStepKind,
    target: t,
    value: str(v.value, 200),
    expect: expect && Object.keys(expect).length ? expect : null,
    risk: v.risk as UiRisk,
    reason: str(v.reason, 40),
    nav: v.nav === true,
    say: str(v.say, 200),
    state,
  };
}

export function parseSteps(v: unknown): UiStep[] | null {
  if (!Array.isArray(v) || v.length > 20) return null;
  const out: UiStep[] = [];
  for (const x of v) {
    const s = parseStep(x);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

// ── Маскирование подписей снимка (порт maskSensitiveEcho, §5-бис.3 п.2) ───

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
/** Порт PHONE_PATTERN чата: дата (группа 1) остаётся, телефон — от 8 цифр. */
const PHONE =
  /(\d{4}([-./])(?:0?[1-9]|1[0-2])\2(?:0?[1-9]|[12]\d|3[01])(?!\d)|(?:0?[1-9]|[12]\d|3[01])([-.])(?:0?[1-9]|1[0-2])\3\d{4}(?!\d))|\(\d{2,5}\)\s?\d(?:[\s.-]?\d){4,}|\+?\d(?:(?:[\s.-]|\)\s?|\s?\()?\d){7,}/g;
const TOKEN = /\b(sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,})\b/g;
const LONG_DIGITS = /\(?\d(?:[\s()-]{0,2}\d){8,}/g;

/** Маска подписи ДО отправки: e-mail, ключи, телефоны, длинные цифры. */
export function maskLabel(s: string): string {
  return s
    .replace(EMAIL, '[e-mail]')
    .replace(TOKEN, '[ключ]')
    .replace(PHONE, (m, d) =>
      d || m.replace(/\D/g, '').length < 8 ? m : '[тел.]'
    )
    .replace(LONG_DIGITS, '[№]');
}

// ── Стоп-лист настоящей цели (порт action-words: только «никогда») ────────

/**
 * Категории «никогда» (§5-бис.5) — с начала слова, uk/ru/en. Повтор
 * `danger-words.ts` (оплата, удаление, оформление заказа, отмена подписки) и
 * своего словаря `assist-ui-core/action-words.ts` (отмена заказа, возврат,
 * списание, массовые, «оформить»). Сверку держит scripts/ui-plan.test.ts.
 */
export const NEVER_PATTERNS: RegExp[] = [
  /(?:^|[^\p{L}])(оплат|оплач|сплат|заплат|pay|payment|checkout)/iu,
  /(?:^|[^\p{L}])(удал|видал|вилуч|delete|remove|erase)/iu,
  /(?:^|[^\p{L}])(оформить заказ|подтвердить заказ|оформити замовлення|підтвердити замовлення|confirm order|place order|submit order|buy now|купить|купити)/iu,
  /(?:^|[^\p{L}])(отменить подписку|скасувати підписку|cancel subscription|unsubscribe)/iu,
  /(?:^|[^\p{L}])(отменить заказ|отмените заказ|отмена заказа|скасувати замовлення|скасуйте замовлення|скасування замовлення|cancel order)/iu,
  /(?:^|[^\p{L}])(возврат|вернуть деньги|оформить возврат|повернення|повернути кошти|refund|return order)/iu,
  /(?:^|[^\p{L}])(списать|списание|списати|списання|начислить|нарахувати|charge|payout|withdraw|вывести средства|вивести кошти)/iu,
  /(?:^|[^\p{L}])(выбрать все|выделить все|отметить все|вибрати все|виділити все|позначити все|select all|check all)/iu,
  /(?:^|[^\p{L}])(оформ(?:ить|ити|ление|лення|и)|до оформлення|к оформлению|proceed to checkout|checkout)/iu,
];
/**
 * «Купить/Купити/Buy now» — снимает только разметка `add-to-cart`. Начало
 * слова — группой `(^|не-буква)`, а не lookbehind `(?<!\p{L})`: lookbehind
 * роняет разбор всего чанка в Safari < 16.4 (act.js/admin-act.js/editor.js).
 * Захваченный префикс в replace возвращается (`$1`).
 */
const BUY = /(^|[^\p{L}])(купить|купити|buy now)/iu;

/** Живая цель под стоп-листом (текст, скрытая подпись, разметка). */
export function neverTarget(text: string, assistId: string | null): boolean {
  const probe = text.slice(0, 300);
  for (const re of NEVER_PATTERNS) {
    if (!re.test(probe)) continue;
    // add-to-cart снимает только «Купить» (ложный срабатыватель), не «Оплатить».
    if (assistId === 'add-to-cart' && re.source.indexOf('купити') >= 0) {
      const rest = probe.replace(new RegExp(BUY.source, 'giu'), '$1 ');
      if (!re.test(rest)) continue;
    }
    return true;
  }
  return false;
}

/** Путь похож на страницу оплаты (§5-бис.5). */
export function paymentPath(path: string): boolean {
  return /(^|[/_.-])(checkout|payment|payments|pay|oplata|оплата|kasa|kassa|gateway|liqpay|wayforpay|fondy|stripe|paypal)([/_.-]|$)/iu.test(
    path
  );
}

// ── Команда или вопрос; «да/нет/стоп» (порт assist-ui-core) ───────────────

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

const CMD =
  /^(відкрий(те)?|натисни|натисніть|перейди(ть)?|відкрити|открой(те)?|нажми(те)?|перейди(те)?|open|click|press|tap|go to|знайди(ть)?|шукай|пошукай|найди(те)?|ищи|поищи|find|search( for)?|look for|додай(те)?|добавь(те)?|add|заповни(ть)?|заполни(те)?|fill|введи(ть|те)?|enter|type|вибери(ть)?|обери(ть)?|выбери(те)?|select|choose|постав(те)?|поставь(те)?|check|прокрути(ть|те)?|scroll|закрий(те)?|закрой(те)?|close|покажи(ть|те)?|show|оплати(ть|те)?|pay|видали(ть)?|удали(те)?|delete|оформи(ть|те)?|скасуй(те)?|отмени(те)?|cancel|завантаж(те)?|загрузи(те)?|upload|скопіюй(те)?|скопируй(те)?|copy|надішли(ть)?|відправ(те)?|отправь(те)?|send|submit)(\s+|$)/u;

/** Команда-действие (а не вопрос) — первое слово из глаголов действия. */
export function looksLikeCommand(text: string): boolean {
  return CMD.test(
    norm(text)
      .replace(/[.!?,…]+$/u, '')
      .replace(/^(будь ласка|пожалуйста|please),?\s+/u, '')
  );
}

const YES = [
  'да',
  'так',
  'yes',
  'yeah',
  'yep',
  'ok',
  'okay',
  'ок',
  'окей',
  'давай',
  'давайте',
  'підтверджую',
  'подтверждаю',
  'confirm',
  'звісно',
  'конечно',
  'sure',
  'ага',
];
const NO = [
  'нет',
  'ні',
  'no',
  'nope',
  'не',
  'отмена',
  'скасуй',
  'скасувати',
  'отмени',
  'cancel',
];
const NO2 = ['не надо', 'не треба', 'не нужно', 'не потрібно'];
const STOP = [
  'стоп',
  'хватит',
  'зупинись',
  'зупини',
  'зупиніть',
  'stop',
  'досить',
  'остановись',
  'остановите',
  'стій',
  'стой',
  'halt',
  'пауза',
  'pause',
];
const POLITE = ['будь', 'ласка', 'пожалуйста', 'please'];

/** «Да»/«Нет»/«Стоп» — фраза целиком из закрытого списка (до трёх слов). */
export function replyKind(text: string): 'yes' | 'no' | 'stop' | null {
  const w = norm(text)
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
  if (!w.length || w.length > 3) return null;
  const tail = (set: string[]) =>
    w.slice(1).every((x) => set.indexOf(x) >= 0 || POLITE.indexOf(x) >= 0);
  if (STOP.indexOf(w[0]) >= 0 && tail(STOP)) return 'stop';
  if (NO2.indexOf(w.slice(0, 2).join(' ')) >= 0) return 'no';
  if (NO.indexOf(w[0]) >= 0 && tail(NO)) return 'no';
  if (YES.indexOf(w[0]) >= 0 && tail(YES)) return 'yes';
  return null;
}

// ── (д) «Отмени последнее», (е) «Що ти вмієш?» — закрытые списки фраз ─────

/**
 * «Отмени последнее / верни как было / скасуй» (§5-бис.15 п.6 п.4, Р-65):
 * фраза целиком из закрытого списка (прямой путь без модели). Одиночное
 * «скасуй/отмени» — это «нет» на карточке, а не возврат.
 */
const UNDO_PHRASES = [
  'скасуй останнє',
  'скасуй остання',
  'скасувати останнє',
  'відміни останнє',
  'поверни як було',
  'поверни все як було',
  'поверни назад',
  'отмени последнее',
  'отмени последнее действие',
  'верни как было',
  'верни все как было',
  'верни обратно',
  'undo',
  'undo that',
  'undo the last',
  'undo last',
  'put it back',
  'revert that',
];

export function undoPhrase(text: string): boolean {
  const t = norm(text)
    .replace(/[.!?,…]+$/u, '')
    .replace(/^(будь ласка|пожалуйста|please),?\s+/u, '')
    .replace(/,?\s+(будь ласка|пожалуйста|please)$/u, '');
  return UNDO_PHRASES.indexOf(t) >= 0;
}

/** «Що ти вмієш?» (§5-бис.17 п.11, В-74) — до 5 имён мемо. */
export function skillsPhrase(text: string): boolean {
  return /^(що ти вмієш|що вмієш|що ти можеш|что ты умеешь|что умеешь|что ты можешь|what can you do|what do you do)\??$/u.test(
    norm(text).replace(/[.!…]+$/u, '')
  );
}

// ── Команды плана iframe → загрузчик (строгий разбор — в чанке act.js) ────

export type UiCommand =
  | { type: 'ui-snap'; rid: string; deny: string[]; allow: string[] }
  | {
      type: 'ui-run';
      planId: string;
      steps: UiStep[];
      from: number;
      lang: 'uk' | 'ru' | 'en';
    }
  | { type: 'ui-ack'; planId: string; index: number }
  | { type: 'ui-stop'; planId: string }
  | { type: 'ui-pause'; on: boolean };

const RID = /^[a-z0-9]{8,32}$/;

export function parseUiCommand(m: Record<string, unknown>): UiCommand | null {
  const idx = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 20;
  const plan = typeof m.planId === 'string' && PLAN_ID.test(m.planId);
  switch (m.type) {
    case 'ui-snap': {
      const list = (v: unknown) =>
        Array.isArray(v) && v.length <= 30
          ? v.filter(
              (x): x is string =>
                typeof x === 'string' && !!x.trim() && selectorOk(x)
            )
          : null;
      const deny = list(m.deny);
      const allow = list(m.allow);
      return typeof m.rid === 'string' && RID.test(m.rid) && deny && allow
        ? { type: 'ui-snap', rid: m.rid, deny, allow }
        : null;
    }
    case 'ui-run': {
      const steps = parseSteps(m.steps);
      return plan && steps && idx(m.from) && (m.from as number) <= steps.length
        ? {
            type: 'ui-run',
            planId: m.planId as string,
            steps,
            from: m.from as number,
            lang: m.lang === 'ru' || m.lang === 'en' ? m.lang : 'uk',
          }
        : null;
    }
    case 'ui-ack':
      return plan && idx(m.index)
        ? {
            type: 'ui-ack',
            planId: m.planId as string,
            index: m.index as number,
          }
        : null;
    case 'ui-stop':
      return plan ? { type: 'ui-stop', planId: m.planId as string } : null;
    case 'ui-pause':
      return typeof m.on === 'boolean' ? { type: 'ui-pause', on: m.on } : null;
    default:
      return null;
  }
}
