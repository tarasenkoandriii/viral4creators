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
 *     обучения (решение — человека, Р-33);
 *  7. заход 9: `ASSIST_LABEL_BATCH=1` — вместо вызовов по одному одно
 *     пакетное задание Gemini Batch API за тик (label-batch.ts; резерв —
 *     оценка × доля цены пакета, ответ — следующими тиками, статус `batch`).
 * В лог — id и коды (§6.6), без текста.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { estimateCost } from '../../../shared/ai-pricing';
import type { CronScope } from '../../../common/cron-scope';
import { ASSIST_PLANS } from '../../assist-billing/plans';
import { readState } from '../../assist-billing/public/entitlements';
import { LearningSignals } from '../../assist-site-learning/public/learning-signals';
import { geminiOutputCeiling } from '../../site-ai/gemini-output';
import {
  GeminiText,
  TextModelError,
  spentOf,
  type TextModelSpent,
} from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import { effectiveAnalyticsConfig } from '../analytics-config';
import { normalizePath } from '../public/page-view';
import { analyticsModel } from './ai-env';
import {
  AnalyticsBudget,
  analyticsPeriod,
  type AnalyticsReservation,
} from './analytics-budget';
import {
  GeminiLabelBatch,
  LABEL_BATCH_POLLS_PER_TICK,
  LABEL_BATCH_TEMP_PREFIX,
  LABEL_BATCH_STALE_MS,
  labelBatchEnabled,
  labelBatchPriceFactor,
  type LabelBatchClient,
  type LabelBatchPoll,
  type LabelBatchResult,
} from './label-batch';
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
  /** Отправлено пакетным заданием (ASSIST_LABEL_BATCH=1). */
  batched: number;
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

interface LabelFacts {
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
}

/** Подготовленный к модели диалог (вход, промпт, оценка, вес выборки). */
interface Prepared {
  f: LabelFacts;
  weight: number;
  input: LabelInput;
  prompt: { system: string; user: string };
  est: number;
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
  /** Пакетный клиент (ASSIST_LABEL_BATCH=1); тесты подставляют подделку. */
  batch: LabelBatchClient | null = null;

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
      batched: 0,
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
    // Пакетный режим (заход 9): за выключателем; задания, отправленные до
    // выключения, всё равно забираются (иначе резерв повис бы).
    if (labelBatchEnabled(this.env)) {
      this.batch ??= new GeminiLabelBatch();
      await this.batchTick(
        rows,
        res,
        { model: m.model, now, deadline: opts.deadline, max: opts.max },
        opts.scope,
      );
      this.logResult(res);
      return res;
    }
    if (await this.hasBatches(opts.scope)) {
      this.batch ??= new GeminiLabelBatch();
      await this.collectBatches(this.batch, res, now, opts.scope);
    }
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
    this.logResult(res);
    return res;
  }

  private logResult(res: LabelTickResult): void {
    if (res.labeled || res.failed || res.budgetStopped || res.batched) {
      this.logger.log(
        `разметка: ok ${res.labeled}, failed ${res.failed}, skipped ${res.skipped}, retry ${res.retry}, бюджет ${res.budgetStopped}, в пакете ${res.batched}`,
      );
    }
  }

  private async hasBatches(scope?: CronScope): Promise<boolean> {
    const [r] = await this.prisma.$queryRawUnsafe<Array<{ e: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM "sites"."assist_site_conversation_labels"
        WHERE "status" = 'batch' AND ($1::text[] IS NULL OR "siteId" = ANY($1::text[]))) AS e`,
      scope ? scope.siteIds : null,
    );
    return r?.e === true;
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
  private async facts(c: Candidate): Promise<LabelFacts> {
    const [f] = await this.prisma.$queryRawUnsafe<Array<LabelFacts>>(
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

  /**
   * Подготовка диалога к разметке: факты кода, выборка, замаскированный
   * вход и промпт. `skipped` — уже записан (вне выборки / нет вопроса).
   */
  private async prepare(
    c: Candidate,
    ctx: SiteCtx,
    model: string,
  ): Promise<{ kind: 'skipped' } | ({ kind: 'ready' } & Prepared)> {
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
        return { kind: 'skipped' };
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
      return { kind: 'skipped' };
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
        // Сверху — потолок, который уходит провайдеру (с запасом на мысли).
        outputTokens: geminiOutputCeiling(LABEL_LIMITS.maxOutputTokens),
      },
      this.env,
    ).costMicroUsd;
    return { kind: 'ready', f, weight, input, prompt, est };
  }

  private async labelOne(
    c: Candidate,
    ctx: SiteCtx,
    model: string,
    now: Date,
  ): Promise<'ok' | 'failed' | 'skipped' | 'retry' | 'budget'> {
    const prep = await this.prepare(c, ctx, model);
    if (prep.kind === 'skipped') return 'skipped';
    const { input, prompt, est, weight } = prep;
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
      const record = async (out: TextModelSpent) => {
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
      };
      try {
        const out = await this.text.generate({
          system: prompt.system,
          user: prompt.user,
          json: true,
          temperature: 0,
          maxOutputTokens: LABEL_LIMITS.maxOutputTokens,
          model,
        });
        await record(out);
        const parsed = parseLabel(out.text, input);
        if (parsed.ok) label = parsed.label;
      } catch (e) {
        if (e instanceof TextModelError) {
          // empty/truncated оплачены: расход — как у ответа, резерв —
          // фактом. Сбой этой записи — резерв остаётся расходом (как ниже),
          // а исход попытки тот же.
          const spent = spentOf(e);
          const recorded = spent
            ? await record(spent).then(
                () => true,
                () => false,
              )
            : true;
          if (recorded) {
            await this.budget.settle(rsv.reservation, actual);
            ctx.spentMicroUsd += actual;
          }
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
    await this.complete(c, ctx, prep, label, { model, attempts, cost });
    return 'ok';
  }

  /** Lead score кодом, запись разметки и сигнал очереди обучения. */
  private async complete(
    c: Candidate,
    ctx: SiteCtx,
    prep: Prepared,
    label: LabelResult,
    p: { model: string; attempts: number; cost: number },
  ): Promise<void> {
    const { f, input, weight } = prep;
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
      model: p.model,
      attempts: p.attempts,
      cost: p.cost,
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
  }

  // ── пакетный режим (заход 9, ASSIST_LABEL_BATCH=1) ──────────────────

  /**
   * Тик пакетного режима: забрать готовые задания, затем отправить новое
   * одним заданием (резерв по каждому диалогу — оценка × доля цены).
   */
  private async batchTick(
    rows: Candidate[],
    res: LabelTickResult,
    p: { model: string; now: Date; deadline: number; max: number },
    scope?: CronScope,
  ): Promise<void> {
    const client = this.batch as LabelBatchClient;
    await this.collectBatches(client, res, p.now, scope);
    // Отправленные этим же тиком строки в выборку не попали (статус batch).
    const factor = labelBatchPriceFactor(this.env);
    const sites = new Map<string, SiteCtx>();
    const queued: Array<{
      c: Candidate;
      rsv: AnalyticsReservation;
      reqKey: string;
      est: number;
      weight: number;
      system: string;
      user: string;
    }> = [];
    for (const c of rows) {
      if (queued.length >= p.max || Date.now() > p.deadline) break;
      let ctx = sites.get(c.siteId);
      if (!ctx) {
        ctx = await this.siteCtx(c, p.now);
        sites.set(c.siteId, ctx);
      }
      if (!ctx.allowed || ctx.stopped) continue;
      try {
        const prep = await this.prepare(c, ctx, p.model);
        if (prep.kind === 'skipped') {
          res.skipped++;
          continue;
        }
        const est = Math.max(1, Math.ceil(prep.est * factor));
        const rsv = await this.budget.reserve(
          c.accountId,
          c.siteId,
          est,
          ctx.capMicroUsd,
          p.now,
        );
        if (rsv.result !== 'ok' || !rsv.reservation) {
          res.budgetStopped++;
          ctx.stopped = true;
          continue;
        }
        ctx.spentMicroUsd += est;
        queued.push({
          c,
          rsv: rsv.reservation,
          reqKey: c.id,
          est,
          weight: prep.weight,
          system: prep.prompt.system,
          user: prep.prompt.user,
        });
      } catch (e) {
        this.logger.warn(
          `разметка ${c.id} не подготовлена (${(e as Error | null)?.name ?? 'Error'})`,
        );
      }
    }
    if (!queued.length) return;
    // Аудит P3-6: строки «в пакете» пишутся ДО отправки (временное имя) —
    // сбой записи после отправки больше не может отправить диалог второй
    // раз; не принятое задание откатывает строки и возвращает резерв.
    const temp = `${LABEL_BATCH_TEMP_PREFIX}${randomUUID()}`;
    const written: typeof queued = [];
    const undo = async () => {
      for (const q of written) {
        await this.write(q.c, {
          status: 'retry',
          weight: q.weight,
          model: null,
          attempts: q.c.attempts ?? 0,
        });
      }
      for (const q of queued) await this.budget.settle(q.rsv, 0);
    };
    let name: string;
    try {
      for (const q of queued) {
        // Резерв — в costMicroUsd, момент резерва — labeledAt.
        await this.write(q.c, {
          status: 'batch',
          weight: q.weight,
          model: p.model,
          attempts: (q.c.attempts ?? 0) + 1,
          cost: q.est,
          batchJob: temp,
          at: p.now,
        });
        written.push(q);
      }
      name = await client.submit(
        p.model,
        queued.map((q) => ({
          key: q.reqKey,
          system: q.system,
          user: q.user,
          maxOutputTokens: LABEL_LIMITS.maxOutputTokens,
          // Резерв в ответе — снять его, даже если диалог удалят (forget,
          // ретенция) раньше, чем придёт ответ.
          meta: {
            a: q.c.accountId,
            s: q.c.siteId,
            e: String(q.est),
            t: p.now.toISOString(),
          },
        })),
      );
    } catch (e) {
      // Задание не принято — денег не взяли: строки назад в очередь,
      // резерв возвращается.
      await undo();
      this.logger.warn(
        `пакет разметки не отправлен (${(e as Error | null)?.name ?? 'Error'})`,
      );
      return;
    }
    await this.prisma.assistSiteConversationLabel.updateMany({
      where: { batchJob: temp, status: 'batch' },
      data: { batchJob: name },
    });
    res.batched += queued.length;
    this.logger.log(`пакет разметки ${name}: диалогов ${queued.length}`);
  }

  /** Готовые пакетные задания → разметка; просроченные/сбойные → retry. */
  private async collectBatches(
    client: LabelBatchClient,
    res: LabelTickResult,
    now: Date,
    scope?: CronScope,
  ): Promise<void> {
    const pending = await this.prisma.$queryRawUnsafe<
      Array<{ batchJob: string; startedAt: Date }>
    >(
      `SELECT "batchJob", min("labeledAt") AS "startedAt"
         FROM "sites"."assist_site_conversation_labels"
        WHERE "status" = 'batch' AND "batchJob" IS NOT NULL
          AND ($1::text[] IS NULL OR "siteId" = ANY($1::text[]))
        GROUP BY "batchJob" ORDER BY min("labeledAt") LIMIT $2`,
      scope ? scope.siteIds : null,
      LABEL_BATCH_POLLS_PER_TICK,
    );
    const factor = labelBatchPriceFactor(this.env);
    for (const job of pending) {
      const pollSafe = async (): Promise<LabelBatchPoll | null> => {
        try {
          return await client.poll(job.batchJob);
        } catch {
          return null;
        }
      };
      const temp = job.batchJob.startsWith(LABEL_BATCH_TEMP_PREFIX);
      const stale =
        now.getTime() - job.startedAt.getTime() > LABEL_BATCH_STALE_MS;
      // Временное имя (сбой между отправкой и записью имени): опросить нечего;
      // после срока — retry без возврата резерва (задание могло уйти).
      if (temp && !stale) continue;
      let poll: LabelBatchPoll | null = temp
        ? { state: 'ended', results: [] }
        : await pollSafe();
      if ((!poll || poll.state === 'pending') && stale) {
        // Просрочено (аудит P2-2): отменить и сверить состояние ещё раз.
        try {
          await client.cancel(job.batchJob);
        } catch {
          /* сверка ниже решит */
        }
        poll = await pollSafe();
        // Состояние неясно (всё ещё идёт / Google не ответил): резерв не
        // возвращаем — задание может доработать и быть оплачено.
        if (!poll || poll.state === 'pending') {
          poll = { state: 'ended', results: [] };
        }
      }
      if (!poll || poll.state === 'pending') continue;
      const rows = await this.batchRows(job.batchJob);
      const done = poll;
      const results = new Map(
        done.state === 'failed'
          ? []
          : done.results.map((r) => [r.key, r] as const),
      );
      // Без ответа резерв возвращается только при подтверждённом сбое или у
      // готового задания (запрос не попал в ответ — не оплачен).
      const refund = done.state !== 'ended';
      const sites = new Map<string, SiteCtx>();
      let broken = 0;
      for (const row of rows) {
        try {
          const out = await this.collectOne(
            row,
            results.get(row.c.id) ?? null,
            sites,
            factor,
            now,
            refund,
          );
          res[out]++;
        } catch (e) {
          broken++;
          this.logger.warn(
            `пакетная разметка ${row.c.id} не записана (${(e as Error | null)?.name ?? 'Error'})`,
          );
        }
      }
      // Ответы диалогов, удалённых до ответа (forget, ретенция): строки
      // разметки ушли каскадом, резерв — по метаданным запроса (аудит P3-6).
      // Только когда все строки задания закрыты: иначе задание опросят снова
      // и резерв закрылся бы дважды.
      if (broken || !results.size) continue;
      const alive = new Set(
        (
          await this.prisma.assistSiteConversationLabel.findMany({
            where: { conversationId: { in: [...results.keys()] } },
            select: { conversationId: true },
          })
        ).map((x) => x.conversationId),
      );
      for (const r of results.values()) {
        if (alive.has(r.key)) continue;
        try {
          await this.settleOrphan(r, factor);
        } catch (e) {
          this.logger.warn(
            `резерв удалённого диалога не закрыт (${(e as Error | null)?.name ?? 'Error'})`,
          );
        }
      }
    }
  }

  /** Резерв диалога, удалённого до ответа пакета: расход фактом × доля. */
  private async settleOrphan(
    r: LabelBatchResult,
    factor: number,
  ): Promise<void> {
    const m = r.meta ?? {};
    const est = Number(m.e);
    const at = new Date(m.t ?? '');
    if (!m.a || !m.s || !Number.isFinite(est) || Number.isNaN(at.getTime())) {
      return;
    }
    const model = analyticsModel(this.env);
    const price = model.ok
      ? estimateCost(
          model.model,
          {
            inputTokens: r.inputTokens,
            cachedInputTokens: r.cachedInputTokens,
            outputTokens: r.outputTokens,
          },
          this.env,
        ).costMicroUsd
      : est / factor;
    const cost = Math.round(price * factor);
    if (model.ok && (r.inputTokens || r.outputTokens)) {
      // Расход платформы виден и без диалога (сайт мог быть удалён — тогда
      // строки нет, резерв закрывается всё равно).
      await this.prisma.siteAiUsage
        .createMany({
          data: [
            {
              accountId: m.a,
              siteId: m.s,
              product: 'assist',
              provider: 'GEMINI',
              operation: 'assist-label',
              model: model.model,
              inputTokens: r.inputTokens,
              cachedInputTokens: r.cachedInputTokens,
              outputTokens: r.outputTokens,
              calls: 1,
              costMicroUsd: cost,
              pricingVersion: `batch${factor}`,
              unpriced: false,
            },
          ],
        })
        .catch(() => undefined);
    }
    await this.budget.settle(
      {
        accountId: m.a,
        siteId: m.s,
        period: analyticsPeriod(at),
        day: at.toISOString().slice(0, 10),
        est,
      },
      cost,
    );
  }

  private async batchRows(job: string): Promise<
    Array<{
      c: Candidate;
      model: string;
      reserved: number;
      reservedAt: Date;
      weight: number;
    }>
  > {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<
        Candidate & {
          model: string | null;
          reserved: number;
          reservedAt: Date;
          weight: number;
        }
      >
    >(
      `SELECT c."id", c."accountId", c."siteId", c."pageUrl", c."locale", c."voice",
              c."openedBy", c."visitHash", c."createdAt", l."attempts", a."analytics",
              a."siteSummary", l."model", l."costMicroUsd" AS reserved,
              l."labeledAt" AS "reservedAt", l."weight"
         FROM "sites"."assist_site_conversation_labels" l
         JOIN "sites"."assist_site_conversations" c ON c."id" = l."conversationId"
         JOIN "sites"."assist_sites" a ON a."siteId" = c."siteId"
        WHERE l."status" = 'batch' AND l."batchJob" = $1`,
      job,
    );
    return rows.map((r) => ({
      c: r,
      model: r.model ?? '',
      reserved: Number(r.reserved),
      reservedAt: r.reservedAt,
      weight: Number(r.weight),
    }));
  }

  private async collectOne(
    row: {
      c: Candidate;
      model: string;
      reserved: number;
      reservedAt: Date;
      weight: number;
    },
    result: LabelBatchResult | null,
    sites: Map<string, SiteCtx>,
    factor: number,
    now: Date,
    refund: boolean,
  ): Promise<'labeled' | 'failed' | 'retry'> {
    const { c } = row;
    const rsv: AnalyticsReservation = {
      accountId: c.accountId,
      siteId: c.siteId,
      period: analyticsPeriod(row.reservedAt),
      day: row.reservedAt.toISOString().slice(0, 10),
      est: row.reserved,
    };
    const attempts = c.attempts ?? 1;
    const giveUp = attempts >= LABEL_MAX_ATTEMPTS ? 'failed' : 'retry';
    let cost = 0;
    if (result) {
      // Расход по факту токенов × доля цены пакета (ПРОВЕРИТЬ у Google).
      const est = estimateCost(
        row.model,
        {
          inputTokens: result.inputTokens,
          cachedInputTokens: result.cachedInputTokens,
          outputTokens: result.outputTokens,
        },
        this.env,
      );
      cost = Math.round(est.costMicroUsd * factor);
      if (result.inputTokens || result.outputTokens) {
        await this.prisma.siteAiUsage.createMany({
          data: [
            {
              accountId: c.accountId,
              siteId: c.siteId,
              product: 'assist',
              provider: 'GEMINI',
              operation: 'assist-label',
              model: row.model,
              inputTokens: result.inputTokens,
              cachedInputTokens: result.cachedInputTokens,
              outputTokens: result.outputTokens,
              calls: 1,
              costMicroUsd: cost,
              pricingVersion: `${est.pricingVersion}+batch${factor}`,
              unpriced: est.unpriced,
            },
          ],
        });
      }
    }
    // Резерв → факт. Нет ответа: подтверждённый сбой — возврат (денег не
    // взяли); неясно (отменено/истекло) — резерв остаётся расходом.
    if (result || refund) await this.budget.settle(rsv, cost);
    if (!result || result.text === null) {
      await this.write(c, {
        status: giveUp,
        weight: row.weight,
        model: row.model,
        attempts,
        cost,
      });
      return giveUp === 'failed' ? 'failed' : 'retry';
    }
    let ctx = sites.get(c.siteId);
    if (!ctx) {
      ctx = await this.siteCtx(c, now);
      sites.set(c.siteId, ctx);
    }
    // Вход — тот же, что ушёл в пакет (проверка ответа сверяет словарь и темы).
    const prep = await this.prepare(c, { ...ctx, capMicroUsd: 0 }, row.model);
    if (prep.kind === 'skipped') return 'retry';
    const parsed = parseLabel(result.text, prep.input);
    if (!parsed.ok) {
      // Невалидный ответ: следующий тик отправит диалог ещё раз (≤ 3 попыток).
      await this.write(c, {
        status: giveUp,
        weight: row.weight,
        model: row.model,
        attempts,
        cost,
      });
      return giveUp === 'failed' ? 'failed' : 'retry';
    }
    await this.complete(c, ctx, { ...prep, weight: row.weight }, parsed.label, {
      model: row.model,
      attempts,
      cost,
    });
    return 'labeled';
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
      /** Пакетное задание (статус `batch`); иначе снимается. */
      batchJob?: string;
      /** Время записи (пакет: момент резерва — период и сутки бюджета). */
      at?: Date;
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
      batchJob: p.batchJob ?? null,
      labeledAt: p.at ?? this.now(),
    };
    // «Связан с визитом» (Р-З9-26): флаг переживает обнуление visitHash
    // диалога через 31 день — калибровка читает его. Снять флаг повторная
    // разметка не может (хеш мог уже обнулиться).
    const linked = c.visitHash !== null;
    await this.prisma.assistSiteConversationLabel.upsert({
      where: { conversationId: c.id },
      create: {
        conversationId: c.id,
        accountId: c.accountId,
        siteId: c.siteId,
        ...data,
        linked,
      },
      // Исправление человека (humanOverride) не затирается повторной разметкой.
      update: linked ? { ...data, linked } : data,
    });
  }
}
