import data from './widget-measure.json';
import { INTL_LOCALES, type Locale } from './i18n';

/**
 * Наш лабораторный замер «с виджетом и без» (§3.6 п.4, §9 п.6) — числа
 * пишет `scripts/built/widget-cwv.mjs` (медиана 5 прогонов Lighthouse
 * mobile). Пока замера нет (`null`), блок «Скорость» не показывается:
 * цифры без замера на странице не пишем.
 */
export interface WidgetMeasurement {
  runs: number;
  loaderKb: string;
  chatKb: string;
  dLcpMs: string;
  dTbtMs: string;
  dCls: string;
  dateText: (locale: Locale) => string;
}

export function widgetMeasurement(raw: typeof data = data): WidgetMeasurement | null {
  const r = raw as Record<string, unknown>;
  const nums = ['loaderKb', 'chatKb', 'dLcpMs', 'dTbtMs', 'dCls'] as const;
  if (typeof r.date !== 'string' || nums.some((k) => typeof r[k] !== 'number' || !Number.isFinite(r[k] as number))) return null;
  const n = (k: (typeof nums)[number], digits: number) => {
    const v = r[k] as number;
    const s = v.toFixed(digits);
    return v > 0 ? `+${s}` : s;
  };
  return {
    runs: Number(r.runs),
    loaderKb: (r.loaderKb as number).toFixed(1),
    chatKb: (r.chatKb as number).toFixed(1),
    dLcpMs: n('dLcpMs', 0),
    dTbtMs: n('dTbtMs', 0),
    dCls: n('dCls', 3),
    dateText: (locale) => new Intl.DateTimeFormat(INTL_LOCALES[locale], { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${r.date}T00:00:00Z`)),
  };
}
