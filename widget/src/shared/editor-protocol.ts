/**
 * Протокол пикер (origin заказчика, `editor.js`) ↔ панель (iframe `we.`,
 * `editor-panel.js`) редактора голосовой карты — Э6-тер, ТЗ §5-кватер.3
 * «Протокол пикер ↔ панель». Правила §4.12: точный origin, `event.source`,
 * строгая схема, без `'*'`.
 *
 * Окно пикера делит любой скрипт страницы: всё, что панель получает «от
 * пикера», — НЕДОВЕРЕННЫЕ данные (поддельный `pick` возможен — владелец
 * увидит в карточке не тот элемент, а сохранить без клика в панели нельзя).
 * Ни одно сообщение пикера не меняет карту само.
 *
 * Дескриптор — форма `VoiceMapDescriptor` сервера
 * (`sites-backend/src/modules/assist-ui-core/voice-map.ts`); сервер
 * разбирает его строго заново. Значений полей, HTML и скриншотов нет.
 */
import { EDITOR_MESSAGE_NS } from './brand';
import { isJwt } from './jwt';
import {
  selectorOk,
  type Snapshot,
  type UiGesture,
  type UiRole,
} from './ui-plan';

export const EDITOR_PROTOCOL_VERSION = 1;

export type EditorMode = 'select' | 'nav';
export type Stability = 'strong' | 'medium' | 'fragile';
export type Coverage = 'green' | 'yellow' | 'red' | 'violet';

export interface Descriptor {
  tag: 'a' | 'button' | 'input' | 'select' | 'textarea' | 'other';
  role: UiRole | null;
  text: string;
  hiddenLabel: string | null;
  assistId: string | null;
  testId: string | null;
  elId: string | null;
  hrefPath: string | null;
  hrefHost: string | null;
  offHost: boolean;
  heading: string | null;
  landmark: string | null;
  formName: string | null;
  inputType: string | null;
  submit: boolean;
  inForm: boolean;
  pd: boolean;
  toggle: boolean;
  gesture: UiGesture | null;
  neverAttr: boolean;
  confirmZone: boolean;
  clickableDiv: boolean;
  editable: boolean;
  closedShadow: boolean;
  unique: boolean;
  css: string | null;
}

/**
 * Маска ПД в пути ссылки — порт `maskPagePath` сервера
 * (`assist-ui-core/snapshot.ts`, аудит Э6-тер (3)): e-mail → `:email`,
 * ключ → `:token`, телефон с `+` → `:phone`, 9+ цифр → `:n`; изменённый
 * сегмент — в percent-кодировке (`:` как есть). Сверка с сервером —
 * `scripts/editor.test.ts`.
 */
export function maskHrefPath(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      let d = seg;
      try {
        d = decodeURIComponent(seg);
      } catch {
        d = seg;
      }
      const m = d
        .replace(/[^\s/@]+@[^\s/@]+\.[A-Za-z]{2,}/g, ':email')
        .replace(/\b(sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,})\b/g, ':token')
        .replace(/\+\d(?:[\s().-]?\d){6,}/g, ':phone')
        .replace(/\d(?:[\s-]?\d){8,}/g, ':n');
      return m === d ? seg : encodeURIComponent(m).replace(/%3A/gi, ':');
    })
    .join('/');
}

const POLITE = ['будь', 'ласка', 'пожалуйста', 'please'];

/**
 * Норма фразы — порт `phraseNorm` сервера (`assist-ui-core/memo.ts`:
 * регистр, ё/е, апострофы, пунктуация, пробелы, вежливость; сверка —
 * scripts/editor.test.ts). Заход 11 (аудит P2-3): панель сравнивает фразы
 * так же, как сервер считает конфликт фраз карты.
 */
export function phraseNorm(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’ʼ`´']/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && POLITE.indexOf(w) < 0)
    .join(' ');
}

/** Цель карты для покрытия и разрешения на странице. */
export interface PageTarget {
  key: string;
  descriptor: Descriptor;
  color: Coverage;
}

export type ToPanel =
  | { type: 'ready'; path: string; title: string; lang: string }
  | {
      type: 'pick';
      descriptor: Descriptor;
      crumbs: string[];
      how: string;
      stability: Stability;
      /** Похоже на «никогда» по видимому тексту/разметке (подсказка, решает сервер). */
      never: boolean;
      /**
       * (Э6-тер (д)) Поле для слота мемо: атрибут `name` и подписи вариантов
       * списка — НЕ значение поля (его в протоколе нет вовсе).
       */
      fieldName?: string | null;
      options?: string[];
      /** Метка настоящего клика (случайная): только по ней — `perform`. */
      pid?: string | null;
      /** (заход 9) `Shift`+клик — добавить к массовому выбору. */
      multi?: boolean;
      /**
       * (раунд исправлений заход 11, «Админка») элемент в строке таблицы /
       * пункте списка: подпись и номера сняты (ПД клиента) — предупреждение.
       */
      row?: boolean;
    }
  /** (заход 9) Выбор рамкой (`Shift` + протянуть): элементы внутри рамки. */
  | { type: 'picks'; items: Descriptor[] }
  /** (заход 9) `/` на странице — поиск цели в панели. */
  | { type: 'search' }
  | { type: 'snapshot'; id: number; snapshot: Snapshot }
  | {
      type: 'resolved';
      id: number;
      items: Array<{ key: string; found: number }>;
    }
  | { type: 'route'; path: string }
  | {
      type: 'counts';
      green: number;
      yellow: number;
      red: number;
      violet: number;
    }
  | { type: 'mode'; mode: EditorMode }
  /**
   * (заход 11, №117) Панель карты «Админки» (`wa.`): employee-JWT от чанка
   * `admin.js` в ответ на `need-identity` (null — сотрудник не вошёл).
   */
  | { type: 'identity'; jwt: string | null }
  /** (раунд исправлений) Сотрудник вышел из админки — редактор завершается. */
  | { type: 'logout' };

export type ToPicker =
  | { type: 'targets'; items: PageTarget[] }
  | { type: 'coverage'; on: boolean }
  | { type: 'mode'; mode: EditorMode }
  | { type: 'highlight'; items: Array<{ ref: string; label: string }> }
  | { type: 'focus'; key: string }
  /**
   * `rows` (заход 11, «Админка»): номера строк таблиц, названные в команде
   * «Сказать сейчас» — только эти строки остаются в снимке (Р-Э6б-6).
   */
  | {
      type: 'snapshot-req';
      id: number;
      rows?: string[];
      /** «Админка»: зоны владельца, как у боевого снимка (`admin-act.js`). */
      deny?: string[];
      allow?: string[];
    }
  | {
      type: 'resolve';
      id: number;
      items: Array<{ key: string; descriptor: Descriptor }>;
    }
  | { type: 'size'; open: boolean }
  /**
   * (Э6-тер (д)) Запись мемо: сервер счёл шаг «сразу» (переход, раскрытие,
   * «в корзину») — пикер исполняет нажатие по-настоящему, но ТОЛЬКО на
   * элементе, выбранном настоящим кликом человека (`isTrusted`) последним.
   */
  | { type: 'perform'; pid: string }
  /**
   * (заход 11, №113) Тепловые значки режима «Промахи»: на элементе цели
   * карты — подпись за 7 дней (просили / натисніть самі / не туди / не
   * знайдено); `bad` — есть промахи (красный). Пустой список — снять.
   * Подпись — только `textContent` (≤ 40), цель — по ключу из `targets`.
   */
  | { type: 'heat'; items: HeatItem[] }
  /** (заход 11, №117) Панель «Админки» просит employee-JWT (обмен на сессию `wa.`). */
  | { type: 'need-identity' }
  | { type: 'exit' };

export interface HeatItem {
  key: string;
  label: string;
  bad: boolean;
}

export function editorEnvelope<T extends { type: string }>(
  m: T
): T & { ns: string; v: number } {
  return { ...m, ns: EDITOR_MESSAGE_NS, v: EDITOR_PROTOCOL_VERSION };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length <= max ? v : null;

const TAGS = ['a', 'button', 'input', 'select', 'textarea', 'other'];
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** Строгий разбор дескриптора (панель получает его от пикера — недоверенно). */
export function parseDescriptor(v: unknown): Descriptor | null {
  if (!isObj(v)) return null;
  const tag =
    TAGS.indexOf(v.tag as string) >= 0 ? (v.tag as Descriptor['tag']) : null;
  if (!tag) return null;
  const tok = (x: unknown) =>
    typeof x === 'string' && TOKEN.test(x) ? x : null;
  const b = (x: unknown) => x === true;
  const text = str(v.text, 81) ?? '';
  return {
    tag,
    role: (str(v.role, 20) as UiRole | null) ?? null,
    text,
    hiddenLabel: str(v.hiddenLabel, 81),
    assistId: tok(v.assistId),
    testId: tok(v.testId),
    elId: tok(v.elId),
    hrefPath: str(v.hrefPath, 300),
    hrefHost: str(v.hrefHost, 260),
    offHost: b(v.offHost),
    heading: str(v.heading, 81),
    landmark: str(v.landmark, 20),
    formName: tok(v.formName),
    inputType: str(v.inputType, 20),
    submit: b(v.submit),
    inForm: b(v.inForm),
    pd: b(v.pd),
    toggle: b(v.toggle),
    gesture: (str(v.gesture, 10) as UiGesture | null) ?? null,
    neverAttr: b(v.neverAttr),
    confirmZone: b(v.confirmZone),
    clickableDiv: b(v.clickableDiv),
    editable: b(v.editable),
    closedShadow: b(v.closedShadow),
    unique: b(v.unique),
    css: str(v.css, 200),
  };
}

/** Селекторы зон владельца: строки ≤ 200 без `<`/управляющих, ≤ 30. */
const selectors = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .slice(0, 30)
        .filter(
          (x): x is string =>
            typeof x === 'string' && !!x.trim() && selectorOk(x)
        )
    : [];

/** Сообщение панели → пикер (пикер проверяет source/origin ДО разбора). */
export function parseToPicker(raw: unknown): ToPicker | null {
  if (!isObj(raw) || raw.ns !== EDITOR_MESSAGE_NS) return null;
  switch (raw.type) {
    case 'exit':
    case 'need-identity':
      return { type: raw.type };
    case 'perform':
      return typeof raw.pid === 'string' && raw.pid.length <= 16
        ? { type: 'perform', pid: raw.pid }
        : null;
    case 'coverage':
      return { type: 'coverage', on: raw.on === true };
    case 'size':
      return { type: 'size', open: raw.open === true };
    case 'mode':
      return raw.mode === 'nav' || raw.mode === 'select'
        ? { type: 'mode', mode: raw.mode }
        : null;
    case 'snapshot-req':
      return typeof raw.id === 'number'
        ? {
            type: 'snapshot-req',
            id: raw.id,
            rows: Array.isArray(raw.rows)
              ? raw.rows
                  .filter(
                    (r): r is string =>
                      typeof r === 'string' && /^[0-9]{3,12}$/.test(r)
                  )
                  .slice(0, 5)
              : [],
            deny: selectors(raw.deny),
            allow: selectors(raw.allow),
          }
        : null;
    case 'heat':
      return Array.isArray(raw.items)
        ? {
            type: 'heat',
            items: raw.items
              .slice(0, 200)
              .filter(isObj)
              .map((i) => ({
                key: str(i.key, 40) ?? '',
                label: str(i.label, 40) ?? '',
                bad: i.bad === true,
              }))
              .filter((i) => i.key && i.label),
          }
        : null;
    case 'focus':
      return typeof raw.key === 'string'
        ? { type: 'focus', key: raw.key.slice(0, 40) }
        : null;
    case 'highlight': {
      if (!Array.isArray(raw.items)) return null;
      const items = raw.items
        .slice(0, 20)
        .filter(isObj)
        .map((i) => ({
          ref: str(i.ref, 8) ?? '',
          label: str(i.label, 120) ?? '',
        }))
        .filter((i) => /^e[1-9]\d{0,2}$/.test(i.ref));
      return { type: 'highlight', items };
    }
    case 'targets':
    case 'resolve': {
      if (!Array.isArray(raw.items)) return null;
      const items: PageTarget[] = [];
      for (const i of raw.items.slice(0, 500)) {
        if (!isObj(i) || typeof i.key !== 'string') continue;
        const d = parseDescriptor(i.descriptor);
        if (!d) continue;
        const color =
          i.color === 'green' ||
          i.color === 'yellow' ||
          i.color === 'red' ||
          i.color === 'violet'
            ? i.color
            : 'yellow';
        items.push({ key: i.key.slice(0, 40), descriptor: d, color });
      }
      return raw.type === 'targets'
        ? { type: 'targets', items }
        : typeof raw.id === 'number'
          ? { type: 'resolve', id: raw.id, items }
          : null;
    }
    default:
      return null;
  }
}

/** Сообщение пикера → панель (панель проверяет source/origin ДО разбора). */
export function parseToPanel(raw: unknown): ToPanel | null {
  if (!isObj(raw) || raw.ns !== EDITOR_MESSAGE_NS) return null;
  switch (raw.type) {
    case 'ready':
      return {
        type: 'ready',
        path: str(raw.path, 300) ?? '/',
        title: str(raw.title, 200) ?? '',
        lang: str(raw.lang, 5) ?? 'uk',
      };
    case 'route':
      return { type: 'route', path: str(raw.path, 300) ?? '/' };
    case 'search':
    case 'logout':
      return { type: raw.type };
    case 'identity':
      return raw.jwt === null || isJwt(raw.jwt)
        ? { type: 'identity', jwt: raw.jwt }
        : null;
    case 'picks':
      return Array.isArray(raw.items)
        ? {
            type: 'picks',
            items: raw.items
              .slice(0, 40)
              .map(parseDescriptor)
              .filter((d): d is Descriptor => !!d),
          }
        : null;
    case 'mode':
      return raw.mode === 'nav' || raw.mode === 'select'
        ? { type: 'mode', mode: raw.mode }
        : null;
    case 'pick': {
      const d = parseDescriptor(raw.descriptor);
      if (!d) return null;
      const st = raw.stability;
      return {
        type: 'pick',
        descriptor: d,
        crumbs: Array.isArray(raw.crumbs)
          ? raw.crumbs.slice(0, 8).map((c) => str(c, 60) ?? '')
          : [],
        how: str(raw.how, 20) ?? 'text',
        stability: st === 'strong' || st === 'medium' ? st : 'fragile',
        never: raw.never === true,
        fieldName: str(raw.fieldName, 64),
        pid: str(raw.pid, 16),
        multi: raw.multi === true,
        row: raw.row === true,
        options: Array.isArray(raw.options)
          ? raw.options
              .slice(0, 40)
              .map((o) => str(o, 81))
              .filter((o): o is string => !!o)
          : [],
      };
    }
    case 'snapshot':
      return typeof raw.id === 'number' && isObj(raw.snapshot)
        ? {
            type: 'snapshot',
            id: raw.id,
            snapshot: raw.snapshot as unknown as Snapshot,
          }
        : null;
    case 'resolved': {
      if (typeof raw.id !== 'number' || !Array.isArray(raw.items)) return null;
      return {
        type: 'resolved',
        id: raw.id,
        items: raw.items
          .slice(0, 500)
          .filter(isObj)
          .map((i) => ({
            key: str(i.key, 40) ?? '',
            found:
              typeof i.found === 'number'
                ? Math.max(0, Math.min(99, i.found | 0))
                : 0,
          })),
      };
    }
    case 'counts': {
      const n = (x: unknown) =>
        typeof x === 'number' ? Math.max(0, x | 0) : 0;
      return {
        type: 'counts',
        green: n(raw.green),
        yellow: n(raw.yellow),
        red: n(raw.red),
        violet: n(raw.violet),
      };
    }
    default:
      return null;
  }
}

// ── устойчивость (порт `descriptorStability` сервера; сверка — scripts/editor.test.ts) ──

/** Похоже на сгенерированный id/класс (порт `isGeneratedToken` Ш4). */
export function isGeneratedToken(v: string): boolean {
  return (
    /^:r[0-9a-z]*:$/i.test(v) ||
    /^(css|sc|jsx|emotion|ember|mui|chakra|svelte|tw)-/i.test(v) ||
    /\d{4,}/.test(v) ||
    (/[0-9a-f]{8,}/i.test(v) && /\d/.test(v)) ||
    v.length > 40
  );
}

/** Цена, число, дата в подписи (порт `volatileText` Ш4). */
export function volatileText(t: string): boolean {
  return /\d[\d\s.,]*\s*(₴|грн|uah|\$|€|руб|₽|zł|%)|\d{2,}/i.test(t);
}

export function stabilityOf(d: Descriptor): Stability {
  if (d.assistId) return 'strong';
  if (!d.unique) return 'fragile';
  if (d.testId) return 'strong';
  if (d.elId && !isGeneratedToken(d.elId)) return 'strong';
  if (d.role && d.text) return volatileText(d.text) ? 'fragile' : 'medium';
  if (d.hrefPath && d.tag === 'a') return 'medium';
  return 'fragile';
}

/**
 * Панель `we.` для origin виджета: `w.` → `we.`, `assist-w.` → `assist-we.`
 * (порт `deriveEditorOrigin` сервера); стенды разработки (localhost) —
 * `127.0.0.2` (другой origin на том же порту).
 */
export function panelOrigin(widgetOrigin: string): string {
  try {
    const u = new URL(widgetOrigin);
    if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.2';
      return u.origin;
    }
    const labels = u.hostname.split('.');
    if (labels.length > 2 && /(^|-)w$/.test(labels[0])) {
      labels[0] = `${labels[0]}e`;
      u.hostname = labels.join('.');
    }
    return u.origin;
  } catch {
    return widgetOrigin;
  }
}
