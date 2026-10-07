/**
 * Ход помощника сотрудника (ТЗ §5.4, §5.7; приёмка Э7): знания «Админки» +
 * read-операции коннекторов → ответ.
 *
 *  1. Поиск по базе «Админки» (AdminKnowledgeService.search — только
 *     assist_admin_*; знаний «Сайта» этот модуль не видит: граф admin↛site).
 *  2. План вызовов (если роли доступны операции) — модель выбирает из
 *     каталога; аргументы проверяет код; ошибка параметров — один повтор с
 *     текстом ошибки, затем честное «не смог собрать запрос» (+ очередь).
 *  3. Исполнение read (ConnectorsService.runRead: SSRF-guard, журнал).
 *     Любой сбой (5xx/таймаут после повтора, 4xx, 401/403, не JSON, лимит)
 *     → ответ пишет КОД, без модели и без выдуманных данных (§5.7).
 *  4. Ответ модели по `<source>`/`<data>`; после модели — проверки кодом:
 *     маркеры [S#] только из промпта, без URL/HTML/картинок, цифры только
 *     из источников/данных/вопроса.
 *
 * Результаты инструментов не кэшируются и не становятся знаниями (§5.4,
 * §4-тер.6): в базу сообщений пишется только итоговый текст ответа и
 * сводка вызовов (операция, исход), без данных.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  questionLang,
  type AnswerLang,
} from '../assist-knowledge-core/answer/prompt';
import {
  citedNumbers,
  sanitizeAnswerText,
  unsupportedNumbers,
} from '../assist-knowledge-core/answer/sanitize';
import { parseModelJson } from '../assist-knowledge-core/answer/answer-engine';
import type { SearchHit } from '../assist-knowledge-core/types';
import { AdminKnowledgeService } from '../assist-admin-knowledge/admin-knowledge.service';
import {
  ConnectorsService,
  type CallerCtx,
  type ToolOperation,
} from '../assist-admin-mode/connectors.service';
import type { ExecResult } from '../assist-admin-mode/connector-exec';
import { validateArgs } from '../assist-admin-mode/connector-exec';
import {
  GeminiText,
  TextModelError,
  spentOf,
  type GenerateRequest,
  type GenerateResult,
  type TextModelSpent,
} from '../site-ai/text-model';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import {
  type ActionOperation,
  type ActorCtx,
  ProposalsService,
  type ProposalView,
} from '../assist-admin-actions/proposals.service';
import {
  ADMIN_MAX_CALLS_PER_TURN,
  ADMIN_TEXT,
  buildAdminAnswerPrompt,
  buildPlanPrompt,
  parsePlan,
  parseProposal,
  type DataBlock,
  type PlannedCall,
} from './admin-prompt';

export type AnswerPath = 'knowledge' | 'tool' | 'refused' | 'error' | 'action';

export interface ToolSummary {
  operation: string;
  outcome: string;
  httpStatus: number | null;
}

export interface TurnResult {
  text: string;
  sources: Array<{ n: number; url: string | null; title: string | null }>;
  tools: ToolSummary[];
  answerPath: AnswerPath;
  flags: string[];
  model: string | null;
  inTokens: number;
  outTokens: number;
  costMicroUsd: number;
  /** Для очереди обучения: ошибка параметров / сбой инструмента. */
  learning: 'tool_param_error' | 'tool_failure' | 'refused' | null;
  /** Э8: карточка подтверждения, созданная в этом ходе (не исполнена!). */
  proposal: ProposalView | null;
}

export interface TurnInput {
  ctx: CallerCtx;
  /** `*` — владелец «Админки» (все операции); null — только знания (§5.1). */
  role: string | null;
  question: string;
  history: string[];
  siteName: string | null;
  instructions: string | null;
}

const ANSWER_MAX_HITS = 6;

/** Расход хода: модель, токены и деньги всех вызовов модели. */
interface TurnAcc {
  model: string | null;
  inTokens: number;
  outTokens: number;
  cost: number;
}

@Injectable()
export class AdminAnswerService {
  private readonly logger = new Logger(AdminAnswerService.name);

  constructor(
    private readonly db: SitesDb,
    private readonly knowledge: AdminKnowledgeService,
    private readonly connectors: ConnectorsService,
    private readonly text: GeminiText,
    private readonly usage: AiUsageRecorder,
    private readonly proposals: ProposalsService,
  ) {}

  private async record(
    ctx: CallerCtx,
    gen: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
    },
  ): Promise<number> {
    try {
      const r = await this.usage.record(
        this.db.system(
          'учёт расходов «Админки»: строка site_ai_usage с accountId сайта',
        ),
        {
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          operation: 'assist-admin-chat',
          model: gen.model,
          units: {
            inputTokens: gen.inputTokens,
            outputTokens: gen.outputTokens,
            cachedInputTokens: gen.cachedInputTokens,
          },
        },
      );
      return r.costMicroUsd;
    } catch {
      return 0;
    }
  }

  private failureText(
    lang: AnswerLang,
    op: ToolOperation,
    r: ExecResult,
  ): string {
    const name = op.connectorName;
    switch (r.outcome) {
      case 'auth_failed':
        return ADMIN_TEXT.apiAuth[lang](name);
      case 'blocked':
        return ADMIN_TEXT.apiBlocked[lang];
      case 'bad_response':
        return ADMIN_TEXT.apiBadResponse[lang](name);
      case 'http_error':
        return r.httpStatus && r.httpStatus >= 500
          ? ADMIN_TEXT.apiDown[lang](name)
          : ADMIN_TEXT.apiError[lang](name, r.httpStatus);
      case 'invalid_params':
        return ADMIN_TEXT.badParams[lang];
      default:
        return (r.error ?? '').startsWith('daily_limit') ||
          (r.error ?? '').startsWith('conversation_minute')
          ? ADMIN_TEXT.apiLimit[lang](name)
          : r.outcome === 'timeout'
            ? ADMIN_TEXT.apiDown[lang](name)
            : ADMIN_TEXT.apiBlocked[lang];
    }
  }

  /**
   * Вызов модели с учётом хода: расход — в `acc` (деньги хода → потолок
   * «Админки») и в site_ai_usage. У empty/truncated провайдер ответил —
   * расход тот же, что у ответа; ошибка пробрасывается как была.
   */
  private async generate(
    ctx: CallerCtx,
    acc: TurnAcc,
    req: GenerateRequest,
  ): Promise<GenerateResult> {
    let gen: GenerateResult;
    try {
      gen = await this.text.generate(req);
    } catch (e) {
      const spent = spentOf(e);
      if (spent) await this.count(ctx, acc, spent);
      throw e;
    }
    await this.count(ctx, acc, gen);
    return gen;
  }

  private async count(
    ctx: CallerCtx,
    acc: TurnAcc,
    gen: TextModelSpent,
  ): Promise<void> {
    acc.model = gen.model;
    acc.inTokens += gen.inputTokens;
    acc.outTokens += gen.outputTokens;
    acc.cost += await this.record(ctx, gen);
  }

  /** План: модель → проверка по каталогу и схеме; один повтор при ошибке параметров. */
  private async plan(
    input: TurnInput,
    tools: ToolOperation[],
    actions: ActionOperation[],
    acc: TurnAcc,
  ): Promise<{
    calls: Array<{ op: ToolOperation; args: Record<string, unknown> }>;
    proposal: { op: ActionOperation; args: Record<string, unknown> } | null;
    paramError: boolean;
  }> {
    const byKey = new Map(tools.map((t) => [t.key, t]));
    const actionByKey = new Map(actions.map((t) => [t.key, t]));
    let paramError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = buildPlanPrompt({
        question: input.question,
        catalog: tools,
        actions,
        history: input.history,
        paramError,
      });
      const gen = await this.generate(input.ctx, acc, {
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: 400,
        json: true,
        temperature: 0,
      });
      const planned: PlannedCall[] = parsePlan(gen.text) ?? [];
      const calls: Array<{ op: ToolOperation; args: Record<string, unknown> }> =
        [];
      paramError = null;
      for (const c of planned.slice(0, ADMIN_MAX_CALLS_PER_TURN)) {
        const op = byKey.get(c.operation);
        if (!op) {
          paramError = `операции ${c.operation.slice(0, 80)} нет в каталоге`;
          break;
        }
        try {
          validateArgs(op.params, c.args);
        } catch (e) {
          paramError = `${op.key}: ${(e as Error).message.slice(0, 200)}`;
          break;
        }
        calls.push({ op, args: c.args });
      }
      // Э8: предложение — только из каталога действий роли и по схеме.
      // Исполнения здесь нет и быть не может: только строка `pending`.
      let proposal: {
        op: ActionOperation;
        args: Record<string, unknown>;
      } | null = null;
      const pr = actions.length ? parseProposal(gen.text) : null;
      if (!paramError && pr) {
        const aop = actionByKey.get(pr.operation);
        if (!aop) {
          paramError = `дії ${pr.operation.slice(0, 80)} немає в каталозі дій`;
        } else {
          try {
            validateArgs(aop.params, pr.args);
            proposal = { op: aop, args: pr.args };
          } catch (e) {
            paramError = `${aop.key}: ${(e as Error).message.slice(0, 200)}`;
          }
        }
      }
      if (!paramError) return { calls, proposal, paramError: false };
    }
    return { calls: [], proposal: null, paramError: true };
  }

  async turn(input: TurnInput): Promise<TurnResult> {
    const lang = questionLang(input.question);
    const acc = {
      model: null as string | null,
      inTokens: 0,
      outTokens: 0,
      cost: 0,
    };
    const base = (
      text: string,
      answerPath: AnswerPath,
      extra: Partial<TurnResult> = {},
    ): TurnResult => ({
      text,
      sources: [],
      tools: [],
      answerPath,
      flags: [],
      model: acc.model,
      inTokens: acc.inTokens,
      outTokens: acc.outTokens,
      costMicroUsd: acc.cost,
      learning: null,
      proposal: null,
      ...extra,
    });

    let hits: SearchHit[] = [];
    try {
      hits = (
        await this.knowledge.search({
          siteId: input.ctx.siteId,
          query: input.question,
          limit: ANSWER_MAX_HITS,
        })
      ).slice(0, ANSWER_MAX_HITS);
    } catch (e) {
      this.logger.warn(
        `Поиск по знаниям «Админки» не удался: ${(e as Error).name}`,
      );
    }

    const tools = await this.connectors.toolsFor(
      input.ctx.accountId,
      input.ctx.siteId,
      input.role,
    );
    const actions = await this.proposals.catalog(
      input.ctx.accountId,
      input.ctx.siteId,
      input.role,
    );
    const data: DataBlock[] = [];
    const summaries: ToolSummary[] = [];
    let proposal: { text: string; view: ProposalView } | null = null;
    let refusal: string | null = null;
    try {
      if (tools.length || actions.length) {
        const planned = await this.plan(input, tools, actions, acc);
        if (planned.paramError) {
          return base(ADMIN_TEXT.badParams[lang], 'error', {
            learning: 'tool_param_error',
            flags: ['tool_param_error'],
          });
        }
        if (planned.proposal) {
          const actor: ActorCtx = {
            ...input.ctx,
            assistRole: input.role,
            lang,
          };
          const r = await this.proposals.propose(
            actor,
            planned.proposal.op,
            planned.proposal.args,
            input.question,
          );
          if (r.ok) proposal = { text: r.text, view: r.proposal };
          else refusal = r.text;
        }
        for (const call of planned.calls) {
          const r = await this.connectors.runRead(
            input.ctx,
            call.op,
            call.args,
          );
          summaries.push({
            operation: call.op.key,
            outcome: r.outcome,
            httpStatus: r.httpStatus,
          });
          if (r.outcome !== 'ok' || r.data === null) {
            // §5.7: сбой — честный ответ КОДОМ, без модели и без данных.
            return base(this.failureText(lang, call.op, r), 'error', {
              tools: summaries,
              learning:
                r.outcome === 'invalid_params'
                  ? 'tool_param_error'
                  : 'tool_failure',
              flags: [`tool_${r.outcome}`],
            });
          }
          data.push({
            n: data.length + 1,
            operation: call.op.key,
            json: r.data,
          });
        }
      }
      if (proposal && data.length === 0) {
        // Только предложение: текст пишет КОД, модель ответа не нужна.
        return base(proposal.text, 'action', {
          tools: summaries,
          proposal: proposal.view,
          flags: proposal.view.unrequested ? ['action_unrequested'] : [],
        });
      }
      if (refusal && data.length === 0) {
        return base(refusal, 'refused', {
          tools: summaries,
          flags: ['action_refused'],
        });
      }
      if (hits.length === 0 && data.length === 0) {
        return base(ADMIN_TEXT.noKnowledge[lang], 'refused', {
          tools: summaries,
          learning: 'refused',
          flags: ['no_hits'],
        });
      }
      const prompt = buildAdminAnswerPrompt({
        question: input.question,
        hits,
        data,
        lang,
        siteName: input.siteName,
        instructions: input.instructions,
        history: input.history,
      });
      const gen = await this.generate(input.ctx, acc, {
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: 900,
        json: true,
        temperature: 0.1,
      });
      const parsed = parseModelJson(gen.text);
      const allowed = new Set(prompt.sources.keys());
      const answer = sanitizeAnswerText(parsed?.answer ?? gen.text, allowed);
      if (parsed?.refused || !answer) {
        return base(ADMIN_TEXT.noKnowledge[lang], 'refused', {
          tools: summaries,
          learning: 'refused',
          flags: ['model_refused'],
        });
      }
      const cited = [
        ...new Set([...citedNumbers(answer), ...(parsed?.sources ?? [])]),
      ].filter((n) => allowed.has(n));
      const known = [
        ...hits.map((h) => `${h.title ?? ''} ${h.headingPath ?? ''} ${h.text}`),
        ...data.map((d) => d.json),
      ];
      if (unsupportedNumbers(answer, known, input.question).length > 0) {
        return base(ADMIN_TEXT.unsureNumber[lang], 'refused', {
          tools: summaries,
          learning: 'refused',
          flags: ['unsupported_number'],
        });
      }
      if (proposal || refusal) {
        return base(
          `${answer}\n\n${proposal?.text ?? refusal}`,
          proposal ? 'action' : 'tool',
          {
            tools: summaries,
            proposal: proposal?.view ?? null,
            flags: proposal?.view.unrequested ? ['action_unrequested'] : [],
          },
        );
      }
      return base(answer, data.length ? 'tool' : 'knowledge', {
        tools: summaries,
        sources: cited
          .sort((a, b) => a - b)
          .map((n) => {
            const h = prompt.sources.get(n) as SearchHit;
            return { n, url: h.url, title: h.title };
          }),
      });
    } catch (e) {
      if (e instanceof TextModelError) {
        // Запасной модели для «Админки» нет (§5.7: tool-calling на запасной
        // модели выключен) — честное «недоступен».
        return base(ADMIN_TEXT.modelDown[lang], 'error', {
          tools: summaries,
          flags: ['model_unavailable'],
        });
      }
      throw e;
    }
  }
}
