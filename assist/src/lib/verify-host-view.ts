/**
 * Ш1-хвост: «подтвердить ЭТОТ хост» — запуск TMA из обучалки генератора
 * (`startapp=vh-<base64url(хост)>`, `SITES_VERIFY_URL`). Чистая логика
 * экрана `VerifyHostScreen`: куда вести человека с этим хостом в ТЕКУЩЕМ
 * кабинете. Ничего не подтверждается само — экран только открывает нужное
 * место с хостом, кнопку «Проверить» жмёт человек, решает сервер.
 */

import type { Site, SiteHost } from '../kit';

export type VerifyHostPlan =
  /** Хост уже есть у сайта кабинета — экран подтверждения этого хоста. */
  | { kind: 'open'; siteId: string; hostId: string; verified: boolean }
  /** Хоста нет, сайты есть — добавить к одному из них или новый сайт. */
  | { kind: 'add'; sites: Array<{ id: string; name: string }> }
  /** Сайтов нет — мастер создания сайта с этим хостом. */
  | { kind: 'create' };

const live = (h: SiteHost) => !h.revokedAt;

/**
 * Совпадение — точное (схема https, хост, порт 443), как у ядра: `www.` и
 * поддомены — другие хосты (ТЗ §3.3). Несколько совпадений (хост у
 * нескольких сайтов кабинета) — сначала подтверждённый, иначе первый.
 */
export function verifyHostPlan(sites: Site[], host: string): VerifyHostPlan {
  const hits: Array<{ site: Site; h: SiteHost }> = [];
  for (const site of sites) {
    for (const h of site.hosts) {
      if (h.host === host && h.port === 443 && live(h)) hits.push({ site, h });
    }
  }
  const best = hits.find((x) => x.h.status === 'verified') ?? hits[0];
  if (best) {
    return {
      kind: 'open',
      siteId: best.site.id,
      hostId: best.h.id,
      verified: best.h.status === 'verified',
    };
  }
  if (sites.length === 0) return { kind: 'create' };
  return {
    kind: 'add',
    sites: sites.map((s) => ({ id: s.id, name: s.name })),
  };
}
