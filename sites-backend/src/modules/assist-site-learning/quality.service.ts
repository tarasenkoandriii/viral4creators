/**
 * Вкладка «Качество» и прогоны — L (§4-тер.8, §4-тер.11, §4-тер.13, §9.1
 * метрики обучаемости; №31 симуляция). Прогон набора сайта (golden +
 * «вне знаний» + автокейсы Э1 + инвариантный поднабор) — из бюджета
 * обучения (`LearningBudget` site-ai, операция `assist-eval`); исчерпан —
 * `deferred` с уведомлением, ворота и исключения работают (§4-тер.15 п.13).
 * Симуляция — 10 персонажей (вопросы платформы на языках сайта) через
 * SiteKnowledgeService.search + AnswerEngine (как мастер Э2), без записи в
 * диалоги посетителей.
 *
 * Уточнения реализации (L):
 *  - резерв бюджета — на весь прогон сразу (оценка × кейсы), после — поправка
 *    на факт; не помещается — ни одного вызова модели;
 *  - отложенный плановый прогон пишется строкой assist_site_eval_runs
 *    (`report.deferred = true`, без модели) — по ней сводка (A) видит
 *    «eval отложен», а уведомление в бот уходит ОДИН раз за период бюджета;
 *  - вердикт кейса — детерминированный, как judgeSiteCase W3 (mustNotSay,
 *    mustCite по URL источника, с эталоном — ответ, без эталона — отказ);
 *    инварианты — judgeInvariant Э1;
 *  - «Качество» по неделям (§9.1): диалоги недели; доля диалогов с
 *    `unknown`-сигналом; 👍 / (👍 + 👎) (нет оценок — null); доля диалогов с
 *    передачей человеку, кроме отменённых посетителем.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LEARNING_DEFAULTS } from '../../config/assist-defaults';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { estimateCost } from '../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import {
  AnswerEngine,
  type AnswerRequest,
  type AnswerResult,
} from '../assist-knowledge-core/answer/answer-engine';
import { questionLang } from '../assist-knowledge-core/answer/prompt';
import { INVARIANT_CASES } from '../assist-knowledge-core/eval/invariant-cases';
import { judgeInvariant } from '../assist-knowledge-core/eval/invariant-eval';
import {
  recipients,
  sendToMembers,
  type BotNotifyEnv,
  type FetchLike,
} from '../assist-knowledge-core/notify';
import { SiteKnowledgeService } from '../assist-site-knowledge/site-knowledge.service';
import { SiteWizardService } from '../assist-site-knowledge/wizard/site-wizard.service';
import { budgetPeriod, LearningBudget } from '../site-ai/learning-budget';
import {
  GeminiText,
  spentOf,
  type TextModelSpent,
} from '../site-ai/text-model';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import {
  REQUIRE_ASSIST_MANAGER,
  satisfiesProductRoles,
  type AccountMembership,
} from '../site-core/account/roles';
import { notFoundSite } from '../site-core/site-core.constants';
import type {
  EvalFailureView,
  EvalRunResult,
  QualityView,
  SimulationView,
} from './api-types';
import { requireManager, stripSourceMarkers } from './learning-common';
import { SIM_GAVE_IN, SIM_PERSONAS, type SimLang } from './simulation-personas';

/** Кейсов сайта в одном прогоне (до тарифов Э4 — как Start/Business, §4-тер.11). */
export const EVAL_SITE_CASES = 30;
/** Провалов в отчёте прогона. */
export const EVAL_REPORT_FAILURES = 20;
/** Оценка одного ответа (≈ 3k вх. + 300 вых., §4-тер.11 «≈ $0.0093»). */
export const EVAL_ANSWER_UNITS = { inputTokens: 3_500, outputTokens: 300 };

export interface EvalCaseRow {
  id: string;
  kind: string;
  question: string;
  expected: string | null;
  mustCite: string[];
  mustNotSay: string[];
  lang: string | null;
}

/** Почему ответ провалил кейс сайта (null — прошёл). Детерминированно. */
export function judgeEvalCase(
  c: Pick<EvalCaseRow, 'expected' | 'mustCite' | 'mustNotSay'>,
  a: Pick<AnswerResult, 'text' | 'refused' | 'sources'>,
): string | null {
  const text = a.text.toLowerCase();
  const bad = c.mustNotSay.find((s) => s && text.includes(s.toLowerCase()));
  if (bad) return `в ответе запрещённое «${bad}»`;
  if (c.expected) {
    if (a.refused) return 'отказ вместо ответа';
    if (
      c.mustCite.length &&
      !a.sources.some((s) => s.url && c.mustCite.includes(s.url))
    ) {
      return 'нет ссылки на нужный источник';
    }
    return null;
  }
  return a.refused ? null : 'нет честного отказа (вопрос вне знаний)';
}

export function evalAnswerEstimate(): number {
  return estimateCost(GEMINI_MODEL, EVAL_ANSWER_UNITS).costMicroUsd;
}

/** Язык базы сайта для симуляции: uk/ru/en, иначе uk. */
function simLang(v: string | null | undefined): SimLang {
  const l = (v ?? '').slice(0, 2).toLowerCase();
  return l === 'ru' || l === 'en' ? l : 'uk';
}

@Injectable()
export class LearningQualityService {
  now: () => Date = () => new Date();
  /** Уведомления в бот — env и fetch подменяют тесты. */
  env?: BotNotifyEnv;
  fetchImpl?: FetchLike;
  private readonly logger = new Logger(LearningQualityService.name);
  private readonly wizard: SiteWizardService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    private readonly knowledge: SiteKnowledgeService,
    private readonly answers: AnswerEngine,
    private readonly usage: AiUsageRecorder,
    private readonly budget: LearningBudget,
    @Optional() text?: GeminiText,
  ) {
    // Полнота знаний — ТОТ ЖЕ расчёт, что у мастера Э2 (QualityView.completeness).
    this.wizard = new SiteWizardService(
      prisma,
      sitesDb,
      knowledge,
      answers,
      text ?? new GeminiText(),
      usage,
      budget,
    );
  }

  private db(accountId: string) {
    return this.sitesDb.forAccount(accountId);
  }

  private async requireSite(accountId: string, siteId: string) {
    const site = await this.db(accountId).site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw notFoundSite();
  }

  // ── «Качество» ──────────────────────────────────────────────────────

  async quality(m: AccountMembership, siteId: string): Promise<QualityView> {
    requireManager(m);
    await this.requireSite(m.accountId, siteId);
    const t = this.db(m.accountId);
    const now = this.now();
    const [completeness, runs, budget, needsReview, weekly, lastScheduled] =
      await Promise.all([
        this.wizard.completeness(m, siteId),
        t.assistSiteEvalRun.findMany({
          where: { siteId, kind: { in: ['scheduled', 'manual'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
        }),
        this.budget.status(m.accountId, siteId),
        t.assistSiteFaq.count({ where: { siteId, status: 'needs_review' } }),
        this.weekly(m.accountId, siteId, now),
        this.lastScheduledRun(m.accountId, siteId),
      ]);
    const last = runs.find((r) => !isDeferred(r.report));
    return {
      completeness: {
        covered: completeness.topics.covered,
        total: completeness.topics.total,
      },
      lastEval: last
        ? {
            id: last.id,
            kind: last.kind,
            at: last.createdAt.toISOString(),
            passed: last.passed,
            failed: last.failed,
            stale: last.stale,
            failures: reportFailures(last.report),
          }
        : null,
      weekly,
      learningBudget: {
        spentMicroUsd: budget.spentMicroUsd,
        capMicroUsd: budget.capMicroUsd,
        period: budget.period,
      },
      nextScheduledEvalAt: nextScheduledAt(lastScheduled, now).toISOString(),
      goldenNeedsReview: needsReview,
    };
  }

  /** Последний ПРОВЕДЁННЫЙ плановый прогон (отложенные — не в счёт). */
  async lastScheduledRun(
    accountId: string,
    siteId: string,
  ): Promise<Date | null> {
    const runs = await this.db(accountId).assistSiteEvalRun.findMany({
      where: { siteId, kind: 'scheduled' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true, report: true },
      take: 40,
    });
    return runs.find((r) => !isDeferred(r.report))?.createdAt ?? null;
  }

  private async weekly(
    accountId: string,
    siteId: string,
    now: Date,
  ): Promise<QualityView['weekly']> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        ws: string;
        dialogs: number;
        unknown: number;
        up: number;
        rated: number;
        handoffs: number;
      }>
    >(
      `WITH w AS (
         SELECT generate_series(
                  date_trunc('week', $3::timestamp) - interval '7 weeks',
                  date_trunc('week', $3::timestamp),
                  interval '1 week') AS ws)
       SELECT to_char(w.ws, 'YYYY-MM-DD') AS ws,
         (SELECT count(*)::int FROM "sites"."assist_site_conversations" c
           WHERE c."siteId" = $1 AND c."accountId" = $2
             AND c."createdAt" >= w.ws AND c."createdAt" < w.ws + interval '1 week') AS dialogs,
         (SELECT count(DISTINCT i."conversationId")::int FROM "sites"."assist_site_learning_items" i
           WHERE i."siteId" = $1 AND i."accountId" = $2 AND i."kind" = 'unknown'
             AND i."createdAt" >= w.ws AND i."createdAt" < w.ws + interval '1 week') AS unknown,
         (SELECT count(*)::int FROM "sites"."assist_site_messages" m
           WHERE m."siteId" = $1 AND m."accountId" = $2 AND m."rating" = 1
             AND m."createdAt" >= w.ws AND m."createdAt" < w.ws + interval '1 week') AS up,
         (SELECT count(*)::int FROM "sites"."assist_site_messages" m
           WHERE m."siteId" = $1 AND m."accountId" = $2 AND m."rating" IS NOT NULL
             AND m."createdAt" >= w.ws AND m."createdAt" < w.ws + interval '1 week') AS rated,
         (SELECT count(DISTINCT h."conversationId")::int FROM "sites"."assist_site_handoffs" h
           WHERE h."siteId" = $1 AND h."accountId" = $2 AND h."state" <> 'cancelled'
             AND h."requestedAt" >= w.ws AND h."requestedAt" < w.ws + interval '1 week') AS handoffs
       FROM w ORDER BY w.ws`,
      siteId,
      accountId,
      now.toISOString(),
    );
    const share = (a: number, b: number) =>
      b > 0 ? Math.round((a / b) * 1000) / 1000 : 0;
    return rows.map((r) => ({
      weekStart: r.ws,
      dialogs: r.dialogs,
      unknownShare: share(r.unknown, r.dialogs),
      thumbsUpShare: r.rated > 0 ? share(r.up, r.rated) : null,
      handoffShare: share(r.handoffs, r.dialogs),
    }));
  }

  // ── прогон eval ─────────────────────────────────────────────────────

  async runEval(
    m: AccountMembership | null,
    siteId: string,
    kind: 'manual' | 'scheduled',
  ): Promise<EvalRunResult> {
    if (kind === 'manual' && !m) {
      throw new Error('runEval(manual): нужен участник кабинета');
    }
    if (m) requireManager(m);
    const accountId = m
      ? m.accountId
      : (
          await this.sitesDb
            .system('плановый eval крона: кабинет по siteId')
            .assistSite.findFirst({
              where: { siteId },
              select: { accountId: true },
            })
        )?.accountId;
    if (!accountId) throw notFoundSite();
    await this.requireSite(accountId, siteId);
    const t = this.db(accountId);
    const a = await t.assistSite.findFirst({
      where: { siteId },
      select: { knowledgeVersion: true },
    });
    const [cases, stale] = await Promise.all([
      t.assistSiteEvalCase.findMany({
        where: { siteId, status: 'active' },
        // Сначала проверенные ответы и «вне знаний» (обучение), потом автокейсы.
        orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: EVAL_SITE_CASES,
        select: {
          id: true,
          kind: true,
          question: true,
          expected: true,
          mustCite: true,
          mustNotSay: true,
          lang: true,
        },
      }) as Promise<EvalCaseRow[]>,
      t.assistSiteEvalCase.count({ where: { siteId, status: 'stale' } }),
    ]);
    const est = evalAnswerEstimate() * (cases.length + INVARIANT_CASES.length);
    if (!(await this.budget.reserve(accountId, siteId, est))) {
      if (kind === 'scheduled') await this.deferScheduled(accountId, siteId);
      return { status: 'deferred', reason: 'budget' };
    }
    let spent = 0;
    let model = '';
    let passed = 0;
    let failed = 0;
    const failures: EvalFailureView[] = [];
    const ask = async (question: string, lang: string | null) => {
      const hits = (
        await this.knowledge.search({
          siteId,
          query: question,
          includeUgc: false,
        })
      ).filter((h) => !h.ugc);
      return this.evalAnswer(
        accountId,
        siteId,
        { question, hits, lang: lang ?? questionLang(question, null) },
        (m, cost) => {
          model = m;
          spent += cost;
        },
      );
    };
    const fail = (f: EvalFailureView) => {
      failed++;
      if (failures.length < EVAL_REPORT_FAILURES) failures.push(f);
    };
    try {
      for (const c of cases) {
        const r = await ask(c.question, c.lang);
        const reason = judgeEvalCase(c, r);
        if (reason) {
          fail({
            question: c.question,
            expected: c.expected,
            got: stripSourceMarkers(r.text).slice(0, 300),
            reason,
          });
        } else passed++;
      }
      for (const c of INVARIANT_CASES) {
        const r = await ask(c.question, null);
        const reason = judgeInvariant(c, r);
        if (reason) {
          fail({
            question: c.question,
            expected: null,
            got: stripSourceMarkers(r.text).slice(0, 300),
            reason: `инвариант платформы: ${reason}`,
          });
        } else passed++;
      }
    } finally {
      await this.budget
        .adjust(accountId, siteId, spent - est)
        .catch(() => undefined);
    }
    const run = await t.assistSiteEvalRun.create({
      data: {
        accountId,
        siteId,
        kind,
        knowledgeVersion: a?.knowledgeVersion ?? null,
        model: model || GEMINI_MODEL,
        passed,
        failed,
        stale,
        report: { failures } as unknown as Prisma.InputJsonValue,
        costMicroUsd: Math.round(spent),
      },
      select: { id: true },
    });
    return { status: 'done', runId: run.id, passed, failed, stale };
  }

  /**
   * Ответ движка для проверки/симуляции с учётом `assist-eval`: у ответа —
   * его токены; сбой empty/truncated оплачен (провайдер ответил) — тот же
   * учёт, а ошибка пробрасывается как была (сбой записи её не подменяет).
   */
  private async evalAnswer(
    accountId: string,
    siteId: string,
    req: AnswerRequest,
    spend: (model: string, costMicroUsd: number) => void,
  ): Promise<AnswerResult> {
    const record = async (r: TextModelSpent) => {
      const u = await this.usage.record(this.db(accountId), {
        accountId,
        siteId,
        operation: 'assist-eval',
        model: r.model,
        units: {
          inputTokens: r.inputTokens,
          cachedInputTokens: r.cachedInputTokens,
          outputTokens: r.outputTokens,
        },
      });
      spend(r.model, u.costMicroUsd);
    };
    let r: AnswerResult;
    try {
      r = await this.answers.answer(req);
    } catch (e) {
      const paid = spentOf(e);
      if (paid) await record(paid).catch(() => undefined);
      throw e;
    }
    if (r.model) await record(r);
    return r;
  }

  /**
   * Плановый прогон не поместился в бюджет: строка «отложено» и — один раз
   * за период бюджета — сообщение владельцу и менеджерам (§4-тер.11).
   */
  private async deferScheduled(accountId: string, siteId: string) {
    const t = this.db(accountId);
    const period = budgetPeriod(this.now());
    const since = new Date(`${period}-01T00:00:00.000Z`);
    const already = await t.assistSiteEvalRun.findMany({
      where: { siteId, kind: 'scheduled', createdAt: { gte: since } },
      select: { report: true },
    });
    const notified = already.some((r) => isDeferred(r.report));
    await t.assistSiteEvalRun.create({
      data: {
        accountId,
        siteId,
        kind: 'scheduled',
        model: '',
        report: {
          deferred: true,
          reason: 'budget',
          period,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    if (notified) return;
    try {
      const chatIds = await recipients(this.sitesDb, accountId, (mm) =>
        satisfiesProductRoles(mm, REQUIRE_ASSIST_MANAGER),
      );
      await sendToMembers({
        chatIds,
        text: 'Плановая проверка качества помощника отложена: бюджет обучения сайта на этот месяц исчерпан. Ответы посетителям, публикация знаний и исключения работают как обычно; проверка пройдёт в следующем месяце или после ручного запуска.',
        button: {
          text: 'Открыть «Качество»',
          hashPath: `/sites/${siteId}/learning/site/quality`,
        },
        env: this.env,
        fetchImpl: this.fetchImpl,
      });
    } catch (e) {
      this.logger.warn(
        `уведомление об отложенном eval не отправлено (site ${siteId}): ${(e as Error | null)?.name ?? 'Error'}`,
      );
    }
  }

  // ── симуляция №31 ───────────────────────────────────────────────────

  async simulate(
    m: AccountMembership,
    siteId: string,
  ): Promise<SimulationView> {
    requireManager(m);
    await this.requireSite(m.accountId, siteId);
    const personas = SIM_PERSONAS.slice(
      0,
      LEARNING_DEFAULTS.simulationPersonas,
    );
    const turns = LEARNING_DEFAULTS.simulationTurns;
    const est = evalAnswerEstimate() * personas.length * turns;
    if (!(await this.budget.reserve(m.accountId, siteId, est))) {
      return { status: 'deferred', reason: 'budget', personas: [] };
    }
    const lang = simLang(await this.knowledgeLang(m.accountId, siteId));
    let spent = 0;
    const out: SimulationView['personas'] = [];
    try {
      for (const p of personas) {
        const view: SimulationView['personas'][number] = {
          key: p.key,
          title: p.title[lang],
          turns: [],
          issues: [],
        };
        for (const turn of p.turns.slice(0, turns)) {
          const question = turn.q[lang];
          const hits = (
            await this.knowledge.search({
              siteId,
              query: question,
              includeUgc: false,
            })
          ).filter((h) => !h.ugc);
          const r = await this.evalAnswer(
            m.accountId,
            siteId,
            { question, hits, lang: questionLang(question, null) },
            (_model, cost) => {
              spent += cost;
            },
          );
          const answer = stripSourceMarkers(r.text);
          view.turns.push({
            question,
            answer,
            sources: r.sources.map((s) => ({
              n: s.n,
              url: s.url,
              title: s.title,
            })),
            refused: r.refused,
          });
          view.issues.push(...simIssues(turn.expect, question, answer, r));
        }
        out.push(view);
      }
    } finally {
      await this.budget
        .adjust(m.accountId, siteId, spent - est)
        .catch(() => undefined);
    }
    return { status: 'done', reason: null, personas: out };
  }

  /** Преобладающий язык опубликованной версии (по фрагментам). */
  private async knowledgeLang(
    accountId: string,
    siteId: string,
  ): Promise<string | null> {
    const t = this.db(accountId);
    const a = await t.assistSite.findFirst({
      where: { siteId },
      select: { knowledgeVersion: true },
    });
    if (!a?.knowledgeVersion) return null;
    const g = await t.assistSiteChunk.groupBy({
      by: ['lang'],
      where: {
        siteId,
        versions: { has: a.knowledgeVersion },
        quarantined: false,
      },
      _count: { _all: true },
    });
    const top = g
      .filter((x) => x.lang)
      .sort((x, y) => y._count._all - x._count._all)[0];
    return top?.lang ?? null;
  }
}

/** Что насторожило код в ответе симуляции (тексты — владельцу). */
export function simIssues(
  expect: 'answer' | 'refuse' | 'any',
  question: string,
  answer: string,
  r: Pick<AnswerResult, 'refused' | 'sources' | 'flags'>,
): string[] {
  const out: string[] = [];
  const q = `«${question}»`;
  const lower = answer.toLowerCase();
  if (expect === 'answer' && r.refused) {
    out.push(`Нет ответа на ${q} — добавьте проверенный ответ или документ`);
  }
  if (expect === 'refuse' && !r.refused) {
    out.push(`Ответил на ${q}, хотя должен был вежливо отказать`);
  }
  if (!r.refused && r.sources.length === 0) {
    out.push(`Ответ на ${q} без источника`);
  }
  if (r.flags?.includes('unsupported_number')) {
    out.push(`В ответе на ${q} было число, которого нет на сайте`);
  }
  if (r.flags?.includes('forbidden_promise')) {
    out.push(`В ответе на ${q} — обещание, которое помощник давать не должен`);
  }
  if (SIM_GAVE_IN.some((s) => lower.includes(s))) {
    out.push(`Похоже, помощник поддался на провокацию ${q}`);
  }
  return out;
}

export function isDeferred(report: Prisma.JsonValue | null): boolean {
  return (
    !!report &&
    typeof report === 'object' &&
    !Array.isArray(report) &&
    (report as Record<string, unknown>).deferred === true
  );
}

function reportFailures(report: Prisma.JsonValue | null): EvalFailureView[] {
  const list =
    report && typeof report === 'object' && !Array.isArray(report)
      ? (report as Record<string, unknown>).failures
      : null;
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      question: String(x.question ?? ''),
      expected: typeof x.expected === 'string' ? x.expected : null,
      got: String(x.got ?? ''),
      reason: String(x.reason ?? ''),
    }));
}

/**
 * Следующий плановый прогон: через месяц после последнего проведённого
 * (Р-36, до Э4 — Start); не было — ближайший прогон крона (05:20 UTC).
 */
export function nextScheduledAt(last: Date | null, now: Date): Date {
  if (last) {
    const due = new Date(
      last.getTime() + LEARNING_DEFAULTS.scheduledEvalEveryMs,
    );
    if (due.getTime() > now.getTime()) return due;
  }
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 20),
  );
  if (next.getTime() <= now.getTime())
    next.setTime(next.getTime() + 24 * 3600_000);
  return next;
}
