/**
 * Протокол postMessage загрузчик ↔ iframe-чат (ТЗ §4.12, §3-бис.2) —
 * общий для обеих частей виджета. Владелец — W1; форма зафиксирована
 * контрактом Э2 §5 (менять — через координатора).
 *
 * Граница доверия:
 *  - загрузчик принимает, только если event.origin === origin iframe И
 *    event.source === iframe.contentWindow; iframe — только если
 *    event.source === window.parent И event.origin === проверенный
 *    parentOrigin; targetOrigin — никогда не '*';
 *  - каждое сообщение `{ ns, v, type, … }`: чужие ns/v/type — игнор, поля и
 *    длины проверяются (parseParentMessage/parseFrameMessage);
 *  - НЕСИММЕТРИЧНО по данным: из iframe наружу — только размер, состояние
 *    окна и ТИП события (`V4CAssist('on')`): ни текста переписки, ни полей
 *    лида, ни токенов. Команды «отдай историю» нет;
 *  - ни одно сообщение родителя (ask/context) не исполняет действий —
 *    `ask` только кладёт вопрос в поле ввода/отправляет как вопрос посетителя.
 */
import {
  WIDGET_MESSAGE_NS,
  WIDGET_PK_LIVE_PREFIX,
  WIDGET_PK_TEST_PREFIX,
  WIDGET_PROTOCOL_VERSION,
} from './brand';
import { POSITIONS, UI_LANGS, cleanOrigin, isObj, oneOf, text } from './config';
import { ENG_KEY, GOAL_KEY, ORDER_ID } from './engagement';
import {
  PLAN_ID,
  STEP_RESULTS,
  type UiCommand,
  type UiStepResult,
} from './ui-plan';

type Obj = Record<string, unknown>;

export type WidgetPosition =
  'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/** Родитель (загрузчик) → iframe. */
export type ParentMessage =
  | {
      type: 'init';
      pk: string;
      /** location.origin страницы — iframe сверяет с ancestorOrigins/referrer. */
      parentOrigin: string;
      page: { url: string; title: string };
      uiLang: 'uk' | 'ru' | 'en' | null;
      mode: 'float' | 'inline';
      /** Вычисленный font-family body страницы — для шрифта «как на сайте». */
      siteFont: string | null;
      /** data-theme на <html> страницы (тема «как на сайте»). */
      siteTheme: 'light' | 'dark' | null;
      /** Одноразовый токен `?v4c_preview=` — iframe обменяет его сам. */
      previewToken: string | null;
      /**
       * Э6-бис (г): одноразовая ссылка мастера проверки `?v4c_voicetest=` —
       * iframe обменяет её на тестовую сессию (как предпросмотр).
       */
      voiceTest: string | null;
      /** Окно было открыто на прошлой странице (sessionStorage страницы). */
      restoreOpen: boolean;
    }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'ask'; question: string }
  | { type: 'context'; data: Record<string, string | number> }
  | { type: 'route'; page: { url: string; title: string } }
  | {
      type: 'identify';
      name?: string;
      email?: string;
      externalId?: string;
      userHash?: string;
    }
  | { type: 'position'; position: WidgetPosition }
  /** «к Л2»: черновой вид во вкладке, только при allowClientPreview. */
  | { type: 'preview'; partialConfig: unknown }
  /**
   * Э3 (§5-тер.1–2): загрузчик поймал цель, а iframe этого документа жив —
   * iframe отправит её С посетителем и диалогом (direct/assisted). Значения
   * — только ключ, детектор, docId, путь, orderId/value/currency (их
   * проверяет и загрузчик, и сервер).
   */
  | {
      type: 'goal';
      goalKey: string;
      detector: 'url' | 'click' | 'form_submit' | 'js';
      docId: string;
      path: string | null;
      orderId: string | null;
      value: number | null;
      currency: string | null;
    }
  /**
   * Э6 (§4.12): итог подсветки — элемент найден и подсвечен или нет
   * (вёрстка сменилась — iframe шлёт сигнал «карта устарела»). Подделать
   * может любой скрипт страницы — последствие: лишний сигнал своему же сайту.
   */
  | { type: 'highlight-result'; elementId: string; found: boolean }
  /**
   * Э3-бис (§5-тер.9): связанный режим — посетитель дал согласие на
   * аналитику (чанк ana.js): ключ визита (null — согласие отозвано) и
   * вариант B идущего эксперимента для группы b (приветствие/подсказки по
   * языкам). Подделать может скрипт страницы — последствие: свой же
   * посетитель увидит другой текст приветствия; ключ визита сервер
   * принимает только при связанном режиме сайта.
   */
  | {
      type: 'ana';
      /** Не `v`: это имя занято версией конверта протокола. */
      visit: string | null;
      greeting: Partial<Record<UiLang3, string>> | null;
      suggestions: Partial<Record<UiLang3, string[]>> | null;
    }
  /**
   * Э6-бис (§5-бис.3 п.2): снимок интерактивных элементов страницы — ответ
   * на `ui-snap` с тем же `rid` (iframe принимает только ожидаемый ответ;
   * сервер разбирает снимок строго заново). Подписи уже маскированы.
   */
  | { type: 'ui-snapshot'; rid: string; snapshot: unknown }
  /**
   * Э6-бис: итог шага плана у загрузчика (`dispatched` — ДО навигационного
   * клика; клик — только после `ui-ack`). Подделать может скрипт страницы —
   * последствие: план своего посетителя остановится/продвинется на сервере;
   * действий вне проверенного сервером плана это не даёт.
   */
  | {
      type: 'ui-step';
      planId: string;
      index: number;
      result: UiStepResult;
      reason: string | null;
      url: string | null;
      ms: number;
    }
  /**
   * Э6-бис: дальше шаг «после перехода» (SPA сменила страницу без
   * перезагрузки) — iframe снимет новый снимок, сервер найдёт цель и
   * проверит её тем же кодом, затем — новый `ui-run` с этого шага.
   */
  | { type: 'ui-need'; planId: string; index: number }
  /**
   * Э6-бис (д): итог возврата полей чанком undo.js — по номерам шагов, БЕЗ
   * значений (прежние значения не покидают страницу, §5-бис.15 п.7).
   * Подделать может скрипт страницы — последствие: статус цепочки своего
   * же посетителя в журнале.
   */
  | {
      type: 'ui-undone';
      planId: string;
      results: Array<{
        i: number;
        result: 'done' | 'failed' | 'unknown' | 'gone';
      }>;
    }
  /** Э6-бис: человек взял управление (Esc, свой клик/клавиша, «Стоп» на странице). */
  | {
      type: 'ui-stopped';
      planId: string;
      by: 'esc' | 'click' | 'key' | 'button';
    }
  /**
   * Э6-бис (г): ответ чанка проверки страницы мастера (`check.js`) на
   * `vt-env`/`vt-markup` с тем же `rid`. Данные — подсчёты и короткие
   * селекторы/подписи (маскированы); сервер разбирает их строго заново.
   */
  | { type: 'vt-result'; rid: string; op: 'env' | 'markup'; data: unknown }
  /** Э3 (§3.6 п.4–5): посетитель принял проактивный сигнал → префилл или сценарий. */
  | {
      type: 'proactive';
      triggerKey: string;
      action: 'prefill' | 'scenario' | 'open';
      scenarioKey: string | null;
      question: string | null;
    };

/** iframe → родитель. */
export type FrameMessage =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'ui-state'; state: 'open' | 'min' | 'closed' }
  | { type: 'event'; name: 'open' | 'close' | 'lead' | 'handoff' }
  /**
   * Э3: счётчик для `POST /widget/v1/event` (загрузчик копит батч): только
   * вид и ключ триггера/сценария — без текста и без посетителя.
   */
  | {
      type: 'count';
      kind: 'link_click' | 'scenario_started' | 'scenario_done';
      key: string | null;
    }
  /** Э3: передача человеку изменилась — загрузчик держит iframe живым (не сворачивает в «закрыт»). */
  | {
      type: 'handoff-state';
      state: 'waiting' | 'active' | 'closed' | 'missed' | 'cancelled';
    }
  /** Чат недоступен на этом origin (origin_denied и т.п.) — загрузчик убирает кнопку. */
  | { type: 'unavailable'; code: string }
  /**
   * Э6 (§4.9, §4.12): подсветить элемент карты интерфейса. Селектор и
   * подпись — из карты СЕРВЕРА (не из текста модели); загрузчик ищет
   * `querySelectorAll` и ставит подпись `textContent` — ничего больше
   * из ответа модели на страницу заказчика не попадает.
   */
  | { type: 'highlight'; elementId: string; selector: string; caption: string }
  /** Э6-бис: команда плана для чанка act.js (разбирает её сам, строго). */
  | { type: 'ui-raw'; raw: Record<string, unknown> }
  /**
   * Э6-бис (§5-бис.3): команды плана — снять снимок (`ui-snap`; начать его
   * может только iframe: план — только из речи/набора в iframe, §5-бис.6
   * п.1), исполнить проверенные сервером шаги (`ui-run`), «dispatched
   * записан — нажимай» (`ui-ack`), стоп, пауза детектора речи.
   */
  | UiCommand
  /** Э6-бис (д): вернуть поля этих шагов из памяти страницы (чанк undo.js). */
  | { type: 'ui-undo'; planId: string; idx: number[] }
  /**
   * Э6-бис (г): мастер проверки Т-2 (только тестовая сессия владельца) —
   * окружение (CSP, Trusted Types, чанки), разметка страницы и два списка
   * опасного, обводка пунктов списка на странице. Чанк `check.js` разбирает
   * команды сам, строго.
   */
  | { type: 'vt-env'; rid: string }
  | { type: 'vt-markup'; rid: string; deny: string[]; allow: string[] }
  | { type: 'vt-mark'; keys: string[] };

export type Envelope<T> = T & { ns: string; v: number };

export function envelope<T extends { type: string }>(m: T): Envelope<T> {
  return { ...m, ns: WIDGET_MESSAGE_NS, v: WIDGET_PROTOCOL_VERSION };
}

const PK_RE = new RegExp(
  `^(?:${WIDGET_PK_LIVE_PREFIX}|${WIDGET_PK_TEST_PREFIX})[A-Za-z0-9_-]{8,64}$`
);
const TOKEN_RE = /^[A-Za-z0-9_.~-]{8,256}$/;
const FONT_RE = /^[\w\s,"'.-]{1,200}$/;
const CONTEXT_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;
export const MAX_QUESTION = 600;
export const MAX_CONTEXT_JSON = 500;
const MAX_PREVIEW_JSON = 4096;
/** Э6-бис: снимок (≤ 150 элементов) — до разбора сервером. */
export const MAX_SNAPSHOT_JSON = 90_000;
/** Э6-бис: одноразовый id запроса снимка. */
const RID = /^[a-z0-9]{8,32}$/;

export function isPk(v: unknown): v is string {
  return typeof v === 'string' && PK_RE.test(v);
}

function envelopeType(data: unknown): Obj | null {
  if (!isObj(data)) return null;
  if (data.ns !== WIDGET_MESSAGE_NS || data.v !== WIDGET_PROTOCOL_VERSION)
    return null;
  return typeof data.type === 'string' ? data : null;
}

/** URL страницы: только http(s), без фрагмента, ≤ 2000. */
export function pageUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function page(v: unknown): { url: string; title: string } | null {
  if (!isObj(v)) return null;
  const url = pageUrl(v.url);
  if (!url) return null;
  return { url, title: text(v.title, 200) ?? '' };
}

/** `V4CAssist('context')`: только строки/числа, ≤ 20 ключей, JSON ≤ 500 символов (§3-бис.2). */
export function cleanContext(
  v: unknown
): Record<string, string | number> | null {
  if (!isObj(v)) return null;
  const out: Record<string, string | number> = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (++n > 20) return null;
    const val = v[k];
    if (!CONTEXT_KEY_RE.test(k)) return null;
    if (typeof val === 'number' && isFinite(val)) out[k] = val;
    else if (typeof val === 'string') out[k] = text(val, 200) ?? '';
    else return null;
  }
  return JSON.stringify(out).length <= MAX_CONTEXT_JSON ? out : null;
}

/** `V4CAssist('identify')`: Э2 — только предзаполнение формы лида в памяти iframe. */
export function cleanIdentify(
  v: unknown
): Extract<ParentMessage, { type: 'identify' }> | null {
  if (!isObj(v)) return null;
  const out: Extract<ParentMessage, { type: 'identify' }> = {
    type: 'identify',
  };
  for (const k of ['name', 'email', 'externalId', 'userHash'] as const) {
    if (v[k] === undefined) continue;
    const t = text(v[k], 200);
    if (t === null) return null;
    out[k] = t;
  }
  return out;
}

const DOC_ID = /^[A-Za-z0-9_-]{8,64}$/;
const DETECTORS = ['url', 'click', 'form_submit', 'js'] as const;

/**
 * Цель (Э3): ключ, детектор, docId, путь (без query), orderId/value/currency
 * — тот же формат, что проверяет сервер (A и W, widget-engagement.ts).
 */
export function cleanGoal(
  m: Record<string, unknown>
): Extract<ParentMessage, { type: 'goal' }> | null {
  const path = m.path;
  const value = m.value;
  if (
    typeof m.goalKey !== 'string' ||
    !GOAL_KEY.test(m.goalKey) ||
    !(DETECTORS as readonly unknown[]).includes(m.detector) ||
    typeof m.docId !== 'string' ||
    !DOC_ID.test(m.docId) ||
    (path !== null &&
      (typeof path !== 'string' ||
        path.charAt(0) !== '/' ||
        path.length > 512 ||
        /[?#\s]/.test(path))) ||
    (m.orderId !== null &&
      (typeof m.orderId !== 'string' || !ORDER_ID.test(m.orderId))) ||
    (value !== null &&
      (typeof value !== 'number' ||
        !isFinite(value) ||
        value < 0 ||
        value > 1e9)) ||
    (m.currency !== null &&
      (typeof m.currency !== 'string' || !/^[A-Z]{3}$/.test(m.currency)))
  )
    return null;
  return {
    type: 'goal',
    goalKey: m.goalKey,
    detector: m.detector as (typeof DETECTORS)[number],
    docId: m.docId,
    path: path as string | null,
    orderId: m.orderId as string | null,
    value: value as number | null,
    currency: m.currency as string | null,
  };
}

/** Э6: id элемента карты интерфейса (`u` + 8 hex, как в sites-backend). */
export const UI_ELEMENT_ID = /^u[0-9a-f]{8}$/;

/** Э6: селектор карты — печатный CSS без `<`, обратных кавычек и управляющих, ≤ 200. */
export function cleanSelector(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > 200 || /[\u0000-\u001f\u007f<`]/.test(s)) return null;
  return s;
}

export function cleanQuestion(v: unknown): string | null {
  const q = text(v, MAX_QUESTION + 1);
  if (q === null) return null;
  const t = q.trim();
  return t && t.length <= MAX_QUESTION ? t : null;
}

type UiLang3 = 'uk' | 'ru' | 'en';
/** Э3-бис: ключ визита — случайная строка чанка ana.js. */
export const VISIT_KEY = /^[A-Za-z0-9_-]{16,64}$/;

/** Тексты варианта по языкам: строки ≤ max, массивы ≤ 4 (подсказки). */
function langMap<T>(
  v: unknown,
  item: (x: unknown) => T | null
): Partial<Record<UiLang3, T>> | null | false {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  const out: Partial<Record<UiLang3, T>> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k !== 'uk' && k !== 'ru' && k !== 'en') return false;
    const t = item(x);
    if (t === null) return false;
    out[k] = t;
  }
  return out;
}

function cleanAna(m: Record<string, unknown>): ParentMessage | null {
  if (
    m.visit !== null &&
    (typeof m.visit !== 'string' || !VISIT_KEY.test(m.visit))
  )
    return null;
  const str = (max: number) => (x: unknown) =>
    typeof x === 'string' && x.trim() && x.length <= max ? x.trim() : null;
  const greeting = langMap(m.greeting, str(300));
  const suggestions = langMap(m.suggestions, (x) => {
    if (!Array.isArray(x) || !x.length || x.length > 4) return null;
    const out = x.map(str(80));
    return out.every((y) => y !== null) ? (out as string[]) : null;
  });
  if (greeting === false || suggestions === false) return null;
  return {
    type: 'ana',
    visit: m.visit as string | null,
    greeting,
    suggestions,
  };
}

/** Строгий разбор сообщения родителя; null — игнорировать. */
export function parseParentMessage(data: unknown): ParentMessage | null {
  const m = envelopeType(data);
  if (!m) return null;
  switch (m.type) {
    case 'init': {
      const parentOrigin = cleanOrigin(m.parentOrigin);
      const pg = page(m.page);
      if (!isPk(m.pk) || !parentOrigin || !pg) return null;
      const siteFont =
        typeof m.siteFont === 'string' && FONT_RE.test(m.siteFont)
          ? m.siteFont
          : null;
      const previewToken =
        typeof m.previewToken === 'string' && TOKEN_RE.test(m.previewToken)
          ? m.previewToken
          : null;
      return {
        type: 'init',
        pk: m.pk,
        parentOrigin,
        page: pg,
        uiLang: m.uiLang === null ? null : oneOf(UI_LANGS, m.uiLang, 'uk'),
        mode: m.mode === 'inline' ? 'inline' : 'float',
        siteFont,
        siteTheme:
          m.siteTheme === 'light' || m.siteTheme === 'dark'
            ? m.siteTheme
            : null,
        previewToken,
        voiceTest:
          typeof m.voiceTest === 'string' && TOKEN_RE.test(m.voiceTest)
            ? m.voiceTest
            : null,
        restoreOpen: m.restoreOpen === true,
      };
    }
    case 'open':
    case 'close':
      return { type: m.type };
    case 'ask': {
      const question = cleanQuestion(m.question);
      return question ? { type: 'ask', question } : null;
    }
    case 'context': {
      const data = cleanContext(m.data);
      return data ? { type: 'context', data } : null;
    }
    case 'route': {
      const pg = page(m.page);
      return pg ? { type: 'route', page: pg } : null;
    }
    case 'identify':
      return cleanIdentify(m);
    case 'position':
      return (POSITIONS as readonly unknown[]).includes(m.position)
        ? { type: 'position', position: m.position as WidgetPosition }
        : null;
    case 'preview': {
      if (!isObj(m.partialConfig)) return null;
      let size = 0;
      try {
        size = JSON.stringify(m.partialConfig).length;
      } catch {
        return null;
      }
      return size <= MAX_PREVIEW_JSON
        ? { type: 'preview', partialConfig: m.partialConfig }
        : null;
    }
    case 'goal':
      return cleanGoal(m);
    case 'ana':
      return cleanAna(m);
    case 'highlight-result':
      return typeof m.elementId === 'string' &&
        UI_ELEMENT_ID.test(m.elementId) &&
        typeof m.found === 'boolean'
        ? { type: 'highlight-result', elementId: m.elementId, found: m.found }
        : null;
    case 'ui-snapshot': {
      if (typeof m.rid !== 'string' || !RID.test(m.rid) || !isObj(m.snapshot))
        return null;
      let size = 0;
      try {
        size = JSON.stringify(m.snapshot).length;
      } catch {
        return null;
      }
      return size <= MAX_SNAPSHOT_JSON
        ? { type: 'ui-snapshot', rid: m.rid, snapshot: m.snapshot }
        : null;
    }
    case 'ui-step': {
      const result = m.result as UiStepResult;
      if (
        typeof m.planId !== 'string' ||
        !PLAN_ID.test(m.planId) ||
        typeof m.index !== 'number' ||
        !Number.isInteger(m.index) ||
        m.index < 0 ||
        m.index > 20 ||
        STEP_RESULTS.indexOf(result) < 0
      )
        return null;
      const ms =
        typeof m.ms === 'number' && isFinite(m.ms)
          ? Math.max(0, Math.min(600000, Math.round(m.ms)))
          : 0;
      return {
        type: 'ui-step',
        planId: m.planId,
        index: m.index,
        result,
        reason:
          typeof m.reason === 'string' && /^[a-z_]{1,40}$/.test(m.reason)
            ? m.reason
            : null,
        url: pageUrl(m.url),
        ms,
      };
    }
    case 'ui-need':
      return typeof m.planId === 'string' &&
        PLAN_ID.test(m.planId) &&
        typeof m.index === 'number' &&
        Number.isInteger(m.index) &&
        m.index >= 0 &&
        m.index <= 20
        ? { type: 'ui-need', planId: m.planId, index: m.index }
        : null;
    case 'vt-result': {
      if (
        typeof m.rid !== 'string' ||
        !RID.test(m.rid) ||
        (m.op !== 'env' && m.op !== 'markup') ||
        !isObj(m.data)
      )
        return null;
      let size = 0;
      try {
        size = JSON.stringify(m.data).length;
      } catch {
        return null;
      }
      return size <= MAX_SNAPSHOT_JSON
        ? { type: 'vt-result', rid: m.rid, op: m.op, data: m.data }
        : null;
    }
    case 'ui-undone': {
      if (
        typeof m.planId !== 'string' ||
        !PLAN_ID.test(m.planId) ||
        !Array.isArray(m.results) ||
        m.results.length > 3
      )
        return null;
      const results: Array<{
        i: number;
        result: 'done' | 'failed' | 'unknown' | 'gone';
      }> = [];
      for (const x of m.results) {
        if (!isObj(x)) return null;
        const i = x.i;
        const r = x.result;
        if (
          typeof i !== 'number' ||
          !Number.isInteger(i) ||
          i < 0 ||
          i > 20 ||
          (r !== 'done' && r !== 'failed' && r !== 'unknown' && r !== 'gone')
        )
          return null;
        results.push({ i, result: r });
      }
      return { type: 'ui-undone', planId: m.planId, results };
    }
    case 'ui-stopped':
      return typeof m.planId === 'string' &&
        PLAN_ID.test(m.planId) &&
        (m.by === 'esc' ||
          m.by === 'click' ||
          m.by === 'key' ||
          m.by === 'button')
        ? { type: 'ui-stopped', planId: m.planId, by: m.by }
        : null;
    case 'proactive': {
      const action = m.action;
      if (
        typeof m.triggerKey !== 'string' ||
        !ENG_KEY.test(m.triggerKey) ||
        (action !== 'prefill' && action !== 'scenario' && action !== 'open')
      )
        return null;
      const scenarioKey =
        action === 'scenario' &&
        typeof m.scenarioKey === 'string' &&
        ENG_KEY.test(m.scenarioKey)
          ? m.scenarioKey
          : null;
      if (action === 'scenario' && !scenarioKey) return null;
      const question = action === 'prefill' ? cleanQuestion(m.question) : null;
      if (action === 'prefill' && !question) return null;
      return {
        type: 'proactive',
        triggerKey: m.triggerKey,
        action,
        scenarioKey,
        question,
      };
    }
    default:
      return null;
  }
}

/** Строгий разбор сообщения iframe; null — игнорировать. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  const m = envelopeType(data);
  if (!m) return null;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'resize':
      return typeof m.height === 'number' &&
        Number.isInteger(m.height) &&
        m.height >= 0 &&
        m.height <= 4000
        ? { type: 'resize', height: m.height }
        : null;
    case 'ui-state':
      return m.state === 'open' || m.state === 'min' || m.state === 'closed'
        ? { type: 'ui-state', state: m.state }
        : null;
    case 'event':
      return m.name === 'open' ||
        m.name === 'close' ||
        m.name === 'lead' ||
        m.name === 'handoff'
        ? { type: 'event', name: m.name }
        : null;
    case 'unavailable':
      return typeof m.code === 'string' && /^[A-Za-z_]{1,40}$/.test(m.code)
        ? { type: 'unavailable', code: m.code }
        : null;
    case 'count':
      return (m.kind === 'link_click' && m.key === null) ||
        ((m.kind === 'scenario_started' || m.kind === 'scenario_done') &&
          typeof m.key === 'string' &&
          ENG_KEY.test(m.key))
        ? { type: 'count', kind: m.kind, key: m.key as string | null }
        : null;
    case 'highlight': {
      const selector = cleanSelector(m.selector);
      const caption = text(m.caption, 80);
      return typeof m.elementId === 'string' &&
        UI_ELEMENT_ID.test(m.elementId) &&
        selector &&
        caption
        ? { type: 'highlight', elementId: m.elementId, selector, caption }
        : null;
    }
    // Э6-бис: команды плана — загрузчик только узнаёт вид и отдаёт сырое
    // сообщение ленивому чанку act.js, который разбирает его СТРОГО
    // (`parseUiCommand`): разбор шагов не утяжеляет загрузчик (12 КБ).
    // (г) `vt-*` — проверка страницы мастера: тем же путём чанку check.js.
    case 'ui-snap':
    case 'ui-run':
    case 'ui-ack':
    case 'ui-stop':
    case 'ui-pause':
    case 'ui-undo':
    case 'vt-env':
    case 'vt-markup':
    case 'vt-mark':
      return { type: 'ui-raw', raw: m };
    case 'handoff-state':
      return m.state === 'waiting' ||
        m.state === 'active' ||
        m.state === 'closed' ||
        m.state === 'missed' ||
        m.state === 'cancelled'
        ? { type: 'handoff-state', state: m.state }
        : null;
    default:
      return null;
  }
}
