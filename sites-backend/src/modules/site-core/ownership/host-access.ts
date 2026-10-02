/**
 * `assertHostVerified(hostId, purpose)` — ОДНА функция ядра, через которую
 * оба продукта спрашивают «подтверждён ли хост» (QA-ТЗ §1.5, ТЗ помощника
 * §3.3). Продукты не ослабляют и не расширяют факт подтверждения — они
 * надстраивают свои ворота СВЕРХУ (L2/L3 QA: свежая перепроверка, роль,
 * ToS — в модулях QA, не здесь).
 *
 * Уровни:
 *  - L0 (`assist-sandbox`) — подтверждение не нужно; ядро проверяет только
 *    отказ домена (opt-out). SSRF — на каждом запросе обхода.
 *  - L1 (всё остальное) — `verified` у ЭТОГО кабинета и не истёк.
 *
 * Льгота 72 ч — свойство ТОЛЬКО `purpose = 'assist-widget'` (согласовано
 * 01.10, QA §1.5): статус в ядре уже `revoked`/`expired`, и для обхода,
 * «Админки», коннекторов и ЛЮБОГО `qa-*` хост не подтверждён сразу.
 * Крон о льготе не знает — она вычисляется здесь из `revokedAt`/`expiresAt`.
 *
 * Льготы нет, если подтверждение отозвал ДРУГОЙ кабинет, доказавший
 * контроль над хостом (блокировка повторного подтверждения, QA §5.1):
 * случайно удалённая запись — повод для 72 ч, выдворение чужака — нет.
 */

import { WIDGET_GRACE_MS } from '../site-core.constants';

export type AssistPurpose =
  'assist-sandbox' | 'assist-widget' | 'assist-crawl' | 'assist-admin';
/** QA определяет свои назначения сам; для ядра любое `qa-*` — L1 без льготы. */
export type QaPurpose = `qa-${string}`;
/**
 * Обучалка по сайту заказчика генератора (Э-С Ш1): `tutorial` — режим A
 * «свой сайт» (П-Т1), `tutorial-*` — следующие шаги (Ш2: `tutorial-login`,
 * аренда учётки). L1 без льготы: льгота 72 ч — только у виджета, а чужой
 * браузер по сайту с отозванным подтверждением — уже режим B.
 */
export type TutorialPurpose = 'tutorial' | `tutorial-${string}`;
export type HostPurpose = AssistPurpose | QaPurpose | TutorialPurpose;

export interface HostAccessRow {
  id: string;
  accountId: string;
  host: string;
  status: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  reverifyBlockedAt: Date | null;
}

export type HostAccessDecision =
  | { ok: true; level: 'L0' | 'L1'; grace: false }
  | { ok: true; level: 'L1'; grace: true; graceUntil: Date }
  | { ok: false; reason: 'not_verified' | 'expired' | 'revoked' };

function isKnownPurpose(p: string): p is HostPurpose {
  return (
    p === 'assist-sandbox' ||
    p === 'assist-widget' ||
    p === 'assist-crawl' ||
    p === 'assist-admin' ||
    /^qa-[a-z0-9-]+$/.test(p) ||
    /^tutorial(-[a-z0-9-]+)?$/.test(p)
  );
}

/**
 * Чистое решение по строке хоста. `opted out` проверяет вызывающий (это
 * запрос в базу).
 */
export function evaluateHostAccess(
  host: HostAccessRow,
  purpose: HostPurpose,
  now: Date,
): HostAccessDecision {
  if (!isKnownPurpose(purpose)) {
    // Опечатка в назначении не должна тихо попасть в «самый мягкий» класс.
    throw new Error(`assertHostVerified: неизвестное назначение «${purpose}»`);
  }
  if (purpose === 'assist-sandbox') {
    return { ok: true, level: 'L0', grace: false };
  }
  // Блокировка повторного подтверждения (отзыв другим кабинетом, QA §5.1)
  // сильнее статуса: строка `verified` с блокировкой — след гонки «отзыв
  // пришёл, пока шла наша проверка» или ручной правки, и пускать по ней
  // выдворенный кабинет нельзя ни для одного назначения L1.
  if (host.reverifyBlockedAt) {
    return { ok: false, reason: 'revoked' };
  }

  // `verified` с наступившим expiresAt — уже expired, даже если крон ещё
  // не дошёл: истёкшее подтверждение не должно жить до утра.
  let effective = host.status;
  let lapsedAt: Date | null = null;
  if (effective === 'verified') {
    if (!host.expiresAt) return { ok: false, reason: 'not_verified' };
    if (host.expiresAt.getTime() > now.getTime()) {
      return { ok: true, level: 'L1', grace: false };
    }
    effective = 'expired';
  }
  if (effective === 'expired') lapsedAt = host.expiresAt;
  else if (effective === 'revoked') lapsedAt = host.revokedAt;
  else return { ok: false, reason: 'not_verified' };

  const reason = effective === 'expired' ? 'expired' : 'revoked';
  if (purpose !== 'assist-widget' || !lapsedAt || host.reverifyBlockedAt) {
    return { ok: false, reason };
  }
  const graceUntil = new Date(lapsedAt.getTime() + WIDGET_GRACE_MS);
  if (now.getTime() < graceUntil.getTime()) {
    return { ok: true, level: 'L1', grace: true, graceUntil };
  }
  return { ok: false, reason };
}
