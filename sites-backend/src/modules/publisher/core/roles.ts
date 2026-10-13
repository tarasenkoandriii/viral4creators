/**
 * AI Publisher — матрица операций (P-A1, проектный документ §4.2; ТЗ §5):
 * источник правды для `@PubAllow('<действие>')` маршрутов и `PubRoleGuard`.
 *
 *  - роль продукта — активный грант `pub_role_grants` (без кэша, §4.1);
 *  - `admin` — `productRoles.publisher = 'admin'` (администратор ТЗ);
 *  - владелец кабинета неявно имеет ВСЕ роли продукта и `admin` — включая
 *    `sales` (видит контакты, Р-PUB-2); `restore.apply` — только он;
 *  - «(с)» матрицы — `selfReview`: разрешено, но при совпадении с автором
 *    объекта сервис пишет `selfReview=true` (ТЗ §5 «явная отметка
 *    самоаудита»).
 *
 * Юнит-тест сверяет матрицу с декораторами всех маршрутов `/publisher/*`
 * (`route-enumerator.ts`): маршрут без действия в матрице роняет тест.
 *
 * Чистый модуль.
 */
import type { MyRoles } from '../contracts/common';
import { PUB_ROLES, type ProductKind, type PubRole } from '../contracts/states';

export type MatrixRole = PubRole | 'admin';

export interface PubPermission {
  roles: readonly MatrixRole[];
  /** Роли, у которых действие помечается `selfReview` при авторстве. */
  selfReview?: readonly PubRole[];
  /** Только владелец кабинета (не `admin`, не роли). */
  accountOwnerOnly?: boolean;
  /** Действие уровня сайта (продукта ещё может не быть). */
  siteLevel?: boolean;
  /**
   * Виды продукта, где действие запрещено ВСЕМ, включая владельца кабинета
   * с неявными ролями (Р-PUB-Z2-2: раскрытие контактов в `restored` — до
   * решения владельца).
   */
  deniedKinds?: readonly ProductKind[];
}

const PO = 'product_owner';
const ED = 'editor';
const OP = 'operator';
const AN = 'analyst';
const SA = 'sales';
const VW = 'viewer';
const AD = 'admin';
const ALL: readonly MatrixRole[] = [PO, ED, OP, AN, SA, VW, AD];

/** Действия матрицы §4.2 (и чтения маршрутов §11.3). */
export const PUB_PERMISSIONS = {
  // Продукт (P-A1)
  'product.read': { roles: ALL },
  'site.product.read': { roles: ALL, siteLevel: true },
  'product.create': { roles: [AD], siteLevel: true },
  'product.update': { roles: [AD] },
  'product.mode': { roles: [AD] },
  'parameter.propose': { roles: [PO, AN, AD] },
  'parameter.decide': { roles: [PO] },
  'role.manage': { roles: [AD] },
  'audit.read': { roles: [PO, AN, AD] },
  'review.manage': { roles: [ED, PO] },
  /** Задачи `retention_review` — ещё и продажи (§11.3). */
  'review.retention': { roles: [ED, PO, SA] },
  'test.rate_limit.reset': { roles: [AD] },
  // Контент (P-B1)
  'source.manage': { roles: [PO, ED] },
  'question.manage': { roles: [PO, ED] },
  'brand.draft': { roles: [PO, ED] },
  'brand.activate': { roles: [PO] },
  'brief.manage': { roles: [PO, ED] },
  'version.manage': { roles: [PO, ED] },
  'claim.verify': { roles: [PO, ED], selfReview: [PO, ED] },
  'qa.editorial': { roles: [PO, ED], selfReview: [PO, ED] },
  'qa.technical': { roles: [PO, ED, OP], selfReview: [PO, ED] },
  'version.approve': { roles: [PO], selfReview: [PO] },
  'approval.revoke': { roles: [PO, ED] },
  // Распространение, площадки, закупки (P-C)
  'channel.manage': { roles: [PO, OP] },
  'distribution.manage': { roles: [PO, ED, OP] },
  'publication.manage': { roles: [PO, OP] },
  'venue.manage': { roles: [PO, OP] },
  'placement.propose': { roles: [PO, OP] },
  'placement.approve': { roles: [PO], selfReview: [PO] },
  'budget.operate': { roles: [PO, OP] },
  'placement.claim': { roles: [PO, OP] },
  'budget.reserve_release': { roles: [PO] },
  // Заявки (P-D)
  'lead.read': { roles: [PO, AN, SA] },
  'queue.check': { roles: [PO, SA] },
  'lead.contact.reveal': { roles: [PO, SA], deniedKinds: ['restored'] },
  'lead.manage': { roles: [PO, SA] },
  'lead.test_flag': { roles: [PO, AN, SA] },
  'payment.manage': { roles: [PO, SA] },
  'retention.manage': { roles: [PO, SA] },
  'traffic.read': { roles: [PO, AN] },
  'traffic.diagnostics': { roles: [AN, AD] },
  // Отчёты, эксперименты, труд, интеграции, бэкап (P-E)
  'metrics.import': { roles: [PO, AN, AD] },
  'report.manage': { roles: [PO, AN] },
  'experiment.register': { roles: [PO, AN] },
  'experiment.conclude': { roles: [PO, AN] },
  'time.own': { roles: [PO, ED, OP, AN, SA, AD] },
  'time.others': { roles: [PO] },
  'backup.manage': { roles: [AD] },
  'restore.dry_run': { roles: [AD] },
  'restore.apply': { roles: [], accountOwnerOnly: true },
  // AI (P-B2)
  'ai.generate': { roles: [PO, ED] },
  'ai.helper': { roles: [PO, ED, OP] },
  'ai.extra': { roles: [PO, ED] },
  'ai.eval.review': { roles: [PO, ED] },
  'ai.bind': { roles: [PO] },
  // Reddit Manual MVP, пакет P-R (reddit-manual-mvp-adapted.md §5, Р-RD-11):
  // без новой роли; SA доступа не имеет; review правил своего снимка не
  // запрещён — помечается `selfReview`; `reddit.handoff` — копирование и
  // отчёт о ручной публикации (M2), как `publication.manage`.
  'reddit.read': { roles: [PO, ED, OP, AN, VW, AD] },
  'reddit.manage': { roles: [PO, ED] },
  'reddit.rules.review': { roles: [PO, ED], selfReview: [PO, ED] },
  'reddit.handoff': { roles: [PO, OP] },
} as const satisfies Record<string, PubPermission>;

export type PubAction = keyof typeof PUB_PERMISSIONS;
export const PUB_ACTIONS = Object.keys(PUB_PERMISSIONS) as PubAction[];

export function isPubAction(v: unknown): v is PubAction {
  return (
    typeof v === 'string' &&
    Object.prototype.hasOwnProperty.call(PUB_PERMISSIONS, v)
  );
}

/** Права участника в продукте на текущий запрос (вычисляет `PubRoleGuard`). */
export interface PubAccess {
  memberId: string;
  /** Роли из активных грантов (у владельца — все). */
  roles: ReadonlySet<PubRole>;
  admin: boolean;
  accountOwner: boolean;
}

export function accessOf(input: {
  memberId: string;
  grants: readonly PubRole[];
  admin: boolean;
  accountOwner: boolean;
}): PubAccess {
  return {
    memberId: input.memberId,
    roles: new Set(input.accountOwner ? PUB_ROLES : input.grants),
    admin: input.admin || input.accountOwner,
    accountOwner: input.accountOwner,
  };
}

/**
 * Запрещено ли действие в продукте этого вида для всех (Р-PUB-Z2-2).
 * Проверяют `PubRoleGuard` и `PubOperations` (вторая линия).
 */
export function deniedForKind(
  action: PubAction,
  kind: ProductKind | null | undefined,
): boolean {
  const p: PubPermission = PUB_PERMISSIONS[action];
  return !!kind && !!p.deniedKinds?.includes(kind);
}

/** Разрешено ли действие (матрица §4.2). */
export function can(access: PubAccess, action: PubAction): boolean {
  const p: PubPermission = PUB_PERMISSIONS[action];
  if (p.accountOwnerOnly) return access.accountOwner;
  if (access.accountOwner) return true;
  return p.roles.some((r) => (r === AD ? access.admin : access.roles.has(r)));
}

/**
 * Нужна ли пометка самоаудита: действие из «(с)» и участник — автор
 * проверяемого объекта (владелец кабинета — тоже, ТЗ §5).
 */
export function isSelfReview(
  access: PubAccess,
  action: PubAction,
  authorMemberId: string | null | undefined,
): boolean {
  const p: PubPermission = PUB_PERMISSIONS[action];
  if (!p.selfReview || !authorMemberId) return false;
  return authorMemberId === access.memberId;
}

export function myRolesOf(access: PubAccess): MyRoles {
  return {
    roles: PUB_ROLES.filter((r) => access.roles.has(r)),
    admin: access.admin,
    accountOwner: access.accountOwner,
  };
}

/** Все действия, разрешённые участнику (экран кита: видимость кнопок). */
export function allowedActions(access: PubAccess): PubAction[] {
  return PUB_ACTIONS.filter((a) => can(access, a));
}
