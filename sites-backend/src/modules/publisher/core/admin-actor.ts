/**
 * AI Publisher, P-R-ADM — оператор Админки платформы как актор Publisher
 * (doc/ai-publisher/reddit-manual-mvp-adapted.md §«Админка», Р-RD-ADM-2).
 *
 * Только внутренний путь `/internal/admin/reddit/**` (секрет
 * `SITES_INTERNAL_SECRET`, оператор проверен backend-ом): синтетическое
 * членство «оператор платформы» в ПЛАТФОРМЕННОМ продукте с ролями
 * PO+ED+OP+AN и закрытым списком действий `ADMIN_REDDIT_ACTIONS`
 * (`PubAccess.only` — `can()` отказывает во всём прочем при любых ролях).
 * Кабинетный путь это не меняет: у участников `only` нет.
 *
 * Не входят (и потому недоступны): раскрытие контактов и заявки, роли,
 * бэкапы и восстановление, расходы и переводы бюджета (лимит задают только
 * параметры `budget_*`), закупки, площадки, продукт (создание —
 * отдельный доступ `ADMIN_SETUP_ACTIONS` только маршрута `setup`), режим и
 * профиль продукта, вопросы и брифы статей, проверка утверждений
 * (`claim.verify`), журнал, AI-помощник, eval и привязка AI, труд. Ключи
 * параметров — `ADMIN_PARAMETER_KEYS`; материалы, согласования и публикации —
 * только Reddit (`ADMIN_CONTENT_KINDS`, проверка объекта маршрута);
 * источники — ручные `manual_text|url` и отзыв доказательств Reddit.
 *
 * Чистый модуль.
 */
import type { AccountMembership } from '../../site-core/account/roles';
import { NO_PRODUCT_ROLES } from '../../site-core/account/roles';
import { adminActor } from '../contracts/common';
import {
  BUDGET_LIMIT_PARAMETER_KEYS,
  GATE_PARAMETER_KEYS,
  type ParameterKey,
} from '../contracts/parameters';
import type { PubRole } from '../contracts/states';
import { accessOf, type PubAccess, type PubAction } from './roles';

/** Роли синтетического членства (Р-RD-ADM-2). */
export const ADMIN_REDDIT_ROLES: readonly PubRole[] = [
  'product_owner',
  'editor',
  'operator',
  'analyst',
];

/**
 * Закрытый список действий оператора Админки: раздел Reddit, нужные студии
 * действия контента (для Reddit-материалов — сужает маршрут), генерация
 * `pub.reddit.draft`, параметры гейта (ключи — `ADMIN_PARAMETER_KEYS`).
 */
export const ADMIN_REDDIT_ACTIONS: readonly PubAction[] = [
  'reddit.read',
  'reddit.manage',
  'reddit.rules.review',
  'reddit.handoff',
  'product.read',
  'version.manage',
  'qa.editorial',
  'qa.technical',
  'version.approve',
  'ai.generate',
  'parameter.propose',
  'parameter.decide',
  // v1.2 (Р-RD-ADM-9…12): маршруты `cx/*` сужают объект — источник контента
  // (создать ручной, отозвать доказательство Reddit), оффер и факты бренда
  // платформенного продукта, отзыв согласования Reddit-материала, снятие
  // отметки о публикации Reddit-материала.
  'source.manage',
  'brand.draft',
  'brand.activate',
  'approval.revoke',
  'publication.manage',
];

/** Маршрут `setup`: только создание платформенного продукта. */
export const ADMIN_SETUP_ACTIONS: readonly PubAction[] = ['product.create'];

/**
 * Ключи, которыми Админка ведёт платформенный продукт:
 *  - гейт `reddit_publish` и параметры P-R (Р-RD-ADM-5);
 *  - v1.4 (Р-RD-ADM-14, решение владельца «полная работа из Админки»):
 *    гейт `ai_use` (`ai_budget_usd_month`, `ai_fx_rate`,
 *    `ai_unpriced_allowed`) и бюджетные ключи, без которых задание
 *    `ai-month-open` не открывает месяц AI (`budget_total`, `budget_split` —
 *    гейт `spend`; `per_purchase_max` — сборка `pub_budget_limits`).
 * Прочие ключи (сайт, лиды, закупки, отчёты) — 404 без подробностей.
 */
export const ADMIN_PARAMETER_KEYS: readonly ParameterKey[] = [
  ...new Set<ParameterKey>([
    ...GATE_PARAMETER_KEYS.reddit_publish,
    'reddit_rules_stale_days',
    'reddit_excerpt_retention_days',
    ...GATE_PARAMETER_KEYS.ai_use,
    'ai_unpriced_allowed',
    ...BUDGET_LIMIT_PARAMETER_KEYS,
  ]),
];

/** Виды материалов, которые видит студия Админки. */
export const ADMIN_CONTENT_KINDS = ['reddit_post', 'reddit_comment'] as const;

/** Генераторы, которые может вызвать оператор Админки. */
export const ADMIN_GENERATORS = ['pub.reddit.draft'] as const;

export function isAdminParameterKey(key: string): key is ParameterKey {
  return (ADMIN_PARAMETER_KEYS as readonly string[]).includes(key);
}

/** Синтетический `memberId` оператора (`admin:<userId>`, ≤ 64). */
export const adminMemberId = (userId: string): string => adminActor(userId);

/** Права оператора Админки в платформенном продукте. */
export function adminRedditAccess(
  userId: string,
  actions: readonly PubAction[] = ADMIN_REDDIT_ACTIONS,
): PubAccess {
  return {
    ...accessOf({
      memberId: adminMemberId(userId),
      grants: ADMIN_REDDIT_ROLES,
      admin: false,
      accountOwner: false,
    }),
    only: new Set(actions),
  };
}

/**
 * Синтетическое членство (кабинет платформенного сайта): не владелец, без
 * ролей продуктов — права задаёт только `adminRedditAccess`.
 */
export function adminMembership(
  accountId: string,
  userId: string,
): AccountMembership {
  return {
    accountId,
    memberId: adminMemberId(userId),
    telegramId: 0n,
    role: 'operator',
    productRoles: { ...NO_PRODUCT_ROLES },
  };
}
