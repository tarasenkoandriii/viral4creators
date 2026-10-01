/**
 * `data-*` тега загрузчика (ТЗ §3-бис.2). Проверяются так же, как конфиг:
 * перечисления/числа в диапазоне, иначе атрибут игнорируется. Переопределяют
 * ТОЛЬКО позицию/отступы, язык, мобильный режим, кнопку, z-index, контейнер
 * и «скрыть на страницах» (контракт Э2 §4 W1) — бренд и права атрибутами не
 * меняются: `pk` публичный, иначе любой переписал бы вид чужого виджета.
 * `data-container` — только селектор для `querySelector`, не разметка.
 * `data-preview-token` — конфигуратор TMA (W4, `purpose=tma`).
 */
import { WIDGET_PK_LIVE_PREFIX, WIDGET_PK_TEST_PREFIX } from '../shared/brand';
import {
  LIMITS,
  MOBILE_MODES,
  POSITIONS,
  UI_LANGS,
  Z_INDEX_MAX,
  type MobileMode,
  type Position,
  type UiLang,
} from '../shared/config';
import { isPk } from '../shared/protocol';

export interface TagAttrs {
  pk: string | null;
  position: Position | null;
  offsetX: number | null;
  offsetY: number | null;
  mobile: MobileMode | null;
  launcher: 'default' | 'none' | null;
  container: string | null;
  lang: UiLang | null;
  zIndex: number | null;
  hideOn: string[];
  previewToken: string | null;
}

type Get = (name: string) => string | null;

function num(v: string | null, max: number): number | null {
  if (v === null || !/^\d{1,10}$/.test(v)) return null;
  const n = Number(v);
  return n <= max ? n : null;
}

function pick<T extends string>(
  list: readonly T[],
  v: string | null
): T | null {
  return v !== null && (list as readonly string[]).includes(v)
    ? (v as T)
    : null;
}

export function readAttrs(get: Get): TagAttrs {
  const pk = get('data-site');
  const sel = get('data-container');
  const hide = get('data-hide-on');
  const pt = get('data-preview-token');
  return {
    pk: isPk(pk) ? pk : null,
    position: pick(POSITIONS, get('data-position')),
    offsetX: num(get('data-offset-x'), LIMITS.offsetMax),
    offsetY: num(get('data-offset-y'), LIMITS.offsetMax),
    mobile: pick(MOBILE_MODES, get('data-mobile')),
    launcher: pick(['default', 'none'] as const, get('data-launcher')),
    container: sel && sel.length <= 200 ? sel : null,
    lang: pick(UI_LANGS, get('data-lang')),
    zIndex: num(get('data-z-index'), Z_INDEX_MAX),
    hideOn: hide
      ? hide
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.charAt(0) === '/' && s.length <= LIMITS.pathMask)
          .slice(0, LIMITS.pathMasks)
      : [],
    previewToken: pt && /^[A-Za-z0-9_.~-]{8,256}$/.test(pt) ? pt : null,
  };
}

/** Язык интерфейса: data-lang → lang страницы → язык браузера; иначе en. */
export function uiLang(
  explicit: UiLang | null,
  ...hints: Array<string | null | undefined>
): UiLang {
  if (explicit) return explicit;
  for (const h of hints) {
    const l = (h || '').slice(0, 2).toLowerCase();
    if ((UI_LANGS as readonly string[]).includes(l)) return l as UiLang;
  }
  return 'en';
}

export function isTestKey(pk: string): boolean {
  return (
    pk.indexOf(WIDGET_PK_TEST_PREFIX) === 0 &&
    pk.indexOf(WIDGET_PK_LIVE_PREFIX) !== 0
  );
}

/** pk_test_ работает только на localhost/127.0.0.1 (контракт §1 п.3). */
export function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  );
}
