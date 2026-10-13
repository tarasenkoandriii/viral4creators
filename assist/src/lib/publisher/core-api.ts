/**
 * AI Publisher (P-G1) — API ядра P-A1 (§11.3 «продукт, параметры, роли,
 * гейты, аудит, задачи проверки»; контракт `contracts/core-api.ts`,
 * `common.ts`). Декодеры строгие (`decode.ts`).
 */

import type { PublisherHttp } from './common-api';
import { seg } from './common-api';
import {
  arr,
  bool,
  int,
  iso,
  isoOrNull,
  itemsOf,
  listPage,
  obj,
  oneOf,
  str,
  strOrNull,
  type ListPage,
} from './decode';
import { PUB_ROLES, type MyRoles, type PubRole } from './permissions';
import {
  DEPENDENT_STAGES,
  GATE_MISSING_KINDS,
  GATE_NAMES,
  PARAMETER_STATUSES,
  PRODUCT_KINDS,
  PRODUCT_MODES,
  PRODUCT_STATUSES,
  PROPOSAL_STATUSES,
  REVIEW_REASONS,
  REVIEW_SEVERITIES,
  REVIEW_STATUSES,
  type DependentStage,
  type GateMissingKind,
  type GateName,
  type ParameterStatus,
  type ProductKind,
  type ProductMode,
  type ProductStatus,
  type ProposalStatus,
  type ReviewReason,
  type ReviewStatus,
} from './states';

export interface GateMissing {
  kind: GateMissingKind;
  key: string;
  detail: string;
}
export interface GateResult {
  gate: GateName;
  open: boolean;
  missing: GateMissing[];
}
export interface ProductView {
  id: string;
  siteId: string;
  kind: ProductKind;
  name: string;
  publicKey: string;
  mode: ProductMode;
  liveSince: string | null;
  status: ProductStatus;
  revision: number;
  createdAt: string;
  myRoles: MyRoles;
  gates: Record<GateName, { open: boolean; missingCount: number }>;
  /** Разделы вне P0 (P-R): `reddit` — env-флаг сервера; выключен — раздела нет. */
  features: { reddit: boolean };
}
export interface ParameterView {
  key: string;
  value: unknown;
  status: ParameterStatus;
  version: number;
  approvedAt: string | null;
  approvedBy: string | null;
  revision: number;
  updatedAt: string;
  openProposals: number;
  gates: GateName[];
}
/** `GET …/parameters/:key/proposals` (Р-PUB-Z2-6). */
export interface ParameterProposalView {
  id: string;
  parameterKey: string;
  value: unknown;
  status: ProposalStatus;
  proposedBy: string;
  proposedAt: string;
  decisionId: string | null;
  revision: number;
  /** Автор — текущий участник. */
  mine: boolean;
  /** Сервер пропустит отзыв (автор или владелец продукта/админ, `open`). */
  canWithdraw: boolean;
}
export interface ParameterDecisionView {
  id: string;
  parameterKey: string;
  version: number;
  proposalId: string | null;
  fromStatus: ParameterStatus;
  toStatus: ParameterStatus;
  valueSnapshot: unknown;
  decidedBy: string;
  decidedAt: string;
  basis: string;
  dependentStages: DependentStage[];
}
export interface AuditEventView {
  id: string;
  actor: string;
  objectType: string;
  objectId: string;
  action: string;
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
  severity: (typeof REVIEW_SEVERITIES)[number];
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

// ── Декодеры ─────────────────────────────────────────────────────────────

export function decodeMyRoles(v: unknown): MyRoles {
  const o = obj(v, 'myRoles');
  return {
    roles: arr(o.roles, (x) => oneOf(x, PUB_ROLES, 'myRoles.roles')),
    admin: bool(o.admin, 'myRoles.admin'),
    accountOwner: bool(o.accountOwner, 'myRoles.accountOwner'),
  };
}

export function decodeProduct(v: unknown): ProductView {
  const o = obj(v, 'product');
  const g = obj(o.gates, 'product.gates');
  const gates = {} as ProductView['gates'];
  for (const name of GATE_NAMES) {
    const x = obj(g[name], `product.gates.${name}`);
    gates[name] = {
      open: bool(x.open, 'gate.open'),
      missingCount: int(x.missingCount, 'gate.missingCount'),
    };
  }
  return {
    id: str(o.id, 'product.id'),
    siteId: str(o.siteId, 'product.siteId'),
    kind: oneOf(o.kind, PRODUCT_KINDS, 'product.kind'),
    name: str(o.name, 'product.name'),
    publicKey: str(o.publicKey, 'product.publicKey'),
    mode: oneOf(o.mode, PRODUCT_MODES, 'product.mode'),
    liveSince: isoOrNull(o.liveSince, 'product.liveSince'),
    status: oneOf(o.status, PRODUCT_STATUSES, 'product.status'),
    revision: int(o.revision, 'product.revision'),
    createdAt: iso(o.createdAt, 'product.createdAt'),
    myRoles: decodeMyRoles(o.myRoles),
    gates,
    features: {
      reddit: bool(
        obj(o.features, 'product.features').reddit,
        'features.reddit'
      ),
    },
  };
}

export function decodeGateMissing(v: unknown): GateMissing {
  const o = obj(v, 'missing');
  return {
    kind: oneOf(o.kind, GATE_MISSING_KINDS, 'missing.kind'),
    key: str(o.key, 'missing.key'),
    detail: str(o.detail, 'missing.detail'),
  };
}

export function decodeGates(v: unknown): Record<GateName, GateResult> {
  const o = obj(v, 'gates');
  const out = {} as Record<GateName, GateResult>;
  for (const name of GATE_NAMES) {
    const x = obj(o[name], `gates.${name}`);
    out[name] = {
      gate: oneOf(x.gate, GATE_NAMES, 'gates.gate'),
      open: bool(x.open, 'gates.open'),
      missing: arr(x.missing, decodeGateMissing, 'gates.missing'),
    };
  }
  return out;
}

export function decodeParameter(v: unknown): ParameterView {
  const o = obj(v, 'parameter');
  return {
    key: str(o.key, 'parameter.key'),
    value: o.value,
    status: oneOf(o.status, PARAMETER_STATUSES, 'parameter.status'),
    version: int(o.version, 'parameter.version'),
    approvedAt: isoOrNull(o.approvedAt),
    approvedBy: strOrNull(o.approvedBy),
    revision: int(o.revision, 'parameter.revision'),
    updatedAt: iso(o.updatedAt, 'parameter.updatedAt'),
    openProposals: int(o.openProposals, 'parameter.openProposals'),
    gates: arr(o.gates, (x) => oneOf(x, GATE_NAMES, 'parameter.gates')),
  };
}

export function decodeProposal(v: unknown): ParameterProposalView {
  const o = obj(v, 'proposal');
  return {
    id: str(o.id, 'proposal.id'),
    parameterKey: str(o.parameterKey, 'proposal.parameterKey'),
    value: o.value,
    status: oneOf(o.status, PROPOSAL_STATUSES, 'proposal.status'),
    proposedBy: str(o.proposedBy, 'proposal.proposedBy'),
    proposedAt: iso(o.proposedAt, 'proposal.proposedAt'),
    decisionId: strOrNull(o.decisionId),
    revision: int(o.revision, 'proposal.revision'),
    mine: bool(o.mine, 'proposal.mine'),
    canWithdraw: bool(o.canWithdraw, 'proposal.canWithdraw'),
  };
}

export function decodeDecision(v: unknown): ParameterDecisionView {
  const o = obj(v, 'decision');
  return {
    id: str(o.id),
    parameterKey: str(o.parameterKey),
    version: int(o.version),
    proposalId: strOrNull(o.proposalId),
    fromStatus: oneOf(o.fromStatus, PARAMETER_STATUSES, 'decision.from'),
    toStatus: oneOf(o.toStatus, PARAMETER_STATUSES, 'decision.to'),
    valueSnapshot: o.valueSnapshot,
    decidedBy: str(o.decidedBy),
    decidedAt: iso(o.decidedAt),
    basis: str(o.basis),
    dependentStages: arr(o.dependentStages, (x) =>
      oneOf(x, DEPENDENT_STAGES, 'decision.stage')
    ),
  };
}

export function decodeAudit(v: unknown): AuditEventView {
  const o = obj(v, 'audit');
  return {
    id: str(o.id),
    actor: str(o.actor),
    objectType: str(o.objectType),
    objectId: str(o.objectId),
    action: str(o.action),
    fromStatus: strOrNull(o.fromStatus),
    toStatus: strOrNull(o.toStatus),
    reason: strOrNull(o.reason),
    meta: o.meta ?? null,
    occurredAt: iso(o.occurredAt),
  };
}

export function decodeReviewTask(v: unknown): ReviewTaskView {
  const o = obj(v, 'reviewTask');
  return {
    id: str(o.id),
    objectType: str(o.objectType),
    objectId: str(o.objectId),
    reason: oneOf(o.reason, REVIEW_REASONS, 'reviewTask.reason'),
    triggerRef: str(o.triggerRef),
    severity: oneOf(o.severity, REVIEW_SEVERITIES, 'reviewTask.severity'),
    status: oneOf(o.status, REVIEW_STATUSES, 'reviewTask.status'),
    assigneeMemberId: strOrNull(o.assigneeMemberId),
    dueAt: isoOrNull(o.dueAt),
    resolution: strOrNull(o.resolution),
    resolvedBy: strOrNull(o.resolvedBy),
    resolvedAt: isoOrNull(o.resolvedAt),
    createdAt: iso(o.createdAt),
    revision: int(o.revision),
  };
}

export function decodeGrant(v: unknown): RoleGrantView {
  const o = obj(v, 'grant');
  return {
    id: str(o.id),
    memberId: str(o.memberId),
    memberDisplayName: str(o.memberDisplayName),
    role: oneOf(o.role, PUB_ROLES, 'grant.role'),
    grantedBy: str(o.grantedBy),
    grantedAt: iso(o.grantedAt),
    revokedBy: strOrNull(o.revokedBy),
    revokedAt: isoOrNull(o.revokedAt),
    reason: strOrNull(o.reason),
    active: bool(o.active),
  };
}

// ── Клиент ───────────────────────────────────────────────────────────────

export function createCoreApi(http: PublisherHttp) {
  const P = (pid: string) => `products/${seg(pid)}`;
  return {
    siteProduct: async (siteId: string) =>
      decodeProduct(await http.get(`sites/${seg(siteId)}/product`)),
    createProduct: async (
      siteId: string,
      body: { name: string; kind: 'working' | 'test' | 'eval' },
      opKey?: string
    ) =>
      decodeProduct(
        await http.send('POST', `sites/${seg(siteId)}/product`, body, opKey)
      ),
    product: async (pid: string) => decodeProduct(await http.get(P(pid))),
    rename: async (
      pid: string,
      body: { name: string; expectedRevision: number },
      opKey?: string
    ) => decodeProduct(await http.send('PATCH', P(pid), body, opKey)),
    changeMode: async (
      pid: string,
      body: {
        mode: ProductMode;
        expectedRevision: number;
        reason?: string;
      },
      opKey?: string
    ) => decodeProduct(await http.send('POST', `${P(pid)}/mode`, body, opKey)),
    parameters: async (pid: string) =>
      itemsOf(await http.get(`${P(pid)}/parameters`), decodeParameter),
    decisions: async (
      pid: string,
      q: { key?: string; before?: string; limit?: number } = {}
    ): Promise<ListPage<ParameterDecisionView>> =>
      listPage(
        await http.get(`${P(pid)}/parameters/decisions`, q),
        decodeDecision
      ),
    proposals: async (
      pid: string,
      key: string,
      q: { status?: ProposalStatus; before?: string; limit?: number } = {}
    ): Promise<ListPage<ParameterProposalView>> =>
      listPage(
        await http.get(`${P(pid)}/parameters/${seg(key)}/proposals`, q),
        decodeProposal
      ),
    propose: async (
      pid: string,
      key: string,
      value: unknown,
      opKey?: string
    ) => {
      const o = obj(
        await http.send(
          'POST',
          `${P(pid)}/parameters/${seg(key)}/proposals`,
          { value },
          opKey
        )
      );
      return {
        proposalId: str(o.proposalId),
        parameter: decodeParameter(o.parameter),
      };
    },
    withdraw: async (pid: string, key: string, id: string, opKey?: string) =>
      obj(
        await http.send(
          'POST',
          `${P(pid)}/parameters/${seg(key)}/proposals/${seg(id)}/withdraw`,
          {},
          opKey
        )
      ),
    decide: async (
      pid: string,
      key: string,
      body: {
        toStatus: 'approved' | 'rejected' | 'revoked' | 'assumption';
        proposalId?: string | null;
        basis: string;
        dependentStages?: DependentStage[];
        expectedRevision: number;
      },
      opKey?: string
    ) => {
      const o = obj(
        await http.send(
          'POST',
          `${P(pid)}/parameters/${seg(key)}/decision`,
          body,
          opKey
        )
      );
      return {
        decisionId: strOrNull(o.decisionId),
        version: int(o.version),
        parameter: decodeParameter(o.parameter),
        proposalStatus:
          o.proposalStatus === null || o.proposalStatus === undefined
            ? null
            : oneOf(o.proposalStatus, ['accepted', 'rejected'] as const),
      };
    },
    gates: async (pid: string) =>
      decodeGates(await http.get(`${P(pid)}/gates`)),
    roles: async (pid: string) =>
      itemsOf(await http.get(`${P(pid)}/roles`), decodeGrant),
    grant: async (
      pid: string,
      body: { memberId: string; role: PubRole; displayName?: string },
      opKey?: string
    ) => decodeGrant(await http.send('POST', `${P(pid)}/roles`, body, opKey)),
    revoke: async (
      pid: string,
      grantId: string,
      reason: string,
      opKey?: string
    ) =>
      decodeGrant(
        await http.send(
          'POST',
          `${P(pid)}/roles/${seg(grantId)}/revoke`,
          { reason },
          opKey
        )
      ),
    audit: async (
      pid: string,
      q: {
        objectType?: string;
        objectId?: string;
        before?: string;
        limit?: number;
      } = {}
    ): Promise<ListPage<AuditEventView>> =>
      listPage(await http.get(`${P(pid)}/audit`, q), decodeAudit),
    reviewTasks: async (
      pid: string,
      q: {
        status?: string;
        assignee?: string;
        reason?: string;
        before?: string;
        limit?: number;
      } = {}
    ): Promise<ListPage<ReviewTaskView>> =>
      listPage(await http.get(`${P(pid)}/review-tasks`, q), decodeReviewTask),
    resolveTask: async (
      pid: string,
      id: string,
      body: {
        status: 'resolved' | 'dismissed';
        resolution: string;
        expectedRevision: number;
      },
      opKey?: string
    ) =>
      decodeReviewTask(
        await http.send(
          'POST',
          `${P(pid)}/review-tasks/${seg(id)}/resolve`,
          body,
          opKey
        )
      ),
    assignTask: async (
      pid: string,
      id: string,
      body: { assigneeMemberId: string | null; expectedRevision: number },
      opKey?: string
    ) =>
      decodeReviewTask(
        await http.send(
          'POST',
          `${P(pid)}/review-tasks/${seg(id)}/assign`,
          body,
          opKey
        )
      ),
    resetRateLimit: async (pid: string, opKey?: string) => {
      const o = obj(
        await http.send('POST', `${P(pid)}/test/rate-limit/reset`, {}, opKey)
      );
      return { removed: int(o.removed) };
    },
  };
}
export type CoreApi = ReturnType<typeof createCoreApi>;
