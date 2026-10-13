/**
 * AI Publisher — контракт маршрутов ядра P-A1 (проектный документ §11.3
 * «P-A1 — продукт, параметры, роли, гейты, аудит, задачи проверки»),
 * заполненный по `_template.ts`. Тест `core-api.spec.ts` сверяет список с
 * контроллером (`core/product.controller.ts`).
 */
import { route } from './_template';
import type {
  GateName,
  GateResult,
  ListPage,
  MutationBody,
  ParameterDecisionView,
  ParameterView,
  ProductView,
  RevisionedBody,
} from './common';
import type {
  AuditAction,
  DependentStage,
  ObjectType,
  ProposalStatus,
  PubRole,
  ReviewReason,
  ReviewSeverity,
  ReviewStatus,
} from './states';

export interface AuditEventView {
  id: string;
  actor: string;
  objectType: ObjectType;
  objectId: string;
  action: AuditAction;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  meta: unknown;
  occurredAt: string;
}

export interface ReviewTaskView {
  id: string;
  objectType: string;
  objectId: string;
  reason: ReviewReason;
  triggerRef: string;
  severity: ReviewSeverity;
  status: ReviewStatus;
  assigneeMemberId: string | null;
  dueAt: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  revision: number;
}

export interface RoleGrantView {
  id: string;
  memberId: string;
  memberDisplayName: string;
  role: PubRole;
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  reason: string | null;
  active: boolean;
}

/**
 * Предложение изменить параметр (Р-PUB-Z2-6, запрос P-G2 17.4 №1): список
 * `GET …/parameters/:key/proposals` — чтобы участник видел и отзывал своё
 * (`withdraw`), владелец — чужие. `value` — как в `ParameterView.value`.
 */
export interface ParameterProposalView {
  id: string;
  parameterKey: string;
  value: unknown;
  status: ProposalStatus;
  /** `member:<id>` автора. */
  proposedBy: string;
  proposedAt: string;
  decisionId: string | null;
  revision: number;
  /** Автор — текущий участник. */
  mine: boolean;
  /** `open` и (автор или владелец продукта/администратор) — маршрут `withdraw` пропустит. */
  canWithdraw: boolean;
}

export interface CreateProductBody extends MutationBody {
  name: string;
  kind: 'working' | 'test' | 'eval';
}
export interface RenameProductBody extends RevisionedBody {
  name: string;
}
export interface ChangeModeBody extends RevisionedBody {
  mode: 'closed' | 'test' | 'live';
  /** Честное сообщение при закрытии (`live → closed`), без контактов. */
  reason?: string;
}
export interface ProposeBody extends MutationBody {
  value: unknown;
}
export interface DecisionBody extends RevisionedBody {
  /**
   * `assumption` — допущение для режима test (значение предложения или
   * действующее): публичное представление читает допущение в test только
   * при таком решении той же версии (контракт P-A0).
   */
  toStatus: 'approved' | 'rejected' | 'revoked' | 'assumption';
  proposalId?: string | null;
  basis: string;
  dependentStages?: DependentStage[];
}
export interface DecisionResponse {
  decisionId: string | null;
  version: number;
  parameter: ParameterView;
  proposalStatus: 'accepted' | 'rejected' | null;
}
export interface GrantBody extends MutationBody {
  memberId: string;
  role: PubRole;
  /** Снимок имени без контактов; по умолчанию — «Учасник …xxxxxx». */
  displayName?: string;
}
export interface RevokeBody extends MutationBody {
  reason: string;
}
export interface ResolveTaskBody extends RevisionedBody {
  status: 'resolved' | 'dismissed';
  resolution: string;
}
export interface AssignTaskBody extends RevisionedBody {
  assigneeMemberId: string | null;
}

export const CORE_ROUTES = {
  siteProduct: route<void, ProductView>({
    method: 'GET',
    path: '/publisher/sites/:siteId/product',
    action: 'site.product.read',
    mutation: false,
    status: 200,
  }),
  createProduct: route<CreateProductBody, ProductView>({
    method: 'POST',
    path: '/publisher/sites/:siteId/product',
    action: 'product.create',
    mutation: true,
    status: 201,
  }),
  getProduct: route<void, ProductView>({
    method: 'GET',
    path: '/publisher/products/:pid',
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  patchProduct: route<RenameProductBody, ProductView>({
    method: 'PATCH',
    path: '/publisher/products/:pid',
    action: 'product.update',
    mutation: true,
    status: 200,
  }),
  changeMode: route<ChangeModeBody, ProductView>({
    method: 'POST',
    path: '/publisher/products/:pid/mode',
    action: 'product.mode',
    mutation: true,
    status: 200,
  }),
  listParameters: route<void, { items: ParameterView[] }>({
    method: 'GET',
    path: '/publisher/products/:pid/parameters',
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  listDecisions: route<void, ListPage<ParameterDecisionView>>({
    method: 'GET',
    path: '/publisher/products/:pid/parameters/decisions',
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  /** `?status=open|accepted|rejected|withdrawn&before=<id>&limit=` — новые первыми. */
  listProposals: route<void, ListPage<ParameterProposalView>>({
    method: 'GET',
    path: '/publisher/products/:pid/parameters/:key/proposals',
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  propose: route<ProposeBody, { proposalId: string; parameter: ParameterView }>(
    {
      method: 'POST',
      path: '/publisher/products/:pid/parameters/:key/proposals',
      action: 'parameter.propose',
      mutation: true,
      status: 201,
    },
  ),
  withdraw: route<MutationBody, { proposalId: string; status: 'withdrawn' }>({
    method: 'POST',
    path: '/publisher/products/:pid/parameters/:key/proposals/:id/withdraw',
    action: 'parameter.propose',
    mutation: true,
    status: 200,
  }),
  decide: route<DecisionBody, DecisionResponse>({
    method: 'POST',
    path: '/publisher/products/:pid/parameters/:key/decision',
    action: 'parameter.decide',
    mutation: true,
    status: 200,
  }),
  gates: route<void, Record<GateName, GateResult>>({
    method: 'GET',
    path: '/publisher/products/:pid/gates',
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  roles: route<void, { items: RoleGrantView[] }>({
    method: 'GET',
    path: '/publisher/products/:pid/roles',
    action: 'role.manage',
    mutation: false,
    status: 200,
  }),
  grant: route<GrantBody, RoleGrantView>({
    method: 'POST',
    path: '/publisher/products/:pid/roles',
    action: 'role.manage',
    mutation: true,
    status: 201,
  }),
  revoke: route<RevokeBody, RoleGrantView>({
    method: 'POST',
    path: '/publisher/products/:pid/roles/:grantId/revoke',
    action: 'role.manage',
    mutation: true,
    status: 200,
  }),
  audit: route<void, ListPage<AuditEventView>>({
    method: 'GET',
    path: '/publisher/products/:pid/audit',
    action: 'audit.read',
    mutation: false,
    status: 200,
  }),
  reviewTasks: route<void, ListPage<ReviewTaskView>>({
    method: 'GET',
    path: '/publisher/products/:pid/review-tasks',
    action: ['review.manage', 'review.retention'],
    mutation: false,
    status: 200,
  }),
  resolveTask: route<ResolveTaskBody, ReviewTaskView>({
    method: 'POST',
    path: '/publisher/products/:pid/review-tasks/:id/resolve',
    action: ['review.manage', 'review.retention'],
    mutation: true,
    status: 200,
  }),
  assignTask: route<AssignTaskBody, ReviewTaskView>({
    method: 'POST',
    path: '/publisher/products/:pid/review-tasks/:id/assign',
    action: ['review.manage', 'review.retention'],
    mutation: true,
    status: 200,
  }),
  resetRateLimit: route<MutationBody, { removed: number }>({
    method: 'POST',
    path: '/publisher/products/:pid/test/rate-limit/reset',
    action: 'test.rate_limit.reset',
    mutation: true,
    status: 200,
  }),
} as const;
