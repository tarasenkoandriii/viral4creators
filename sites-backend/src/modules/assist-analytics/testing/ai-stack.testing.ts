/**
 * Стенд тестов Э3-бис на НАСТОЯЩЕМ Postgres поверх стенда A (Э3): разметка,
 * выводы, эксперименты, связанный режим, поведение. Модель — подделка
 * GeminiText (очередь ответов, запись промптов); тариф кабинета —
 * строка подписки; кроны — только со `scope` своих сайтов.
 */
import { randomBytes } from 'crypto';
import { LearningSignals } from '../../assist-site-learning/public/learning-signals';
import type { ChatSite } from '../../assist-site-chat/testing/chat-stack.testing';
import type { AssistPlanId } from '../../assist-billing/plans';
import {
  GeminiText,
  TextModelError,
  type GenerateRequest,
  type GenerateResult,
} from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import { AiCabinetService } from '../ai/ai-cabinet.service';
import { AnalyticsBudget } from '../ai/analytics-budget';
import { WeeklyInsights } from '../ai/insights.service';
import { ConversationLabeler } from '../ai/labeler.service';
import { BehaviorRollup } from '../behavior/behavior-rollup.service';
import { ExperimentsService } from '../exp/experiments.service';
import { AiIntake } from '../public/ai-intake.service';
import { AnalyticsStack } from './analytics-stack.testing';

/** Подделка модели: ответы по очереди (строка | ошибка модели), промпты — в журнал. */
export class FakeText extends GeminiText {
  readonly calls: GenerateRequest[] = [];
  readonly queue: Array<
    string | 'timeout' | ((req: GenerateRequest) => string)
  > = [];
  inputTokens = 2000;
  outputTokens = 200;

  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined || next === 'timeout') {
      throw new TextModelError(next === 'timeout' ? 'timeout' : 'unavailable');
    }
    return {
      text: typeof next === 'function' ? next(req) : next,
      model: req.model ?? 'gemini-3.6-flash',
      inputTokens: this.inputTokens,
      cachedInputTokens: 0,
      outputTokens: this.outputTokens,
    };
  }
}

export const LITE_ENV: NodeJS.ProcessEnv = {
  ASSIST_LITE_MODEL: 'gemini-2.5-flash-lite',
  ASSIST_ANALYTICS_PLATFORM_DAILY_USD: '5',
};

/** Ответ разметки, проходящий проверку кодом. */
export function labelJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    intent: 'delivery',
    intentNote: null,
    stage: 'decide',
    buyingSignals: ['asked_delivery', 'asked_how_to_order'],
    llmLikelihood: 80,
    outcome: 'resolved',
    failureReason: null,
    failureNote: null,
    sentiment: { start: 0, end: 1, frustration: false },
    answerQuality: 4,
    qualityFlags: [],
    topics: [],
    entities: [],
    ...over,
  });
}

export class AiStack extends AnalyticsStack {
  readonly text = new FakeText();
  readonly recorder = new AiUsageRecorder();
  budget!: AnalyticsBudget;
  labeler!: ConversationLabeler;
  weekly!: WeeklyInsights;
  experiments!: ExperimentsService;
  behavior!: BehaviorRollup;
  ai!: AiIntake;
  cabinet!: AiCabinetService;
  signals!: LearningSignals;

  override async init(): Promise<this> {
    await super.init();
    const owner = this.owner;
    this.budget = new AnalyticsBudget(owner);
    this.budget.env = { ...LITE_ENV };
    this.signals = new LearningSignals(this.chat.publicDb);
    this.labeler = new ConversationLabeler(
      owner,
      this.text,
      this.recorder,
      this.budget,
      this.signals,
    );
    this.labeler.env = { ...LITE_ENV };
    this.weekly = new WeeklyInsights(
      owner,
      this.text,
      this.recorder,
      this.budget,
    );
    this.weekly.env = { ...LITE_ENV };
    this.experiments = new ExperimentsService(this.sitesDb, owner);
    this.behavior = new BehaviorRollup(owner);
    this.ai = new AiIntake(this.chat.publicDb);
    this.cabinet = new AiCabinetService(this.sitesDb, owner, this.budget);
    this.cabinet.env = { ...LITE_ENV };
    return this;
  }

  /** Тариф кабинета: строка подписки (ручной тариф пилота). */
  async plan(s: ChatSite, planId: AssistPlanId): Promise<void> {
    const now = new Date();
    await this.owner.assistSubscription.upsert({
      where: { accountId: s.accountId },
      create: {
        accountId: s.accountId,
        planId,
        status: 'active',
        method: 'manual',
        anchorAt: new Date(now.getTime() - 86_400_000),
        paidThrough: new Date(now.getTime() + 30 * 86_400_000),
      },
      update: { planId, status: 'active' },
    });
  }

  /** Настройки аналитики сайта (основной ролью, поверх умолчаний). */
  async analytics(s: ChatSite, cfg: Record<string, unknown>): Promise<void> {
    await this.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        analytics: {
          schema: 1,
          minutesPerQuestion: 3,
          officeCidrs: [],
          excludedPaths: [],
          aiLabeling: true,
          vertical: 'shop',
          linked: false,
          linkedGcm: false,
          linkedWindowDays: 7,
          behavior: false,
          ...cfg,
        },
        ipSalt: `salt-${s.siteId}`,
      },
    });
  }

  scope(...sites: ChatSite[]) {
    return { siteIds: sites.map((s) => s.siteId) };
  }
}

/** Случайный ключ визита (как в чанке ana.js). */
export function visitKey(): string {
  return `v${randomBytes(15).toString('base64url')}`;
}
