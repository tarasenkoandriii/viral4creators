/**
 * Атрибуция заявки (§13.5): отдельный модуль — нужен только форме, в чанк
 * трекера (бюджет 2 КБ) не попадает.
 */
import {
  placementFromSearch,
  readSession,
  utmFromSearch,
  type AnalyticsStorage,
  type Attribution,
  type Location,
  type StorageLike,
} from './attribution';

/**
 * Атрибуция заявки: `session` — `sessionRef` и метки (текущей страницы,
 * иначе первого касания); `none` — только метки текущей страницы формы.
 */
export function leadAttribution(mode: AnalyticsStorage, storage: StorageLike | null, loc: Location): Attribution {
  const utm = utmFromSearch(loc.search);
  const placementCode = placementFromSearch(loc.search);
  const out: Attribution = {};
  if (mode === 'session') {
    const s = readSession(storage);
    if (s) {
      out.sessionRef = s.sessionRef;
      const u = utm ?? s.firstTouch.utm;
      if (u) out.utm = u;
      const p = placementCode ?? s.firstTouch.placementCode;
      if (p) out.placementCode = p;
      return out;
    }
  }
  if (utm) out.utm = utm;
  if (placementCode) out.placementCode = placementCode;
  return out;
}
