/**
 * Переменная окружения редактора голосовой карты (Э6-тер, ТЗ §5-кватер.3,
 * В-51) — одно место чтения.
 *
 *  - ASSIST_EDITOR_WIDGET_ORIGIN — origin iframe панели редактора
 *    (`https://we.<домен>`; временно `https://assist-we.viral4creators.app`,
 *    doc/DEPLOYMENT.md §6.22). ОТДЕЛЬНЫЙ от ASSIST_WIDGET_ORIGIN (публичный
 *    чат `w.`) и от ASSIST_ADMIN_WIDGET_ORIGIN (`wa.`): сессия редактора меняет
 *    поведение помощника для всех посетителей — XSS публичного чата не должен
 *    до неё дотянуться. Без переменной — производная от origin виджета
 *    (`w.` → `we.`, `assist-w.` → `assist-we.`); совпадение — ошибка.
 */
import { widgetOrigin } from './widget-env';

function originOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** `https://w.x` → `https://we.x`; `https://assist-w.x` → `https://assist-we.x`. */
export function deriveEditorOrigin(widget: string): string {
  try {
    const u = new URL(widget);
    const labels = u.hostname.split('.');
    if (labels.length > 2 && /(^|-)w$/.test(labels[0])) {
      labels[0] = `${labels[0]}e`;
      u.hostname = labels.join('.');
    }
    return u.origin;
  } catch {
    return widget;
  }
}

export function editorWidgetOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    originOf(env.ASSIST_EDITOR_WIDGET_ORIGIN) ??
    deriveEditorOrigin(widgetOrigin(env))
  );
}

/** Проблемы конфигурации редактора (чек-лист деплоя и тесты). */
export function validateEditorEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  const o = editorWidgetOrigin(env);
  if (o === widgetOrigin(env))
    out.push(
      'ASSIST_EDITOR_WIDGET_ORIGIN совпадает с ASSIST_WIDGET_ORIGIN — панели редактора нужен отдельный origin `we.` (§5-кватер.3, В-51)',
    );
  return out;
}
