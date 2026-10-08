/**
 * Разметка диалогов сотрудников «Админки» (заход 10, №57; ТЗ §5-тер.13) —
 * системный код крона `assist-admin-embed-run` (Vercel Hobby — без нового
 * крона). Диалог «закрыт», когда его уже нельзя продолжить (8 ч тишины —
 * `ADMIN_CONVERSATION_IDLE_MS` чата сотрудника): разметка не устаревает от
 * продолжения того же разговора.
 *
 * Деньги — РЕЗЕРВ ДО вызова модели (`reserveAdminTurn`, суточный потолок
 * «Админки» сайта и общий потолок платформы — одна транзакция под
 * блокировкой строки дня), но разметке достаётся не больше
 * `ADMIN_ANALYTICS_CAP_SHARE` потолка сайта: остальное — ответам
 * сотрудникам. Отказ резерва — сайт пропускается до следующего тика
 * (разметка подождёт, ответы сотрудникам — нет). Факт — `site_ai_usage`
 * операцией `assist-admin-label` (признак режима — имя операции, без
 * текста), затем `settleAdminTurn`.
 *
 * Невалидный ответ — одна повторная попытка, затем `failed` (строка есть —
 * диалог больше не берётся; «нашёл ли ответ» — по коду). Модель недоступна
 * (timeout/unavailable, денег не взяли) — тик останавливается, диалог ждёт.
 *
 * Аудит захода 10: подготовка не удалась (маска, вторая линия) — метка
 * `failed` по коду без модели и денег; сбой одного диалога (база) — диалог
 * пропускается, тик идёт дальше; таймаут модели — не дольше остатка тика.
 * Резерв `admin/<siteId>` без TTL (как Р-З9-15): если функцию убили между
 * резервом и снятием, оценка (≤ ~2 м$) остаётся в строке ДНЯ — потолок этих
 * UTC-суток только строже, а не мягче; новые сутки — новая строка. Таймаут
 * вызова ≤ остатка тика делает такой исход редким.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  effectivePlatformCapMicroUsd,
  readWidgetPlatformSettings,
} from '../../common/platform-settings';
import { widgetPlatformDailyCapMicroUsd } from '../../config/widget-env';
import { readState } from '../assist-billing/public/entitlements';
import { ASSIST_PLANS, siteDailyCapFromPlan } from '../assist-billing/plans';
import {
  reserveAdminTurn,
  settleAdminTurn,
} from '../assist-admin-mode/admin-budget';
import {
  GeminiText,
  TextModelError,
  spentOf,
  type TextModelSpent,
} from '../site-ai/text-model';
import {
  ADMIN_LABEL_OPERATION,
  adminAnalyticsCap,
  adminLabelEstimateMicroUsd,
  adminLiteModel,
} from './admin-analytics-env';
import {
  ADMIN_LABEL_PROMPT_VERSION,
  type AdminLabelInput,
  type AdminLabelResult,
  answerFoundByCode,
  buildAdminLabelPrompt,
  maskAdminTurn,
  parseAdminLabel,
} from './admin-label-schema';
import { recordAdminUsage } from './admin-usage';

/** Диалог закрыт: 8 ч тишины (= ADMIN_CONVERSATION_IDLE_MS чата сотрудника). */
export const ADMIN_LABEL_CLOSED_MS = 8 * 60 * 60 * 1000;
/** Старше — не размечаем (ретенция диалогов; отчётам не нужно). */
export const ADMIN_LABEL_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 120;
/** Таймаут одного вызова разметки (lite-модель, ответ ~100 токенов). */
export const ADMIN_LABEL_CALL_TIMEOUT_MS = 15_000;
/** Меньше этого остатка тика вызов не начинается. */
export const ADMIN_LABEL_MIN_CALL_MS = 3_000;
/** Запас до срока тика на запись расхода, метки и снятие резерва. */
const ADMIN_LABEL_CALL_MARGIN_MS = 1_000;

export interface AdminLabelTickResult {
  model: 'unset' | 'unpriced' | null;
  labeled: number;
  failed: number;
  budgetDenied: number;
  /** Диалоги, на которых тик споткнулся (база и т. п.) — пропущены. */
  errors: number;
  stopped: boolean;
}

interface Candidate {
  id: string;
  accountId: string;
  siteId: string;
  employeeRole: string | null;
  createdAt: Date;
}

interface SiteCaps {
  site: number;
  platform: number;
}

@Injectable()
export class AdminLabeler {
  private readonly logger = new Logger(AdminLabeler.name);
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    private readonly text: GeminiText,
  ) {}

  async tick(p: {
    now: Date;
    deadline: number;
    max: number;
    siteIds?: string[] | null;
  }): Promise<AdminLabelTickResult> {
    const out: AdminLabelTickResult = {
      model: null,
      labeled: 0,
      failed: 0,
      budgetDenied: 0,
      errors: 0,
      stopped: false,
    };
    const lite = adminLiteModel(this.env);
    if (!lite.ok) {
      out.model = lite.reason;
      return out;
    }
    const candidates = await this.prisma.$queryRawUnsafe<Candidate[]>(
      `SELECT c."id", c."accountId", c."siteId", c."employeeRole", c."createdAt"
         FROM "sites"."assist_admin_conversations" c
         JOIN "sites"."assist_admin_settings" s
           ON s."siteId" = c."siteId" AND s."accountId" = c."accountId"
        WHERE s."adminModeEnabled" AND s."analyticsLabeling"
          AND c."lastActivityAt" < $1 AND c."lastActivityAt" >= $2
          AND ($4::text[] IS NULL OR c."siteId" = ANY($4::text[]))
          AND NOT EXISTS (SELECT 1 FROM "sites"."assist_admin_conversation_labels" l
                           WHERE l."conversationId" = c."id")
          AND EXISTS (SELECT 1 FROM "sites"."assist_admin_messages" m
                       WHERE m."conversationId" = c."id" AND m."role" = 'employee')
        ORDER BY c."lastActivityAt" ASC
        LIMIT $3`,
      new Date(p.now.getTime() - ADMIN_LABEL_CLOSED_MS),
      new Date(p.now.getTime() - ADMIN_LABEL_LOOKBACK_MS),
      Math.max(1, p.max),
      p.siteIds ?? null,
    );
    const caps = new Map<string, SiteCaps | null>();
    const denied = new Set<string>();
    let platform: number | null = null;
    for (const c of candidates) {
      if (Date.now() >= p.deadline) break;
      if (denied.has(c.siteId)) continue;
      if (!caps.has(c.siteId)) {
        platform ??= effectivePlatformCapMicroUsd(
          widgetPlatformDailyCapMicroUsd(this.env),
          await readWidgetPlatformSettings(this.prisma),
        );
        caps.set(c.siteId, await this.capsOf(c.accountId, platform, p.now));
      }
      const cap = caps.get(c.siteId);
      if (!cap) {
        denied.add(c.siteId);
        continue;
      }
      let r: 'ok' | 'failed' | 'budget' | 'stop';
      try {
        r = await this.labelOne(c, cap, lite.model, p.now, p.deadline);
      } catch (e) {
        // Сбой одного диалога (база, запись расхода) не останавливает
        // разметку остальных (аудит захода 10, P1-1).
        this.logger.warn(
          `разметка «Админки» ${c.id}: ${(e as Error | null)?.name ?? 'Error'}`,
        );
        out.errors++;
        continue;
      }
      if (r === 'ok') out.labeled++;
      else if (r === 'failed') out.failed++;
      else if (r === 'budget') {
        out.budgetDenied++;
        denied.add(c.siteId);
      } else {
        out.stopped = true;
        break;
      }
    }
    return out;
  }

  /** Потолки сайта: доля суточного потолка «Админки»; без тарифа — null. */
  private async capsOf(
    accountId: string,
    platform: number,
    now: Date,
  ): Promise<SiteCaps | null> {
    const st = await readState(this.prisma, accountId, now);
    if (!st.planId || !ASSIST_PLANS[st.planId].adminRead) return null;
    const site = adminAnalyticsCap(siteDailyCapFromPlan(st.planId));
    return site > 0 ? { site, platform } : null;
  }

  private async input(c: Candidate): Promise<AdminLabelInput> {
    const db = this.sitesDb.forAccount(c.accountId);
    const msgs = await db.assistAdminMessage.findMany({
      where: { conversationId: c.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { role: true, text: true, answerPath: true, tools: true },
    });
    const answers = msgs.filter((m) => m.role === 'assistant');
    let toolErrors = 0;
    for (const a of answers) {
      if (a.answerPath === 'error') toolErrors++;
      if (Array.isArray(a.tools)) {
        for (const t of a.tools as Array<{ outcome?: unknown }>) {
          if (t && typeof t === 'object' && t.outcome !== 'ok') toolErrors++;
        }
      }
    }
    const proposals = await db.assistAdminActionProposal.count({
      where: { conversationId: c.id },
    });
    return {
      turns: msgs.map((m) => ({
        role: m.role === 'employee' ? 'employee' : 'assistant',
        text: maskAdminTurn(m.text),
      })),
      facts: {
        answers: answers.length,
        refused: answers.filter((a) => a.answerPath === 'refused').length,
        toolErrors,
        proposals,
      },
    };
  }

  private record(c: Candidate, out: TextModelSpent): Promise<number> {
    return recordAdminUsage(this.sitesDb, this.env, {
      accountId: c.accountId,
      siteId: c.siteId,
      operation: ADMIN_LABEL_OPERATION,
      spent: out,
    });
  }

  private async labelOne(
    c: Candidate,
    cap: SiteCaps,
    model: string,
    now: Date,
    deadline: number,
  ): Promise<'ok' | 'failed' | 'budget' | 'stop'> {
    const input = await this.input(c);
    let prompt: { system: string; user: string };
    try {
      prompt = buildAdminLabelPrompt(input);
    } catch (e) {
      // Подготовка не удалась (вторая линия маски и т. п.): метка `failed`
      // по фактам кода — без модели и без денег; диалог больше не берётся,
      // очередь идёт дальше (аудит захода 10, P1-1).
      this.logger.warn(
        `разметка «Админки» ${c.id}: подготовка — ${(e as Error | null)?.name ?? 'Error'}`,
      );
      await this.write(c, model, null, input, 0);
      return 'failed';
    }
    let cost = 0;
    let label: AdminLabelResult | null = null;
    // Невалидный ответ — ОДНА повторная попытка; каждая — свой резерв.
    for (let call = 0; call < 2 && !label; call++) {
      // Срок тика учитывает длительность вызова: таймаут модели — не дольше
      // остатка (функция Vercel не убивается посреди вызова с резервом).
      const left = deadline - Date.now() - ADMIN_LABEL_CALL_MARGIN_MS;
      if (left < ADMIN_LABEL_MIN_CALL_MS) {
        // Повтор не успевает — без метки: диалог вернётся в следующий тик.
        return 'stop';
      }
      const rsv = await reserveAdminTurn(this.prisma, {
        siteId: c.siteId,
        siteCapMicroUsd: cap.site,
        platformCapMicroUsd: cap.platform,
        estMicroUsd: adminLabelEstimateMicroUsd(model, this.env),
        now,
      });
      if (!rsv.ok) {
        if (cost > 0) break;
        return 'budget';
      }
      let actual: number | null = null;
      try {
        const res = await this.text.generate({
          system: prompt.system,
          user: prompt.user,
          json: true,
          temperature: 0,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          model,
          timeoutMs: Math.min(ADMIN_LABEL_CALL_TIMEOUT_MS, left),
        });
        actual = await this.record(c, res);
        cost += actual;
        const parsed = parseAdminLabel(res.text, input);
        if (parsed.ok) label = parsed.label;
      } catch (e) {
        const spent = spentOf(e);
        if (spent) {
          actual = await this.record(c, spent).catch(() => null);
          if (actual !== null) cost += actual;
        } else if (e instanceof TextModelError) {
          // Денег провайдер не взял (timeout/unavailable): резерв — ноль,
          // диалог ждёт следующего тика.
          await settleAdminTurn(this.prisma, rsv.reservation, 0).catch(
            () => undefined,
          );
          this.logger.warn(`разметка «Админки»: модель — ${e.kind}`);
          return 'stop';
        } else {
          // Иной сбой после вызова: деньги, возможно, потрачены — резерв
          // переносится в расход (строже, а не мягче).
          await settleAdminTurn(this.prisma, rsv.reservation, null).catch(
            () => undefined,
          );
          throw e;
        }
      }
      // Факт записан — снятие резерва фактом; запись расхода сорвалась —
      // оценка остаётся расходом (`actual = null`).
      await settleAdminTurn(this.prisma, rsv.reservation, actual).catch(
        () => undefined,
      );
    }
    await this.write(c, model, label, input, cost);
    return label ? 'ok' : 'failed';
  }

  private async write(
    c: Candidate,
    model: string,
    label: AdminLabelResult | null,
    input: AdminLabelInput,
    cost: number,
  ): Promise<void> {
    await this.sitesDb
      .forAccount(c.accountId)
      .assistAdminConversationLabel.createMany({
        data: [
          {
            conversationId: c.id,
            accountId: c.accountId,
            siteId: c.siteId,
            model,
            promptVersion: ADMIN_LABEL_PROMPT_VERSION,
            taskType: label?.taskType ?? 'other',
            answerFound: label?.answerFound ?? answerFoundByCode(input.facts),
            toolError: label?.toolError ?? input.facts.toolErrors > 0,
            quality: label?.quality ?? null,
            status: label?.status ?? 'failed',
            employeeRole: c.employeeRole,
            conversationAt: c.createdAt,
            costMicroUsd: Math.max(0, Math.round(cost)),
          },
        ],
        skipDuplicates: true,
      });
  }
}
