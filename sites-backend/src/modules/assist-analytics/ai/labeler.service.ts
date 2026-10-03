/**
 * ИИ-разметка закрытых диалогов «Сайта» — системный код крона
 * `assist-analytics-run` (Э3-бис; ТЗ §5-тер.3–4, Р-43, Р-44). Основная роль.
 *
 * Тик (без нового крона — Vercel Hobby):
 *  1. lite-модель (`ASSIST_LITE_MODEL`) со ставкой — иначе ничего (находки
 *     кодом и сухие строки работают без неё);
 *  2. очередь: диалоги, закрытые ≥ 30 мин назад и ≤ 7 дней назад, не
 *     `suspicious`, с ответом помощника, без разметки (или `retry` < 3
 *     попыток), сайт не выключил разметку; тариф кабинета — `aiAnalytics`
 *     (Business+);
 *  3. выборка (§5-тер.3): потрачено ≥ 80% доли сайта — размечаются все
 *     диалоги с конверсией, передачей, лидом или 👎, и детерминированные 20%
 *     остальных (вес 5); прочие — `skipped` (вес 0);
 *  4. резерв ДО вызова (сайт + платформа); не помещается — сайт пропускается
 *     до нового месяца/суток;
 *  5. вход — ТОЛЬКО замаскированный текст (`maskTurn` + `assertMasked`);
 *     невалидный JSON/перечень — ОДНА повторная попытка, затем `failed`;
 *     сбой модели — `retry` (≤ 3);
 *  6. проверка кодом, lead score кодом (калибровка Pro — вероятность);
 *     answerQuality ≤ 2 / ungrounded_suspect → сигнал `wrong` очереди
 *     обучения (решение — человека, Р-33).
 * В лог — id и коды (§6.6), без текста.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { estimateCost } from '../../../shared/ai-pricing';
import type { CronScope } from '../../../common/cron-scope';
import { ASSIST_PLANS } from '../../assist-billing/plans';
import { readState } from '../../assist-billing/public/entitlements';
import { LearningSignals } from '../../assist-site-learning/public/learning-signals';
import { GeminiText, TextModelError } from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import { effectiveAnalyticsConfig } from '../analytics-config';
import { normalizePath } from '../public/page-view';
import { analyticsModel } from './ai-env';
import { AnalyticsBudget } from './analytics-budget';
import {
  LABEL_LIMITS,
  LABEL_PROMPT_VERSION,
  buildLabelPrompt,
  maskTurn,
  parseLabel,
  type LabelInput,
  type LabelResult,
  type LabelTurn,
} from './label-schema';
import {
  isVertical,
  leadScore,
  plattProb,
  type Platt,
  type Vertical,
} from './lead-score';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Закрыт — 30 мин тишины (как единица тарифа §7.1 и свёртка §9.1). */
export const LABEL_IDLE_MS = 30 * MIN;
/** Не размечаем задним числом глубже недели (разметка нужна отчётам недели). */
export const LABEL_LOOKBACK_MS = 7 * DAY;
export const LABEL_MAX_ATTEMPTS = 3;
/** Потрачено столько от доли — выборка. */
export const SAMPLE_FROM_SHARE = 0.8;
/** «Случайные 20%» — детерминированно по id диалога, вес 5. */
export const SAMPLE_MOD = 5;

export interface LabelTickResult {
  model: string | null;
  disabled: 'unset' | 'unpriced' | null;
  labeled: number;
  failed: number;
  skipped: number;
  retry: number;
  budgetStopped: number;
}

interface Candidate {
  id: string;
  accountId: string;
  siteId: string;
  pageUrl: string | null;
  locale: string | null;
  voice: boolean;
  openedBy: string | null;
  visitHash: string | null;
  createdAt: Date;
  attempts: number | null;
  analytics: unknown;
  siteSummary: unknown;
}

interface SiteCtx {
  allowed: boolean;
  calibration: boolean;
  capMicroUsd: number;
  spentMicroUsd: number;
  vertical: Vertical;
  topics: string[];
  dictionary: string[];
  platt: Platt | null;
  stopped: boolean;
}

/**
 * Путь страницы для входа модели: без query/hash, номера и ПД-сегменты
 * (e-mail, телефон, номер заказа в пути) → `:id` (аудит Э3-бис: URL
 * диалога хранится как есть, а вход модели — только замаскированный).
 */
export function pathOf(url: string | null): string | null {
  if (!url) return null;
  let raw: string;
  try {
    raw = new URL(url).pathname;
  } catch {
    if (!url.startsWith('/')) return null;
    raw = url;
  }
  return normalizePath(raw);
}

/**
 * Вертикаль приоров: выбор владельца, иначе тип бизнеса из сводки сайта
 * (§4.6 п.3: shop | services | saas | other — тот же перечень).
 */
export function verticalOf(cfg: Vertical, summary: unknown): Vertical {
  if (cfg !== 'other') return cfg;
  const t =
    summary && typeof summary === 'object'
      ? (summary as { businessType?: unknown }).businessType
      : null;
  return isVertical(t) ? t : 'other';
}

/** Детерминированная «случайная» выборка: хеш id → 0..mod-1. */
export function sampleSlot(id: string, mod = SAMPLE_MOD): number {
  let h = 0;
  for (let i = 0; i < id.length; i++)
    h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return h % mod;
}

@Injectable()
export class ConversationLabeler {
  private readonly logger = new Logger(ConversationLabeler.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly text: GeminiText,
    private readonly usage: AiUsageRecorder,
    private readonly budget: AnalyticsBudget,
    @Optional() private readonly signals?: LearningSignals,
  ) {}

  async tick(opts: {
    now?: Date;
    deadline: number;
    max: number;
    scope?: CronScope;
  }): Promise<LabelTickResult> {
    const now = opts.now ?? this.now();
    const res: LabelTickResult = {
      model: null,
      disabled: null,
      labeled: 0,
      failed: 0,
      skipped: 0,
      retry: 0,
      budgetStopped: 0,
    };
    this.budget.env = this.env;
    const m = analyticsModel(this.env);
    if (!m.ok) {
      res.disabled = m.reason;
      return res;
    }
    res.model = m.model;
    const rows = await this.prisma.$queryRawUnsafe<Candidate[]>(
      `SELECT c."id", c."accountId", c."siteId", c."pageUrl", c."locale", c."voice",
              c."openedBy", c."visitHash", c."createdAt", l."attempts", a."analytics",
              a."siteSummary"
         FROM "sites"."assist_site_conversations" c
         JOIN "sites"."assist_sites" a ON a."siteId" = c."siteId"
         LEFT JOIN "sites"."assist_site_conversation_labels" l ON l."conversationId" = c."id"
        WHERE c."lastMessageAt" < $1 AND c."lastMessageAt" >= $2
          AND NOT c."suspicious"
          AND (l."conversationId" IS NULL OR (l."status" = 'retry' AND l."attempts" < $3))
          AND COALESCE(a."analytics"->>'aiLabeling', 'true') <> 'false'
          AND EXISTS (
            SELECT 1 FROM "sites"."assist_site_messages" m
             WHERE m."conversationId" = c."id" AND m."role" = 'assistant'
               AND m."answerPath" IN ('model', 'faq', 'cache')
               AND m."streamState" IN ('complete', 'partial'))
          AND ($4::text[] IS NULL OR c."siteId" = ANY($4::text[]))
        ORDER BY c."lastMessageAt"
        LIMIT $5`,
      new Date(now.getTime() - LABEL_IDLE_MS),
      new Date(now.getTime() - LABEL_LOOKBACK_MS),
      LABEL_MAX_ATTEMPTS,
      opts.scope ? opts.scope.siteIds : null,
      Math.max(opts.max * 4, 50),
    );
    const sites = new Map<string, SiteCtx>();
    let done = 0;
    for (const c of rows) {
      if (done >= opts.max || Date.now() > opts.deadline) break;
      let ctx = sites.get(c.siteId);
      if (!ctx) {
        ctx = await this.siteCtx(c, now);
        sites.set(c.siteId, ctx);
      }
      if (!ctx.allowed || ctx.stopped) continue;
      try {
        const r = await this.labelOne(c, ctx, m.model, now);
        done++;
        if (r === 'ok') res.labeled++;
        else if (r === 'failed') res.failed++;
        else if (r === 'skipped') res.skipped++;
        else if (r === 'retry') res.retry++;
        else if (r === 'budget') {
          res.budgetStopped++;
          ctx.stopped = true;
        }
      } catch (e) {
        this.logger.warn(
          `разметка ${c.id} не удалась (${(e as Error | null)?.name ?? 'Error'})`,
        );
      }
    }
    if (res.labeled || res.failed || res.budgetStopped) {
      this.logger.log(
        `разметка: ok ${res.labeled}, failed ${res.failed}, skipped ${res.skipped}, retry ${res.retry}, бюджет ${res.budgetStopped}`,
      );
    }
    return res;
  }

  private async siteCtx(c: Candidate, now: Date): Promise<SiteCtx> {
    const state = await readState(this.prisma, c.accountId, now);
    const plan = state.planId ? ASSIST_PLANS[state.planId] : null;
    const cfg = effectiveAnalyticsConfig(c.analytics);
    const ctx: SiteCtx = {
      allowed: !!plan?.aiAnalytics,
      calibration: !!plan?.leadCalibration,
      capMicroUsd: 0,
      spentMicroUsd: 0,
      vertical: verticalOf(cfg.vertical, c.siteSummary),
      topics: [],
      dictionary: [],
      platt: null,
      stopped: false,
    };
    if (!ctx.allowed) return ctx;
    const st = await this.budget.status(c.accountId, c.siteId, now);
    ctx.capMicroUsd = st.capMicroUsd;
    ctx.spentMicroUsd = st.spentMicroUsd;
    const topics = await this.prisma.$queryRawUnsafe<Array<{ label: string }>>(
      `SELECT "label" FROM "sites"."assist_site_learning_clusters"
        WHERE "siteId" = $1 AND "accountId" = $2
        ORDER BY "distinctVisitors" DESC, "lastSeenAt" DESC LIMIT $3`,
      c.siteId,
      c.accountId,
      LABEL_LIMITS.topics,
    );
    ctx.topics = topics
      .map((t) => maskTurn(t.label).slice(0, 80))
      .filter((t) => t.length > 0);
    const docs = await this.prisma.$queryRawUnsafe<Array<{ title: string }>>(
      `SELECT DISTINCT "title" FROM "sites"."assist_site_documents"
        WHERE "siteId" = $1 AND "accountId" = $2 AND "status" = 'active'
          AND "title" IS NOT NULL AND length("title") BETWEEN 2 AND 120
        LIMIT $3`,
      c.siteId,
      c.accountId,
      LABEL_LIMITS.dictionary,
    );
    ctx.dictionary = docs.map((d) => maskTurn(d.title)).filter(Boolean);
    if (ctx.calibration) {
      const cal = await this.prisma.$queryRawUnsafe<
        Array<{ method: string; params: unknown }>
      >(
        `SELECT "method", "params" FROM "sites"."assist_site_lead_calibrations"
          WHERE "siteId" = $1 AND "accountId" = $2 ORDER BY "version" DESC LIMIT 1`,
        c.siteId,
        c.accountId,
      );
      const p = cal[0]?.params as Partial<Platt> | undefined;
      if (
        cal[0]?.method === 'platt' &&
        typeof p?.a === 'number' &&
        typeof p?.b === 'number'
      ) {
        ctx.platt = { a: p.a, b: p.b };
      }
    }
    return ctx;
  }

  /** Факты диалога из кода (§5-тер.3 «признаки из кода»). */
  private async facts(c: Candidate) {
    const [f] = await this.prisma.$queryRawUnsafe<
      Array<{
        handoff: boolean;
        lead: boolean;
        converted: boolean;
        direct: boolean;
        answers: bigint;
        visitor: bigint;
        down: boolean;
        repeat: boolean;
        lastAnswerId: string | null;
        firstQuestion: string | null;
      }>
    >(
      `SELECT
         EXISTS (SELECT 1 FROM "sites"."assist_site_handoffs" h
                  WHERE h."conversationId" = $1 AND h."state" <> 'cancelled') AS handoff,
         EXISTS (SELECT 1 FROM "sites"."assist_site_leads" l WHERE l."conversationId" = $1) AS lead,
         EXISTS (SELECT 1 FROM "sites"."assist_site_goal_events" e
                  WHERE e."conversationId" = $1 AND e."status" = 'completed'
                    AND e."attribution" IN ('direct', 'assisted')) AS converted,
         EXISTS (SELECT 1 FROM "sites"."assist_site_goal_events" e
                  WHERE e."conversationId" = $1 AND e."status" = 'completed'
                    AND e."attribution" = 'direct') AS direct,
         (SELECT count(*) FROM "sites"."assist_site_messages" m
           WHERE m."conversationId" = $1 AND m."role" = 'assistant'
             AND m."answerPath" IN ('model', 'faq', 'cache')) AS answers,
         (SELECT count(*) FROM "sites"."assist_site_messages" m
           WHERE m."conversationId" = $1 AND m."role" = 'visitor') AS visitor,
         EXISTS (SELECT 1 FROM "sites"."assist_site_messages" m
                  WHERE m."conversationId" = $1 AND m."rating" = -1) AS down,
         ($2::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM "sites"."assist_site_conversations" p
             WHERE p."siteId" = $3 AND p."visitHash" = $2 AND p."id" <> $1
               AND p."createdAt" < $4)) AS repeat,
         (SELECT m."id" FROM "sites"."assist_site_messages" m
           WHERE m."conversationId" = $1 AND m."role" = 'assistant'
             AND m."answerPath" = 'model'
           ORDER BY m."createdAt" DESC LIMIT 1) AS "lastAnswerId",
         (SELECT m."text" FROM "sites"."assist_site_messages" m
           WHERE m."conversationId" = $1 AND m."role" = 'visitor'
           ORDER BY m."createdAt" ASC LIMIT 1) AS "firstQuestion"`,
      c.id,
      c.visitHash,
      c.siteId,
      c.createdAt,
    );
    return f;
  }

  private async labelOne(
    c: Candidate,
    ctx: SiteCtx,
    model: string,
    now: Date,
  ): Promise<'ok' | 'failed' | 'skipped' | 'retry' | 'budget'> {
    const f = await this.facts(c);
    const priority = f.converted || f.handoff || f.lead || f.down;
    let weight = 1;
    // Выборка при исчерпании бюджета (§5-тер.3): приоритетные — все,
    // остальные — детерминированные 20% с весом 5.
    if (
      ctx.capMicroUsd > 0 &&
      ctx.spentMicroUsd >= ctx.capMicroUsd * SAMPLE_FROM_SHARE &&
      !priority
    ) {
      if (sampleSlot(c.id) !== 0) {
        await this.write(c, {
          status: 'skipped',
          weight: 0,
          model: null,
          attempts: c.attempts ?? 0,
        });
        return 'skipped';
      }
      weight = SAMPLE_MOD;
    }
    const msgs = await this.prisma.$queryRawUnsafe<
      Array<{ role: string; text: string }>
    >(
      `SELECT "role", "text" FROM (
         SELECT "role", "text", "createdAt" FROM "sites"."assist_site_messages"
          WHERE "conversationId" = $1 AND "role" IN ('visitor', 'assistant', 'operator')
            AND "streamState" IN ('complete', 'partial')
          ORDER BY "createdAt" DESC LIMIT $2) t
        ORDER BY "createdAt" ASC`,
      c.id,
      LABEL_LIMITS.turns,
    );
    // ПД маскируются ДО модели: журнал уже маскирован (§4.7), здесь —
    // ещё раз (карты, IBAN, телефоны, e-mail, ключи); buildLabelPrompt
    // проверяет каждую реплику (`assertMasked`).
    const turns: LabelTurn[] = msgs
      .map((x) => ({
        role: x.role as LabelTurn['role'],
        text: maskTurn(x.text),
      }))
      .filter((t) => t.text.length > 0);
    if (!turns.some((t) => t.role === 'visitor')) {
      await this.write(c, {
        status: 'skipped',
        weight: 0,
        model: null,
        attempts: c.attempts ?? 0,
      });
      return 'skipped';
    }
    const input: LabelInput = {
      turns,
      pagePath: pathOf(c.pageUrl),
      lang: c.locale,
      facts: {
        handoff: f.handoff,
        lead: f.lead,
        converted: f.converted,
        assistClick: f.direct,
        voice: c.voice,
        proactive: (c.openedBy ?? '').startsWith('proactive:'),
        answers: Number(f.answers),
      },
      topics: ctx.topics,
      dictionary: ctx.dictionary,
    };
    const prompt = buildLabelPrompt(input);
    const est = estimateCost(
      model,
      {
        inputTokens: Math.ceil((prompt.system.length + prompt.user.length) / 2),
        outputTokens: LABEL_LIMITS.maxOutputTokens,
      },
      this.env,
    ).costMicroUsd;
    let attempts = c.attempts ?? 0;
    let cost = 0;
    let label: LabelResult | null = null;
    // Невалидный ответ — ОДНА повторная попытка (§5-тер.16 п.10).
    for (let call = 0; call < 2 && !label; call++) {
      const rsv = await this.budget.reserve(
        c.accountId,
        c.siteId,
        est,
        ctx.capMicroUsd,
        now,
      );
      if (rsv.result !== 'ok' || !rsv.reservation) {
        if (cost > 0) break;
        return 'budget';
      }
      attempts++;
      let actual = 0;
      try {
        const out = await this.text.generate({
          system: prompt.system,
          user: prompt.user,
          json: true,
          temperature: 0,
          maxOutputTokens: LABEL_LIMITS.maxOutputTokens,
          model,
        });
        const rec = await this.usage.record(this.prisma, {
          accountId: c.accountId,
          siteId: c.siteId,
          operation: 'assist-label',
          model: out.model,
          units: {
            inputTokens: out.inputTokens,
            cachedInputTokens: out.cachedInputTokens,
            outputTokens: out.outputTokens,
          },
        });
        actual = rec.costMicroUsd;
        cost += actual;
        const parsed = parseLabel(out.text, input);
        if (parsed.ok) label = parsed.label;
      } catch (e) {
        if (e instanceof TextModelError) {
          await this.budget.settle(rsv.reservation, 0);
          const status = attempts >= LABEL_MAX_ATTEMPTS ? 'failed' : 'retry';
          await this.write(c, { status, weight, model, attempts, cost });
          return status;
        }
        // Иной сбой (например, запись расхода после ответа модели): деньги,
        // возможно, потрачены — резерв остаётся расходом, не возвращается
        // (аудит Э3-бис: иначе потолок недосчитывает).
        throw e;
      }
      await this.budget.settle(rsv.reservation, actual);
      ctx.spentMicroUsd += actual;
    }
    if (!label) {
      await this.write(c, { status: 'failed', weight, model, attempts, cost });
      return 'failed';
    }
    // Инъекция (аудит Э3-бис): посетитель, просивший «оценить его горячим»,
    // мог сдвинуть и stage/сигналы — тот же ответ модели. Score тогда — только
    // по признакам кода (лид, клик, страница, длина, повтор); разметка
    // (intent/stage для отчётов) остаётся с флагом injection_suspect.
    const inj = label.injectionSuspect;
    const score = leadScore(
      {
        stage: inj ? 'explore' : label.stage,
        intent: inj ? 'other' : label.intent,
        buyingSignals: inj
          ? f.lead
            ? ['opened_lead_form']
            : []
          : label.buyingSignals,
        llmLikelihood: inj ? null : label.llmLikelihood,
        visitorTurns: Number(f.visitor),
        assistClick: f.direct,
        pagePath: input.pagePath,
        voice: c.voice,
        repeatVisit: f.repeat,
      },
      ctx.vertical,
    );
    await this.write(c, {
      status: label.injectionSuspect ? 'injection_suspect' : 'ok',
      weight,
      model,
      attempts,
      cost,
      label,
      lead: {
        score: score.score,
        bucket: score.bucket,
        features: score.features,
        prob:
          ctx.calibration && ctx.platt
            ? Math.round(plattProb(score.score, ctx.platt) * 1e4) / 1e4
            : null,
      },
    });
    if (
      this.signals &&
      f.lastAnswerId &&
      f.firstQuestion &&
      (label.answerQuality <= 2 ||
        label.qualityFlags.includes('ungrounded_suspect'))
    ) {
      await this.signals.record({
        accountId: c.accountId,
        siteId: c.siteId,
        kind: 'wrong',
        signal: 'label',
        conversationId: c.id,
        messageId: f.lastAnswerId,
        visitorId: null,
        suspicious: false,
        questionMasked: maskTurn(f.firstQuestion),
        answerMasked: null,
        lang: c.locale,
        embedding: null,
      });
    }
    return 'ok';
  }

  private async write(
    c: Candidate,
    p: {
      status: string;
      weight: number;
      model: string | null;
      attempts: number;
      cost?: number;
      label?: LabelResult;
      lead?: {
        score: number;
        bucket: string;
        features: unknown;
        prob: number | null;
      };
    },
  ): Promise<void> {
    const l = p.label;
    const data = {
      status: p.status,
      model: p.model,
      promptVersion: LABEL_PROMPT_VERSION,
      intent: l?.intent ?? null,
      intentNote: l?.intentNote ?? null,
      stage: l?.stage ?? null,
      buyingSignals: l?.buyingSignals ?? [],
      llmLikelihood: l?.llmLikelihood ?? null,
      outcome: l?.outcome ?? null,
      failureReason: l?.failureReason ?? null,
      failureNote: l?.failureNote ?? null,
      sentimentStart: l?.sentimentStart ?? null,
      sentimentEnd: l?.sentimentEnd ?? null,
      frustration: l?.frustration ?? false,
      answerQuality: l?.answerQuality ?? null,
      qualityFlags: l?.qualityFlags ?? [],
      topics: l?.topics ?? [],
      entities: l?.entities ?? [],
      leadScore: p.lead?.score ?? null,
      leadBucket: p.lead?.bucket ?? null,
      leadFeatures: p.lead
        ? (p.lead.features as Prisma.InputJsonValue)
        : Prisma.DbNull,
      leadProb: p.lead?.prob ?? null,
      weight: p.weight,
      attempts: p.attempts,
      costMicroUsd: Math.round(p.cost ?? 0),
      labeledAt: this.now(),
    };
    await this.prisma.assistSiteConversationLabel.upsert({
      where: { conversationId: c.id },
      create: {
        conversationId: c.id,
        accountId: c.accountId,
        siteId: c.siteId,
        ...data,
      },
      // Исправление человека (humanOverride) не затирается повторной разметкой.
      update: data,
    });
  }
}
