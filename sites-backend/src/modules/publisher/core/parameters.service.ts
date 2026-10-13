/**
 * AI Publisher — параметры продукта (P-A1, проектный документ §6.2, §10,
 * §11.3; Р-PUB-0 п.4; аудит P2-9).
 *
 *  - новый продукт сеется 38 ключами со статусом `assumption` (ТЗ §26/§17);
 *  - предложение (`pub_parameter_proposals`) НЕ меняет действующее
 *    значение и не закрывает гейты: аналитик, предложивший новый
 *    `form_limit`, не останавливает приём заявок;
 *  - решение владельца (`approved|rejected|revoked`, основание ≥ 10
 *    символов без контактов) — версия +1. ПОРЯДОК ЗАПИСИ (Р-PUB-A0-2):
 *    сначала строка `pub_parameter_decisions` той же версии/статуса/
 *    значения, потом UPDATE `pub_parameters` (AFTER-триггер ищет решение),
 *    затем `refreshGateFlags`; для бюджетных ключей — `BudgetLimitPort.
 *    applyParameters` (P-C) в той же транзакции;
 *  - отклонение ПРЕДЛОЖЕНИЯ (`rejected` с `proposalId`) — решение по
 *    предложению, а не по параметру: действующее значение и гейты не
 *    меняются (Р-PUB-A1-8); `rejected` без предложения — владелец
 *    отклоняет само значение, гейт закрывается;
 *  - решение `toStatus='assumption'` (контракт P-A0, раунд 2): допущение
 *    для режима test — `pub_public_products` читает допущение в test только
 *    при решении `assumption` той же версии (`test_hosts`, `form_limit`…);
 *    посев v1 без решения на тестовом сайте не действует;
 *  - СЕРИАЛИЗАЦИЯ (аудит P1-1): `propose`/`withdraw`/`decide` первым делом
 *    берут `lockProduct` (строка продукта FOR NO KEY UPDATE) — флаги
 *    гейтов в строке продукта ≡ `evaluateGate` и под параллельными
 *    решениями;
 *  - согласованность бюджетных ключей — НЕ условие решения (аудит P2-1:
 *    сумму 10 000 → 12 000 меняют два решения), а пункт гейтов `spend`/
 *    `purchases` (`budgetConsistencyIssues`).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  ParameterDecisionView,
  ParameterView,
  ListPage,
} from '../contracts/common';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  MEMBER_ACTOR_RE,
} from '../contracts/common';
import {
  BUDGET_LIMIT_PARAMETER_KEYS,
  DEFAULT_PARAMETER_VALUES,
  PARAMETER_KEYS,
  defaultDependentStages,
  gatesOfKey,
  isParameterKey,
  type ParameterKey,
} from '../contracts/parameters';
import {
  DEPENDENT_STAGES,
  isOneOf,
  type DependentStage,
  type ParameterStatus,
  type ProposalStatus,
} from '../contracts/states';
import type { ParameterProposalView } from '../contracts/core-api';
import { AuditService } from './audit';
import { canonicalJson } from './content-hash';
import {
  isLaunchEvidenceKey,
  launchEvidenceCheck,
  qaRunIdOf,
} from './launch-evidence';
import { PubError, assertNoIssues, validationError } from './errors';
import {
  parameterApprovalIssues,
  parameterValueIssues,
} from './parameter-schemas';
import { piiIssues } from './pii-guard';
import {
  PubPorts,
  type ParameterCurrent,
  type ParameterPort,
  type ProductRef,
  type PubTx,
} from './ports';
import { lockProduct, refreshGateFlags } from './refresh-gate-flags';
import {
  PARAMETER_MACHINE,
  PROPOSAL_MACHINE,
  assertTransition,
  type Actor,
} from './state-machines';

const BASIS_MIN = 10;
const BASIS_MAX = 2000;

export type DecisionToStatus =
  'approved' | 'rejected' | 'revoked' | 'assumption';
export const DECISION_TO_STATUSES: readonly DecisionToStatus[] = [
  'approved',
  'rejected',
  'revoked',
  'assumption',
];

export interface DecisionInput {
  key: ParameterKey;
  toStatus: DecisionToStatus;
  /** Значение по предложению; иначе — `value` (порт) или действующее. */
  proposalId?: string | null;
  value?: unknown;
  basis: string;
  decidedBy: string;
  dependentStages?: DependentStage[];
  /** Ревизия параметра, которую видел клиент (маршрут); порт — без неё. */
  expectedRevision?: number;
  /**
   * Роли решающего участника для машины (`actorsOf(access)`): ОБЯЗАТЕЛЬНЫ
   * и в маршруте, и в порту — умолчания «владелец продукта» нет (аудит
   * P3-5).
   */
  actors: Actor[];
  now?: Date;
}

export interface DecisionResult {
  /** null — отклонено только предложение (параметр не изменился). */
  decisionId: string | null;
  version: number;
  parameter: ParameterView;
  proposalStatus: string | null;
}

type ParamRow = {
  id: string;
  key: string;
  value: unknown;
  status: string;
  version: number;
  approvedAt: Date | null;
  approvedBy: string | null;
  revision: number;
  updatedAt: Date;
};

function view(r: ParamRow, openProposals: number): ParameterView {
  return {
    key: r.key,
    value: r.value,
    status: r.status as ParameterStatus,
    version: r.version,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvedBy: r.approvedBy,
    revision: r.revision,
    updatedAt: r.updatedAt.toISOString(),
    openProposals,
    gates: isParameterKey(r.key) ? gatesOfKey(r.key) : [],
  };
}

const sameJson = (a: unknown, b: unknown) =>
  canonicalJson(a ?? null) === canonicalJson(b ?? null);

export function checkBasis(basis: unknown, field = 'basis'): string {
  if (typeof basis !== 'string')
    throw validationError([{ field, code: 'required' }]);
  const t = basis.trim();
  if (t.length < BASIS_MIN || [...basis].length > BASIS_MAX) {
    throw validationError([{ field, code: 'length' }]);
  }
  assertNoIssues(piiIssues({ [field]: basis }));
  return basis;
}

@Injectable()
export class ParametersService implements ParameterPort {
  constructor(
    private readonly audit: AuditService,
    private readonly ports: PubPorts,
  ) {}

  /** 38 ключей-допущений нового продукта (без решений: статус assumption). */
  async seed(tx: PubTx, product: ProductRef, actor: string): Promise<void> {
    await tx.pubParameter.createMany({
      data: PARAMETER_KEYS.map((key) => ({
        accountId: product.accountId,
        productId: product.id,
        key,
        value: DEFAULT_PARAMETER_VALUES[key] as Prisma.InputJsonValue,
        status: 'assumption',
        version: 1,
        createdBy: actor,
      })),
    });
  }

  private async row(
    tx: PubTx,
    productId: string,
    key: string,
  ): Promise<ParamRow> {
    if (!isParameterKey(key)) throw new PubError('PUB_NOT_FOUND');
    const r = await tx.pubParameter.findFirst({ where: { productId, key } });
    if (!r) throw new PubError('PUB_NOT_FOUND');
    return r;
  }

  private async openCount(
    tx: PubTx,
    productId: string,
    key?: string,
  ): Promise<Map<string, number>> {
    const rows = await tx.pubParameterProposal.groupBy({
      by: ['parameterKey'],
      where: {
        productId,
        status: 'open',
        ...(key ? { parameterKey: key } : {}),
      },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.parameterKey, r._count._all]));
  }

  async list(db: PubTx, productId: string): Promise<ParameterView[]> {
    const rows = await db.pubParameter.findMany({
      where: { productId },
      orderBy: { key: 'asc' },
    });
    const open = await this.openCount(db, productId);
    const order = new Map(PARAMETER_KEYS.map((k, i) => [k as string, i]));
    return rows
      .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99))
      .map((r) => view(r, open.get(r.key) ?? 0));
  }

  async viewOf(
    tx: PubTx,
    productId: string,
    key: string,
  ): Promise<ParameterView> {
    const r = await this.row(tx, productId, key);
    return view(r, (await this.openCount(tx, productId, key)).get(key) ?? 0);
  }

  async current(
    tx: PubTx,
    product: ProductRef,
    key: ParameterKey,
  ): Promise<ParameterCurrent> {
    const r = await this.row(tx, product.id, key);
    return {
      key,
      value: r.value,
      status: r.status as ParameterStatus,
      version: r.version,
    };
  }

  /** Предложение: значение проверяется по форме ключа; действующее не меняется. */
  async propose(
    tx: PubTx,
    product: ProductRef,
    key: string,
    value: unknown,
    actor: string,
  ): Promise<{ proposalId: string; parameter: ParameterView }> {
    await lockProduct(tx, product);
    await this.row(tx, product.id, key);
    assertNoIssues(parameterValueIssues(key as ParameterKey, value));
    const p = await tx.pubParameterProposal.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        parameterKey: key,
        value: value as Prisma.InputJsonValue,
        proposedBy: actor,
        createdBy: actor,
      },
    });
    await this.audit.write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor,
      objectType: 'parameter_proposal',
      objectId: p.id,
      action: 'create',
      toStatus: 'open',
      meta: { parameterKey: key },
    });
    await refreshGateFlags(tx, product.id);
    return {
      proposalId: p.id,
      parameter: await this.viewOf(tx, product.id, key),
    };
  }

  /** Отзыв предложения: автор или владелец продукта/администратор. */
  async withdraw(
    tx: PubTx,
    product: ProductRef,
    key: string,
    proposalId: string,
    actor: string,
    mayWithdrawOthers: boolean,
  ): Promise<{ proposalId: string; status: 'withdrawn' }> {
    await lockProduct(tx, product);
    const p = await tx.pubParameterProposal.findFirst({
      where: { id: proposalId, productId: product.id, parameterKey: key },
    });
    if (!p) throw new PubError('PUB_NOT_FOUND');
    if (p.proposedBy !== actor && !mayWithdrawOthers) {
      throw new PubError('PUB_ROLE_REQUIRED', { action: 'parameter.propose' });
    }
    assertTransition(PROPOSAL_MACHINE, p.status as 'open', 'withdrawn');
    const n = await tx.pubParameterProposal.updateMany({
      where: { id: p.id, status: 'open' },
      data: { status: 'withdrawn', revision: { increment: 1 } },
    });
    if (n.count !== 1)
      throw new PubError('PUB_CONFLICT', { currentRevision: p.revision + 1 });
    await this.audit.write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor,
      objectType: 'parameter_proposal',
      objectId: p.id,
      action: 'transition',
      fromStatus: 'open',
      toStatus: 'withdrawn',
      meta: { parameterKey: key },
    });
    await refreshGateFlags(tx, product.id);
    return { proposalId: p.id, status: 'withdrawn' };
  }

  /** Решение владельца (маршрут) или другого пакета (порт). */
  async decide(
    tx: PubTx,
    product: ProductRef,
    input: Omit<DecisionInput, 'key'> & { key: ParameterKey },
  ): Promise<DecisionResult> {
    if (!MEMBER_ACTOR_RE.test(input.decidedBy)) {
      throw new Error('parameters.decide: решает человек (member:<id>)');
    }
    if (!Array.isArray(input.actors) || input.actors.length === 0) {
      throw new Error(
        'parameters.decide: роли решающего (actors) обязательны — умолчания нет',
      );
    }
    if (!DECISION_TO_STATUSES.includes(input.toStatus)) {
      throw validationError([{ field: 'toStatus', code: 'enum' }]);
    }
    const now = input.now ?? new Date();
    const basis = checkBasis(input.basis);
    const stages = input.dependentStages ?? defaultDependentStages(input.key);
    if (
      !Array.isArray(stages) ||
      !stages.every((s) => isOneOf(DEPENDENT_STAGES, s))
    ) {
      throw validationError([{ field: 'dependentStages', code: 'enum' }]);
    }
    // Аудит P1-1: до чтения параметров — блокировка строки продукта.
    await lockProduct(tx, product);
    const param = await this.row(tx, product.id, input.key);
    if (
      input.expectedRevision !== undefined &&
      param.revision !== input.expectedRevision
    ) {
      throw new PubError('PUB_CONFLICT', { currentRevision: param.revision });
    }
    const proposal = input.proposalId
      ? await tx.pubParameterProposal.findFirst({
          where: { id: input.proposalId, productId: product.id },
        })
      : null;
    if (
      input.proposalId &&
      (!proposal || proposal.parameterKey !== input.key)
    ) {
      throw new PubError('PUB_NOT_FOUND');
    }
    if (proposal) {
      assertTransition(
        PROPOSAL_MACHINE,
        proposal.status as 'open',
        input.toStatus === 'rejected' ? 'rejected' : 'accepted',
      );
    }
    const actors = input.actors;

    // Отклонить ПРЕДЛОЖЕНИЕ: параметр и гейты не меняются (Р-PUB-A1-8).
    if (proposal && input.toStatus === 'rejected') {
      await tx.pubParameterProposal.updateMany({
        where: { id: proposal.id, status: 'open' },
        data: { status: 'rejected', revision: { increment: 1 } },
      });
      await this.audit.write(tx, {
        accountId: product.accountId,
        productId: product.id,
        actor: input.decidedBy,
        objectType: 'parameter_proposal',
        objectId: proposal.id,
        action: 'reject',
        fromStatus: 'open',
        toStatus: 'rejected',
        reason: basis,
        meta: { parameterKey: input.key },
      });
      await refreshGateFlags(tx, product.id);
      return {
        decisionId: null,
        version: param.version,
        parameter: await this.viewOf(tx, product.id, input.key),
        proposalStatus: 'rejected',
      };
    }
    if (proposal && input.toStatus === 'revoked') {
      throw validationError([{ field: 'proposalId', code: 'not_allowed' }]);
    }

    const from = param.status as ParameterStatus;
    assertTransition(PARAMETER_MACHINE, from, input.toStatus, { actors });
    const value =
      proposal !== null
        ? proposal.value
        : input.value !== undefined
          ? input.value
          : param.value;
    if (
      from === 'approved' &&
      input.toStatus === 'approved' &&
      sameJson(value, param.value)
    ) {
      // Повторное утверждение того же значения — не решение.
      throw validationError([{ field: 'proposalId', code: 'required' }]);
    }
    if (
      from === 'assumption' &&
      input.toStatus === 'assumption' &&
      sameJson(value, param.value) &&
      (await tx.pubParameterDecision.count({
        where: {
          productId: product.id,
          parameterKey: input.key,
          version: param.version,
          toStatus: 'assumption',
        },
      })) > 0
    ) {
      // Допущение для test уже действует с тем же значением.
      throw validationError([{ field: 'proposalId', code: 'required' }]);
    }
    assertNoIssues(parameterValueIssues(input.key, value));
    if (input.toStatus === 'approved') {
      assertNoIssues(parameterApprovalIssues(input.key, value));
      // Р-PUB-Z2-27: доказательство приёмки — сохранённый прогон qa-catalog
      // с обязательным списком шлюза в статусе passed, не свободная строка.
      if (isLaunchEvidenceKey(input.key)) {
        const runId = qaRunIdOf(value);
        const run = runId
          ? await this.ports.qaRuns().runEvidence(product.accountId, runId)
          : null;
        const check = launchEvidenceCheck(input.key, run);
        if (!check.ok)
          throw new PubError('PUB_CONFLICT', {
            reason: check.reason,
            key: input.key,
            qaRunId: runId,
            required: check.required,
            missing: check.missing,
          });
      }
    }

    const version = param.version + 1;
    // СНАЧАЛА решение той же версии/статуса/значения, потом параметр.
    const decision = await tx.pubParameterDecision.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        parameterKey: input.key,
        version,
        proposalId: proposal?.id ?? null,
        fromStatus: from,
        toStatus: input.toStatus,
        valueSnapshot: value as Prisma.InputJsonValue,
        decidedBy: input.decidedBy,
        decidedAt: now,
        basis,
        dependentStages: stages,
        createdBy: input.decidedBy,
      },
    });
    const approved = input.toStatus === 'approved';
    const upd = await tx.pubParameter.updateMany({
      where: { id: param.id, revision: param.revision },
      data: {
        value: value as Prisma.InputJsonValue,
        status: input.toStatus,
        version,
        approvedAt: approved ? now : null,
        approvedBy: approved ? input.decidedBy : null,
        revision: { increment: 1 },
      },
    });
    if (upd.count !== 1) {
      const cur = await tx.pubParameter.findFirst({
        where: { id: param.id },
        select: { revision: true },
      });
      throw new PubError('PUB_CONFLICT', {
        currentRevision: cur?.revision ?? param.revision,
      });
    }
    if (proposal) {
      const n = await tx.pubParameterProposal.updateMany({
        where: { id: proposal.id, status: 'open' },
        data: {
          status: 'accepted',
          decisionId: decision.id,
          revision: { increment: 1 },
        },
      });
      if (n.count !== 1)
        throw new PubError('PUB_CONFLICT', {
          currentRevision: proposal.revision + 1,
        });
    }
    await this.audit.write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor: input.decidedBy,
      objectType: 'parameter',
      objectId: param.id,
      action: approved
        ? 'approve'
        : input.toStatus === 'revoked'
          ? 'revoke'
          : input.toStatus === 'assumption'
            ? 'transition'
            : 'reject',
      fromStatus: from,
      toStatus: input.toStatus,
      reason: basis,
      meta: {
        parameterKey: input.key,
        version,
        decisionId: decision.id,
        proposalId: proposal?.id ?? null,
        dependentStages: stages,
      },
    });
    await refreshGateFlags(tx, product.id);
    if (
      (BUDGET_LIMIT_PARAMETER_KEYS as readonly string[]).includes(input.key)
    ) {
      await this.ports.budgetLimit().applyParameters(tx, product);
    }
    return {
      decisionId: decision.id,
      version,
      parameter: await this.viewOf(tx, product.id, input.key),
      proposalStatus: proposal ? 'accepted' : null,
    };
  }

  /**
   * Предложения параметра (Р-PUB-Z2-6): новые первыми, курсор `before` —
   * id (как журнал решений). `canWithdraw` — то же правило, что `withdraw`.
   */
  async proposals(
    db: PubTx,
    productId: string,
    key: string,
    f: {
      status?: ProposalStatus;
      before?: string;
      limit?: number;
      actor: string;
      mayPropose: boolean;
      mayWithdrawOthers: boolean;
    },
  ): Promise<ListPage<ParameterProposalView>> {
    await this.row(db, productId, key);
    const limit = Math.min(
      Math.max(f.limit ?? LIST_LIMIT_DEFAULT, 1),
      LIST_LIMIT_MAX,
    );
    const rows = await db.pubParameterProposal.findMany({
      where: {
        productId,
        parameterKey: key,
        ...(f.status ? { status: f.status } : {}),
        ...(f.before ? { id: { lt: f.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => {
        const mine = r.proposedBy === f.actor;
        return {
          id: r.id,
          parameterKey: r.parameterKey,
          value: r.value,
          status: r.status as ProposalStatus,
          proposedBy: r.proposedBy,
          proposedAt: r.proposedAt.toISOString(),
          decisionId: r.decisionId,
          revision: r.revision,
          mine,
          canWithdraw:
            r.status === 'open' &&
            f.mayPropose &&
            (mine || f.mayWithdrawOthers),
        };
      }),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async decisions(
    db: PubTx,
    productId: string,
    f: { key?: string; before?: string; limit?: number },
  ): Promise<ListPage<ParameterDecisionView>> {
    const limit = Math.min(
      Math.max(f.limit ?? LIST_LIMIT_DEFAULT, 1),
      LIST_LIMIT_MAX,
    );
    const rows = await db.pubParameterDecision.findMany({
      where: {
        productId,
        ...(f.key ? { parameterKey: f.key } : {}),
        ...(f.before ? { id: { lt: f.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        parameterKey: r.parameterKey,
        version: r.version,
        proposalId: r.proposalId,
        fromStatus: r.fromStatus as ParameterStatus,
        toStatus: r.toStatus as ParameterStatus,
        valueSnapshot: r.valueSnapshot,
        decidedBy: r.decidedBy,
        decidedAt: r.decidedAt.toISOString(),
        basis: r.basis,
        dependentStages: (Array.isArray(r.dependentStages)
          ? r.dependentStages
          : []) as DependentStage[],
      })),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }
}
