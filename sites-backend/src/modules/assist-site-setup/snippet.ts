/**
 * Код вставки и CSP-фрагмент (ТЗ §3-бис.2) — ЧИСТЫЕ функции, владелец W4.
 * Все публичные имена (домен загрузчика, путь, глобал) — только из
 * src/brand.ts: смена бренда (В-1) меняет и инструкцию заказчику.
 *
 * Атрибуты тега (`data-site` и др.) переопределяют для страницы ТОЛЬКО
 * позицию/язык/режим — бренд и права атрибутами не меняются (§3-бис.2).
 */
import { WIDGET_LOADER_PATH } from '../../brand';
import { parsePublicKey } from './keys';
import type { WidgetConfig } from './widget-config';

export interface SnippetOptions {
  publicKey: string;
  /** Origin загрузчика: env ASSIST_WIDGET_ORIGIN или WIDGET_ORIGIN_DEFAULT. */
  widgetOrigin: string;
  config: WidgetConfig;
}

/** Значение атрибута — только безопасные символы (ключ и origin уже проверены). */
function attr(v: string): string {
  return v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function checkedOrigin(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') {
    throw new Error('snippet: origin виджета — только https');
  }
  return u.origin;
}

/**
 * `<script async src="https://w.<домен>/v1/loader.js" data-site="pk_live_…"></script>`
 *
 * Только `data-site`: позиция, режим и прочее приходят из ОПУБЛИКОВАННОЙ
 * конфигурации (кэш 5 мин) — атрибуты в коде вставки заморозили бы их на
 * этой странице, и правка в TMA перестала бы действовать. Атрибуты
 * (`data-position`, `data-mobile`, …) — для владельца, который сознательно
 * хочет иное на отдельной странице (инструкция в TMA).
 */
export function buildEmbedSnippet(o: SnippetOptions): string {
  const pk = parsePublicKey(o.publicKey);
  if (!pk) throw new Error('snippet: неверный публичный ключ');
  const src = `${checkedOrigin(o.widgetOrigin)}${WIDGET_LOADER_PATH}`;
  return `<script async src="${attr(src)}" data-site="${attr(pk.key)}"></script>`;
}

/** Директивы CSP, которые нужны виджету, — в порядке инструкции. */
export const WIDGET_CSP_DIRECTIVES = [
  'script-src',
  'frame-src',
  'img-src',
  'connect-src',
] as const;
export type WidgetCspDirective = (typeof WIDGET_CSP_DIRECTIVES)[number];

/**
 * `script-src …; frame-src …; img-src … data:; connect-src …;` — под
 * текущую настройку. connect-src нужен загрузчику ради конфига вида
 * (fetch `GET /widget/v1/config`, решение координатора Э2 №6: JSONP под
 * Trusted Types невозможен, а iframe до клика не грузим); без него кнопка
 * работает в виде по умолчанию, а проверка установки называет директиву.
 * Владелец ДОБАВЛЯЕТ источник к своим директивам — по строке на директиву.
 */
export function buildCspSnippet(widgetOrigin: string): string {
  const origin = checkedOrigin(widgetOrigin);
  return WIDGET_CSP_DIRECTIVES.map((d) =>
    d === 'img-src' ? `${d} ${origin} data:;` : `${d} ${origin};`,
  ).join('\n');
}
