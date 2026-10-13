/**
 * AI Publisher (P-G1) — зеркало матрицы операций §4.2
 * (`sites-backend/src/modules/publisher/core/roles.ts`). ТОЛЬКО подсказка
 * интерфейса: какие кнопки и вкладки показать. Решает сервер (AT-CORE-11:
 * скрытая кнопка не защита — прямой запрос получит 403 `PUB_ROLE_REQUIRED`).
 * `scripts/publisher-view.test.ts` сверяет таблицу с исходником сервера.
 *
 * Чистый модуль (общий с P-G2).
 */

export const PUB_ROLES = [
  'product_owner',
  'editor',
  'operator',
  'analyst',
  'sales',
  'viewer',
] as const;
export type PubRole = (typeof PUB_ROLES)[number];
export type MatrixRole = PubRole | 'admin';

/** `ProductView.myRoles` (contracts/common.ts `MyRoles`). */
export interface MyRoles {
  roles: PubRole[];
  admin: boolean;
  accountOwner: boolean;
}

const PO = 'product_owner';
const ED = 'editor';
const OP = 'operator';
const AN = 'analyst';
const SA = 'sales';
const VW = 'viewer';
const AD = 'admin';
const ALL: readonly MatrixRole[] = [PO, ED, OP, AN, SA, VW, AD];

interface Permission {
  roles: readonly MatrixRole[];
  accountOwnerOnly?: boolean;
}

export const PUB_PERMISSIONS = {
  'product.read': { roles: ALL },
  'site.product.read': { roles: ALL },
  'product.create': { roles: [AD] },
  'product.update': { roles: [AD] },
  'product.mode': { roles: [AD] },
  'parameter.propose': { roles: [PO, AN, AD] },
  'parameter.decide': { roles: [PO] },
  'role.manage': { roles: [AD] },
  'audit.read': { roles: [PO, AN, AD] },
  'review.manage': { roles: [ED, PO] },
  'review.retention': { roles: [ED, PO, SA] },
  'test.rate_limit.reset': { roles: [AD] },
  'source.manage': { roles: [PO, ED] },
  'question.manage': { roles: [PO, ED] },
  'brand.draft': { roles: [PO, ED] },
  'brand.activate': { roles: [PO] },
  'brief.manage': { roles: [PO, ED] },
  'version.manage': { roles: [PO, ED] },
  'claim.verify': { roles: [PO, ED] },
  'qa.editorial': { roles: [PO, ED] },
  'qa.technical': { roles: [PO, ED, OP] },
  'version.approve': { roles: [PO] },
  'approval.revoke': { roles: [PO, ED] },
  'channel.manage': { roles: [PO, OP] },
  'distribution.manage': { roles: [PO, ED, OP] },
  'publication.manage': { roles: [PO, OP] },
  'venue.manage': { roles: [PO, OP] },
  'placement.propose': { roles: [PO, OP] },
  'placement.approve': { roles: [PO] },
  'budget.operate': { roles: [PO, OP] },
  'placement.claim': { roles: [PO, OP] },
  'budget.reserve_release': { roles: [PO] },
  'lead.read': { roles: [PO, AN, SA] },
  'queue.check': { roles: [PO, SA] },
  'lead.contact.reveal': { roles: [PO, SA] },
  'lead.manage': { roles: [PO, SA] },
  'lead.test_flag': { roles: [PO, AN, SA] },
  'payment.manage': { roles: [PO, SA] },
  'retention.manage': { roles: [PO, SA] },
  'traffic.read': { roles: [PO, AN] },
  'traffic.diagnostics': { roles: [AN, AD] },
  'metrics.import': { roles: [PO, AN, AD] },
  'report.manage': { roles: [PO, AN] },
  'experiment.register': { roles: [PO, AN] },
  'experiment.conclude': { roles: [PO, AN] },
  'time.own': { roles: [PO, ED, OP, AN, SA, AD] },
  'time.others': { roles: [PO] },
  'backup.manage': { roles: [AD] },
  'restore.dry_run': { roles: [AD] },
  'restore.apply': { roles: [], accountOwnerOnly: true },
  'ai.generate': { roles: [PO, ED] },
  'ai.helper': { roles: [PO, ED, OP] },
  'ai.extra': { roles: [PO, ED] },
  'ai.eval.review': { roles: [PO, ED] },
  'ai.bind': { roles: [PO] },
} as const satisfies Record<string, Permission>;

export type PubAction = keyof typeof PUB_PERMISSIONS;

/** Как `can()` сервера: владелец кабинета — всё; `admin` — только «AD»-строки. */
export function canDo(my: MyRoles, action: PubAction): boolean {
  const p: Permission = PUB_PERMISSIONS[action];
  if (p.accountOwnerOnly) return my.accountOwner;
  if (my.accountOwner) return true;
  return p.roles.some((r) => (r === AD ? my.admin : my.roles.includes(r)));
}

export function canAny(my: MyRoles, actions?: readonly PubAction[]): boolean {
  if (!actions || actions.length === 0) return true;
  return actions.some((a) => canDo(my, a));
}

/** Кнопка «Publisher» на экране сайта: владелец кабинета или допуск ≠ none (§14.1). */
export function publisherEntryVisible(me: {
  role: string;
  productRoles: { publisher?: string };
}): boolean {
  return (
    me.role === 'owner' ||
    (me.productRoles.publisher !== undefined &&
      me.productRoles.publisher !== 'none')
  );
}

/** Создать продукт может только `publisher=admin` (или владелец кабинета). */
export function canCreateProduct(me: {
  role: string;
  productRoles: { publisher?: string };
}): boolean {
  return me.role === 'owner' || me.productRoles.publisher === 'admin';
}
