/**
 * AI Publisher — фейки портов и вкладов для тестов (P-A1, проектный
 * документ §16.0): пакеты этапа 1 тестируются против них, пока настоящих
 * реализаций соседей нет; интеграция Z заменяет фейки реальными.
 *
 * Фейк — не заглушка прода: он ЗАПИСЫВАЕТ вызовы (`calls`) и возвращает
 * заданное тестом, а не «успех по умолчанию».
 */
import {
  Injectable,
  type DynamicModule,
  type ModuleMetadata,
  type Provider,
  type Type,
} from '@nestjs/common';
import type { AiCallView, AiGateway, AiStartInput } from '../../contracts/ai';
import type { ProductCtx } from '../../contracts/common';
import {
  PUB_CONTRIBUTION,
  PubContribution,
  type MemberReassignContributor,
  type MemberReassignKey,
  type ProductInitContext,
  type ProductInitContributor,
  type ProductInitKey,
} from '../contributions';
import {
  AI_GATEWAY,
  AI_TASKS_PORT,
  BUDGET_LIMIT_PORT,
  BUDGET_READ_PORT,
  CONTENT_PORT,
  LEAD_ENRICH_PORT,
  PILOT_CLOCK_PORT,
  PUBLICATIONS_PORT,
  QA_RUN_EVIDENCE_PORT,
  RATE_LIMIT_RESET_PORT,
  type AiTasksPort,
  type BudgetLimitPort,
  type BudgetReadPort,
  type BudgetSnapshot,
  type ContentPort,
  type CronJob,
  type CronResult,
  type CronSchedule,
  type LeadEnrichPort,
  type PilotClockPort,
  type ProductRef,
  type PubCronContext,
  type PubTx,
  type PublicationsPort,
  type QaRunEvidence,
  type QaRunEvidencePort,
  type RateLimitResetPort,
} from '../ports';
import { AT_CATALOG, AT_CATALOG_VERSION } from '../../reports/qa/at-catalog';
import { pilotMilestones } from '../kyiv-time';

export class FakeBudgetLimitPort implements BudgetLimitPort {
  calls: string[] = [];
  fail: Error | null = null;
  async applyParameters(_tx: PubTx, product: ProductRef): Promise<void> {
    this.calls.push(product.id);
    if (this.fail) throw this.fail;
  }
}

export class FakeBudgetReadPort implements BudgetReadPort {
  constructor(public value: BudgetSnapshot | null = null) {}
  async snapshot(): Promise<BudgetSnapshot> {
    if (!this.value)
      throw new Error('FakeBudgetReadPort: снимок не задан тестом');
    return this.value;
  }
}

export class FakeContentPort implements ContentPort {
  published: Array<{ versionId: string; stage: string }> = [];
  withdrawn: string[] = [];
  version: Awaited<ReturnType<ContentPort['publishableVersion']>> | null = null;
  async publishableVersion() {
    if (!this.version)
      throw new Error('FakeContentPort: версия не задана тестом');
    return this.version;
  }
  async markPublished(
    _tx: PubTx,
    _p: ProductRef,
    versionId: string,
    _publicationId: string,
    stage: 'test' | 'live',
  ): Promise<void> {
    this.published.push({ versionId, stage });
  }
  async markWithdrawn(
    _tx: PubTx,
    _p: ProductRef,
    versionId: string,
  ): Promise<void> {
    this.withdrawn.push(versionId);
  }
}

export class FakePilotClockPort implements PilotClockPort {
  private t0 = new Map<string, Date>();
  async setT0Once(_tx: PubTx, product: ProductRef, at: Date) {
    if (this.t0.has(product.id)) return null;
    this.t0.set(product.id, at);
    const m = pilotMilestones(at);
    return { t0: m.t0, t42: m.t42, t72: m.t72, t90: m.t90 };
  }
}

export class FakePublicationsPort implements PublicationsPort {
  calls: Array<{ contentId: string; reason: string }> = [];
  /** Что вернуть (снятые публикации) — задаёт тест. */
  result: Array<{ publicationId: string; fromStatus: string }> = [];
  async withdrawForContent(
    _tx: PubTx,
    _p: ProductRef,
    contentId: string,
    input: { reason: string },
  ) {
    this.calls.push({ contentId, reason: input.reason });
    return this.result;
  }
}

export class FakeAiTasksPort implements AiTasksPort {
  accepted: string[] = [];
  async acceptCall(_tx: PubTx, _p: ProductRef, callId: string) {
    this.accepted.push(callId);
    return { taskId: `task_of_${callId}`, fromStatus: 'open', accepted: true };
  }
}

export class FakeLeadEnrichPort implements LeadEnrichPort {
  calls: string[] = [];
  async enrichNow(_p: ProductRef, leadId: string): Promise<void> {
    this.calls.push(leadId);
  }
}

export class FakeRateLimitResetPort implements RateLimitResetPort {
  calls: string[] = [];
  removed = 0;
  async reset(_tx: PubTx, product: ProductRef): Promise<number> {
    this.calls.push(product.id);
    return this.removed;
  }
}

export class FakeAiGateway implements AiGateway {
  started: Array<{ generator: string; opKey: string }> = [];
  view: AiCallView | null = null;
  async start<I>(p: AiStartInput<I>) {
    this.started.push({ generator: p.spec.id, opKey: p.opKey });
    return {
      callId: `call_${this.started.length}`,
      status: 'running' as const,
    };
  }
  async await(_product: ProductCtx, _callId: string): Promise<AiCallView> {
    if (!this.view) throw new Error('FakeAiGateway: ответ не задан тестом');
    return this.view;
  }
}

/** Шаги создания продукта — записывают вызовы (по одному на ключ). */
export class FakeProductInit implements ProductInitContributor {
  static calls: Array<{
    key: ProductInitKey;
    productId: string;
    actor: string;
  }> = [];
  constructor(readonly key: ProductInitKey) {}
  async init(
    _tx: PubTx,
    product: ProductCtx,
    ctx: ProductInitContext,
  ): Promise<void> {
    FakeProductInit.calls.push({
      key: this.key,
      productId: product.id,
      actor: ctx.actor,
    });
  }
}

@Injectable()
@PubContribution('product-init')
export class FakeSiteChannelInit extends FakeProductInit {
  constructor() {
    super('site-channel');
  }
}
@Injectable()
@PubContribution('product-init')
export class FakeBudgetLimitInit extends FakeProductInit {
  constructor() {
    super('budget-limit');
  }
}
@Injectable()
@PubContribution('product-init')
export class FakePilotExperimentInit extends FakeProductInit {
  constructor() {
    super('pilot-experiment');
  }
}

export class FakeMemberReassign implements MemberReassignContributor {
  static calls: Array<{
    key: MemberReassignKey;
    productId: string;
    from: string;
    to: string;
  }> = [];
  constructor(readonly key: MemberReassignKey) {}
  async reassign(
    _tx: PubTx,
    product: ProductRef,
    from: string,
    to: string,
  ): Promise<number> {
    FakeMemberReassign.calls.push({
      key: this.key,
      productId: product.id,
      from,
      to,
    });
    return 0;
  }
}
@Injectable()
@PubContribution('member-reassign')
export class FakeLeadsReassign extends FakeMemberReassign {
  constructor() {
    super('leads');
  }
}
@Injectable()
@PubContribution('member-reassign')
export class FakeActionsReassign extends FakeMemberReassign {
  constructor() {
    super('distribution-actions');
  }
}
@Injectable()
@PubContribution('member-reassign')
export class FakeContentsReassign extends FakeMemberReassign {
  constructor() {
    super('contents');
  }
}

/** Задание крона-фейк (ключ/расписание — из теста). */
export function fakeCronJob(
  key: string,
  schedule: CronSchedule,
  run: (ctx: PubCronContext) => Promise<CronResult> = async () => ({
    processed: 0,
  }),
): CronJob {
  return { key, schedule, run };
}

/**
 * Фейк сводки прогонов qa-catalog (Р-PUB-Z2-27): прогонов нет, пока тест
 * их не положит (`passing`/`put`) — «успеха по умолчанию» нет.
 */
export class FakeQaRunEvidencePort implements QaRunEvidencePort {
  readonly runs = new Map<string, QaRunEvidence & { accountId: string }>();
  calls: Array<{ accountId: string; runId: string }> = [];
  async runEvidence(
    accountId: string,
    runId: string,
  ): Promise<QaRunEvidence | null> {
    this.calls.push({ accountId, runId });
    const r = this.runs.get(runId);
    return r && r.accountId === accountId ? r : null;
  }
  put(accountId: string, run: QaRunEvidence): string {
    this.runs.set(run.runId, { ...run, accountId });
    return run.runId;
  }
  /** Прогон, где ВСЕ 44 кейса каталога — passed текущей версии. */
  passing(accountId: string, runId = `qa-run-${this.runs.size + 1}`): string {
    return this.put(accountId, {
      runId,
      siteId: 'site-qa',
      title: 'AT P0',
      createdAt: new Date(),
      cases: Object.fromEntries(
        AT_CATALOG.map((c) => [
          c.id,
          { version: AT_CATALOG_VERSION, status: 'passed' },
        ]),
      ),
    });
  }
}

export interface FakePorts {
  budgetLimit: FakeBudgetLimitPort;
  budgetRead: FakeBudgetReadPort;
  content: FakeContentPort;
  pilotClock: FakePilotClockPort;
  leadEnrich: FakeLeadEnrichPort;
  rateLimitReset: FakeRateLimitResetPort;
  ai: FakeAiGateway;
  publications: FakePublicationsPort;
  aiTasks: FakeAiTasksPort;
  qaRuns: FakeQaRunEvidencePort;
}

export function fakePorts(): FakePorts {
  return {
    budgetLimit: new FakeBudgetLimitPort(),
    budgetRead: new FakeBudgetReadPort(),
    content: new FakeContentPort(),
    pilotClock: new FakePilotClockPort(),
    leadEnrich: new FakeLeadEnrichPort(),
    rateLimitReset: new FakeRateLimitResetPort(),
    ai: new FakeAiGateway(),
    publications: new FakePublicationsPort(),
    aiTasks: new FakeAiTasksPort(),
    qaRuns: new FakeQaRunEvidencePort(),
  };
}

/** Провайдеры фейков портов + все ожидаемые вклады создания/переназначения. */
export function fakePortProviders(f: FakePorts = fakePorts()): Provider[] {
  return [
    { provide: BUDGET_LIMIT_PORT, useValue: f.budgetLimit },
    { provide: BUDGET_READ_PORT, useValue: f.budgetRead },
    { provide: CONTENT_PORT, useValue: f.content },
    { provide: PILOT_CLOCK_PORT, useValue: f.pilotClock },
    { provide: LEAD_ENRICH_PORT, useValue: f.leadEnrich },
    { provide: RATE_LIMIT_RESET_PORT, useValue: f.rateLimitReset },
    { provide: AI_GATEWAY, useValue: f.ai },
    { provide: PUBLICATIONS_PORT, useValue: f.publications },
    { provide: AI_TASKS_PORT, useValue: f.aiTasks },
    { provide: QA_RUN_EVIDENCE_PORT, useValue: f.qaRuns },
    FakeSiteChannelInit,
    FakeBudgetLimitInit,
    FakePilotExperimentInit,
    FakeLeadsReassign,
    FakeActionsReassign,
    FakeContentsReassign,
  ];
}

/**
 * Что дают НАСТОЯЩИЕ модули `imports` (рекурсивно): токены портов и ключи
 * вкладов `product-init`/`member-reassign` (интеграция Z-1, «дубли Fake*»:
 * фейк рядом с настоящим вкладом — двойная регистрация ключа, рядом с
 * настоящим портом — неоднозначный поиск провайдера).
 */
export function realProvided(imports: ModuleMetadata['imports'] = []): {
  tokens: Set<unknown>;
  contributions: Set<string>;
} {
  const tokens = new Set<unknown>();
  const contributions = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (m: unknown): void => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    const dyn = m as Partial<DynamicModule>;
    const cls = (dyn.module ?? m) as Type<unknown>;
    const meta = (k: string): unknown[] =>
      (Reflect.getMetadata(k, cls) as unknown[] | undefined) ?? [];
    const providers = [...meta('providers'), ...(dyn.providers ?? [])];
    for (const p of providers) {
      if (p && typeof p === 'object' && 'provide' in p) {
        tokens.add((p as { provide: unknown }).provide);
        continue;
      }
      if (typeof p !== 'function') continue;
      tokens.add(p);
      const kind = Reflect.getMetadata(PUB_CONTRIBUTION, p) as
        string | undefined;
      if (kind !== 'product-init' && kind !== 'member-reassign') continue;
      try {
        const key = (Reflect.construct(p, []) as { key?: unknown }).key;
        if (typeof key === 'string') contributions.add(`${kind}:${key}`);
      } catch {
        // конструктор требует зависимостей — ключ неизвестен, фейк остаётся
      }
    }
    for (const i of [...meta('imports'), ...(dyn.imports ?? [])]) visit(i);
  };
  for (const m of imports) visit(m);
  return { tokens, contributions };
}

/** Фейки без тех, что заменены настоящими модулями `imports`. */
export function fakesBesides(
  providers: Provider[],
  imports: ModuleMetadata['imports'] = [],
): Provider[] {
  const real = realProvided(imports);
  return providers.filter((p) => {
    if (p && typeof p === 'object' && 'provide' in p) {
      return !real.tokens.has(p.provide);
    }
    if (typeof p !== 'function') return true;
    const kind = Reflect.getMetadata(PUB_CONTRIBUTION, p) as string | undefined;
    if (!kind) return true;
    const key = (Reflect.construct(p, []) as { key?: unknown }).key;
    return !real.contributions.has(`${kind}:${String(key)}`);
  });
}
