/**
 * Голосовой план сотрудника — режим «Админка» (Э6-бис (б); ТЗ помощника
 * §5-бис.3–6, §5-бис.9, §5-бис.14 «Админка», §5-бис.15 п.3 п.3, п.11–12,
 * §5-бис.17 п.10; решения Р-Э6б-1…12). Зовут маршруты
 * `/assist-admin/v1/ui-plan*` (admin-voice-embed.controller.ts) ПОСЛЕ
 * сессии сотрудника (employee-JWT → наша сессия, origin `wa.`). Только
 * таблицы assist_admin_* (граф admin↛site; роль assist_public к ним прав не
 * имеет), общий код проверок — нейтральный `assist-ui-core`.
 *
 * Построение плана (потолки — ДО платного вызова):
 *  1. Источник (§5-бис.6 п.1): `voice` — билет голоса «Админки» на ЭТОТ
 *     текст и ЭТОГО сотрудника; `typed` — набор в поле iframe `wa.`.
 *  2. Доступность: режим «Админка» со встраиванием, тариф Pro, рубильник
 *     платформы, переключатель `on`/`degraded` (или тестовая сессия мастера).
 *  3. Снимок (недоверенные данные): строгий разбор, страница — на
 *     verified-хосте САМОЙ админки и в разрешённой зоне.
 *  4. Мемо АМ-N (номер/фраза) — отрезок шагов на странице; без них — как в
 *     чате (предложения API с «Да»).
 *  5. Предпочтение API (Р-Э6б-5): изменение данных с операцией роли — не
 *     клики, а предложение коннектора (команда уходит в чат «Админки»);
 *     удаление/отмена/возврат кликами — никогда.
 *  6. Единицы и деньги — ход диалога сотрудника, суточный потолок.
 *  7. План: прямой путь или модель → `checkAdminPlan` КОДОМ → план в базе,
 *     журнал `ui-plan` в append-only журнале действий.
 * Исполнение (`dispatched` до действия — один раз; `done` после; стоп;
 * продолжение после перехода; «верни как было» — только поля до
 * «Сохранить»), нарушение запрета → режим `off` сразу, монитор «Админки» —
 * на шагах и концах планов (без крона). В лог — только id и коды (§6.6).
 */
import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readVoiceControlPlatform } from '../../common/voice-control-platform';
import { voiceTicketKeys } from '../../config/voice-env';
import { SitesDb } from '../../prisma/sites-db.service';
import { maskSensitiveEcho } from '../../shared/assist-chat-core';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import { AdminMemoService } from '../assist-admin-actions/admin-memo.service';
import {
  ProposalsService,
  type ActorCtx,
} from '../assist-admin-actions/proposals.service';
import type { ActionLang } from '../assist-admin-actions/action-core';
import {
  AdminChatService,
  type EmployeeCtx,
} from '../assist-admin-chat/admin-chat.service';
import type { ResolvedAdminSession } from '../assist-admin-chat/admin-session.service';
import {
  AdminActionLogService,
  type ActionLogKind,
} from '../assist-admin-mode/action-log.service';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import { detectInjection } from '../assist-knowledge-core/injection';
import { replyKind } from '../assist-ui-core/action-words';
import {
  chainAfterUndo,
  chainStatusOf,
  needsSecondYes,
  pointOfNoReturn,
  undoCandidates,
  type UndoResult,
} from '../assist-ui-core/chain';
import { CHAIN_DECISIONS } from '../assist-ui-core/decisions';
import { directPlan, looksLikeCommand } from '../assist-ui-core/direct-plan';
import { onSiteHost, resolveAfterSteps } from '../assist-ui-core/plan-checks';
import type { RawStep } from '../assist-ui-core/plan-checks';
import { buildPlanPrompt, parseModelPlan } from '../assist-ui-core/plan-prompt';
import { zoneAllowed } from '../assist-ui-core/rules';
import {
  maskPageUrl,
  parseSnapshot,
  snapshotTooLarge,
} from '../assist-ui-core/snapshot';
import {
  UI_STEP_RESULTS,
  type ChainStatus,
  type UiPlanNote,
  type UiPlanStatus,
  type UiStepResult,
  type UiStopReason,
  type VoiceControlRules,
} from '../assist-ui-core/types';
import { neverViolation } from '../assist-ui-core/wizard';
import { GeminiText, spentOf } from '../site-ai/text-model';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import { estimateCost } from '../../shared/ai-pricing';
import { failPlan } from './admin-voice-errors';
import { AdminVoiceNotifier } from './admin-voice-notifier';
import {
  ADMIN_PLAN_SYSTEM,
  ADMIN_VC_DECISIONS,
  ADMIN_VC_LIMITS,
  adminizeResolved,
  adminNeverStep,
  adminRulesOf,
  adminStateOf,
  apiAskText,
  apiByPlanTargets,
  apiOperationsBlock,
  apiPreference,
  checkAdminPlan,
  compileAdminMemoUi,
  confirmFields,
  isExecutable,
  modelApiOf,
  type ApiCatalogOp,
} from './admin-voice-rules';
import {
  adminVcPlatformEnv,
  AdminVoiceSettingsService,
} from './admin-voice-settings.service';
import { verifyAdminVoiceTicket } from './admin-stt';
import type {
  AdminPlanStepView,
  AdminPlanView,
  AdminUndoView,
  AdminVoiceConfigView,
} from './api-types';

export const ADMIN_UI_PLAN_MODEL = GEMINI_MODEL;
/** Редакция текста согласия сотрудника «натискати за вас» (на сессию). */
export const ADMIN_VC_CONSENT_VERSION = 'admin-consent-1';

/** Контекст маршрута: сессия сотрудника и (если есть) тестовая сессия мастера. */
export interface AdminVcCtx {
  session: ResolvedAdminSession;
  /** Мастер «Админки»: живой тест ЭТОЙ сессии. */
  test: { testId: string; testHost: boolean; host: string } | null;
}

export interface AdminPlanRequest {
  text?: unknown;
  source?: unknown;
  voiceTicket?: unknown;
  snapshot?: unknown;
  lang?: unknown;
  testId?: unknown;
  dryRun?: unknown;
  memoRunId?: unknown;
}

type PlanRow = Prisma.AssistAdminUiPlanGetPayload<object>;

const LIVE: ReadonlySet<string> = new Set(['proposed', 'confirmed', 'running']);
const TERMINAL: ReadonlySet<string> = new Set([
  'done',
  'stopped',
  'failed',
  'expired',
]);
const EFFECT_KINDS: ReadonlySet<string> = new Set([
  'click',
  'fill',
  'select',
  'check',
  'navigate',
]);
const RANK: Record<string, number> = {
  auto: 0,
  confirm: 1,
  manual: 2,
  never: 3,
};

export function hasSideEffect(s: { kind: string; nav: boolean }): boolean {
  return s.nav || EFFECT_KINDS.has(s.kind);
}

/** Отпечаток шагов карточки (со значениями — их видел сотрудник). */
export function adminStepsHash(
  steps: ReadonlyArray<
    Pick<AdminPlanStepView, 'kind' | 'target' | 'value' | 'risk'>
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        steps.map((s) => [
          s.kind,
          s.target?.ref,
          s.target?.text,
          s.value,
          s.risk,
        ]),
      ),
    )
    .digest('base64url')
    .slice(0, 22);
}

export function pathExpected(path: string, want: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '') || '/';
  if (want.endsWith('*')) return norm(path).startsWith(norm(want.slice(0, -1)));
  return norm(path) === norm(want);
}

function pathOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function cleanUtterance(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return t && t.length <= ADMIN_VC_LIMITS.maxUtteranceChars ? t : null;
}

function langOf(v: unknown): 'uk' | 'ru' | 'en' {
  return v === 'ru' || v === 'en' ? v : 'uk';
}

/** Пометки предпросмотра (§5-бис.15 п.5): ↺ local, ⚠ irrev, ✋ manual. */
function marksOf(steps: readonly AdminPlanStepView[]) {
  return steps.map((s) =>
    s.risk === 'manual' || s.risk === 'never' ? ('manual' as const) : s.undo,
  );
}

const SUMMARY: Record<
  'uk' | 'ru' | 'en',
  { plan: string; nothing: string; api: string }
> = {
  uk: {
    plan: 'Голосове керування',
    nothing: 'Нічого не натискаю',
    api: 'Зміна даних — через пропозицію API з підтвердженням',
  },
  ru: {
    plan: 'Голосовое управление',
    nothing: 'Ничего не нажимаю',
    api: 'Изменение данных — через предложение API с подтверждением',
  },
  en: {
    plan: 'Voice control',
    nothing: 'Not pressing anything',
    api: 'Data change goes through an API proposal with confirmation',
  },
};

/** Строка итога плана для диалога сотрудника (без значений полей). */
function planSummary(
  steps: readonly AdminPlanStepView[],
  lang: 'uk' | 'ru' | 'en',
): string {
  const t = SUMMARY[lang];
  const targets = steps
    .filter((s) => s.target && s.kind !== 'say')
    .map((s) => `«${s.target?.text || s.target?.assistId || '…'}»`)
    .slice(0, 10);
  return targets.length
    ? `${t.plan}: ${targets.join(' → ')}`
    : `${t.plan}: ${t.nothing}`;
}

@Injectable()
export class AdminUiPlanService {
  private readonly logger = new Logger(AdminUiPlanService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly mode: AdminModeService,
    private readonly settings: AdminVoiceSettingsService,
    private readonly chat: AdminChatService,
    private readonly memos: AdminMemoService,
    private readonly proposals: ProposalsService,
    private readonly log: AdminActionLogService,
    private readonly model: GeminiText,
    private readonly usage: AiUsageRecorder,
    private readonly notifier: AdminVoiceNotifier,
  ) {}

  private db(accountId: string) {
    return this.sitesDb.forAccount(accountId);
  }

  employee(s: ResolvedAdminSession): EmployeeCtx {
    return {
      accountId: s.accountId,
      siteId: s.siteId,
      channel: 'embed',
      employeeRef: s.employeeRef,
      actorExternal: s.sub,
      customerRole: s.customerRole,
      name: s.name,
      role: s.role,
    };
  }

  actorOf(
    s: ResolvedAdminSession,
    conversationId: string | null,
    lang: ActionLang,
  ): ActorCtx {
    return {
      accountId: s.accountId,
      siteId: s.siteId,
      actor: s.employeeRef,
      actorRole: s.customerRole,
      actorExternal: s.sub,
      channel: 'embed',
      conversationId,
      assistRole: s.role,
      lang,
    };
  }

  // ── доступность ─────────────────────────────────────────────────────────

  /**
   * Режим для этой сессии: `on`/`degraded` по переключателю; `test` —
   * только тестовой сессии мастера (для неё — `on` в любом состоянии,
   * кроме выключенного режима «Админка», тарифа и рубильника).
   */
  async access(
    s: ResolvedAdminSession,
    test: boolean,
    now = this.now(),
  ): Promise<{
    mode: 'on' | 'degraded' | null;
    rules: VoiceControlRules | null;
    hosts: string[];
    state: ReturnType<typeof adminStateOf>;
  }> {
    const st = await this.mode.ensureSettings(s.accountId, s.siteId);
    const state = adminStateOf(st.voiceControlAdminState);
    const rules = adminRulesOf(st.voiceControlAdminRules);
    const off = { mode: null, rules, hosts: [], state };
    if (
      !st.adminModeEnabled ||
      (st.adminAccess !== 'script' && st.adminAccess !== 'both')
    )
      return off;
    if (!adminVcPlatformEnv(this.env)) return off;
    const platform = await readVoiceControlPlatform(
      this.sitesDb.system(
        'голосовое управление: рубильник платформы — настройка без кабинета',
      ),
      now.getTime(),
    );
    if (!platform.enabled) return off;
    if (!(await this.mode.planAllowsActions(s.accountId, now))) return off;
    if (!rules) return off;
    const hosts = (
      await this.settings.adminHosts(s.accountId, s.siteId, st, now)
    )
      .filter((h) => h.verified)
      .map((h) => h.host);
    if (!hosts.length) return off;
    const mode: 'on' | 'degraded' | null = test
      ? state === 'off' && !st.voiceControlAdminRisksVersion
        ? null
        : 'on'
      : state === 'on'
        ? 'on'
        : state === 'degraded'
          ? 'degraded'
          : null;
    return { mode, rules, hosts, state };
  }

  /** Конфиг для iframe `wa.` (после сессии). */
  async config(ctx: AdminVcCtx): Promise<AdminVoiceConfigView> {
    const a = await this.access(ctx.session, !!ctx.test);
    const rules = a.rules;
    return {
      mode: a.mode,
      state: a.state,
      denySelectors: a.mode && rules ? rules.denySelectors : [],
      allowSelectors: a.mode && rules ? rules.allowSelectors : [],
      maxSteps: rules?.maxSteps ?? ADMIN_VC_LIMITS.defaultSteps,
      voice: !!a.mode && this.settings.voiceAvailable(),
      consentVersion: ADMIN_VC_CONSENT_VERSION,
    };
  }

  private async assertOn(ctx: AdminVcCtx) {
    const a = await this.access(ctx.session, !!ctx.test);
    if (!a.mode || !a.rules) failPlan('off');
    return a as {
      mode: 'on' | 'degraded';
      rules: VoiceControlRules;
      hosts: string[];
    };
  }

  // ── журнал ──────────────────────────────────────────────────────────────

  private async journal(
    ctx: AdminVcCtx,
    plan: { id: string; conversationId: string | null },
    kind: ActionLogKind,
    operation: string,
    outcome: string,
    request: Record<string, unknown>,
    error: string | null = null,
    durationMs: number | null = null,
  ): Promise<void> {
    const s = ctx.session;
    await this.log.append(
      {
        accountId: s.accountId,
        siteId: s.siteId,
        actor: s.employeeRef,
        actorRole: s.customerRole,
        channel: 'embed',
        conversationId: plan.conversationId,
        connectorId: null,
        operationRowId: null,
        operation,
        kind,
        outcome,
        httpStatus: null,
        durationMs,
        requestMasked: {
          plan: plan.id,
          ...(ctx.test ? { test: ctx.test.testId } : {}),
          ...request,
        } as Prisma.InputJsonValue,
        responseBytes: null,
        error,
      },
      this.now(),
    );
  }

  private stepEntry(s: AdminPlanStepView) {
    return {
      i: s.i,
      target: s.target
        ? {
            role: s.target.role,
            text: s.target.text,
            assistId: s.target.assistId,
            path: pathOf(s.target.href),
          }
        : null,
      value: s.value ? maskSensitiveEcho(s.value) : null,
      risk: s.risk,
      undo: s.undo,
    };
  }

  // ── построение плана ────────────────────────────────────────────────────

  async create(
    ctx: AdminVcCtx,
    body: AdminPlanRequest,
  ): Promise<AdminPlanView> {
    const s = ctx.session;
    const now = this.now();
    const lang = langOf(body?.lang);
    const memoRunId =
      typeof body?.memoRunId === 'string' ? body.memoRunId : null;
    let text = cleanUtterance(body?.text);
    if (!memoRunId && !text) return failPlan('bad_request');
    let source: 'voice' | 'typed' = 'typed';
    if (text && body.source === 'voice') {
      const ok = verifyAdminVoiceTicket(
        voiceTicketKeys(this.env),
        body.voiceTicket,
        { siteId: s.siteId, actor: s.employeeRef, text, now },
      );
      if (!ok) return failPlan('bad_request');
      source = 'voice';
    } else if (text && body.source !== 'typed') return failPlan('bad_request');
    const test = ctx.test;
    const a = await this.access(s, !!test, now);
    if (!a.mode || !a.rules) return failPlan('off');
    const rules = a.rules;
    const dryRun = body.dryRun === true;
    if (dryRun && !test) return failPlan('bad_request');
    if (snapshotTooLarge(body.snapshot)) return failPlan('too_large');
    const snapshot = parseSnapshot(body.snapshot);
    if (!snapshot) return failPlan('bad_request');
    if (!onSiteHost(snapshot.url, a.hosts)) return failPlan('bad_request');
    // Мастер: только хост ССЫЛКИ (отметка «тестовый» — его, не любого хоста
    // админки: токен, перенесённый на рабочий хост, «Сохранить» не нажмёт).
    if (test && !onSiteHost(snapshot.url, [test.host]))
      return failPlan('bad_request');
    const pagePath = pathOf(snapshot.url) ?? '/';
    if (!zoneAllowed(pagePath, rules)) return refused('denied');
    const actor = this.actorOf(s, null, lang);
    const employee = this.employee(s);

    // ── мемо: отрезок шагов на странице (Р-Э6б-10) ──
    let memo: {
      runId: string;
      number: number;
      name: string;
      from: number;
      to: number;
      raw: RawStep[];
      trusted: string[];
      missingAt: number | null;
    } | null = null;
    if (memoRunId) {
      // D3 (§5-бис.17 п.5 п.8): мемо ушло в «требует проверки» или
      // выключено, пока шёл запуск, — отрезок на странице не исполняется,
      // запуск остановлен, сотрудник видит причину.
      const halted = await this.memos.haltRun(actor, memoRunId);
      if (halted)
        return {
          ...emptyView('memo'),
          memo: {
            number: halted.number,
            name: '',
            text: halted.text,
            proposalId: null,
            nextUi: false,
          },
        };
      const seg = await this.memos.uiSegment(actor, memoRunId, now);
      if (!seg) return failPlan('not_found');
      const c = compileAdminMemoUi(seg.steps, seg.slots, snapshot);
      memo = {
        runId: seg.runId,
        number: seg.memoNumber,
        name: seg.name,
        from: seg.from,
        to: seg.to,
        raw: c.raw,
        trusted: [...c.trusted, ...Object.values(seg.slots)],
        missingAt: c.missingAt,
      };
      text = text ?? `АМ-${seg.memoNumber}`;
    } else if (s.role !== null && text && !dryRun) {
      const hit = await this.memos.match(actor, text);
      if (hit) {
        const conv = test ? null : await this.chat.openTurn(employee, now);
        const r =
          hit.kind === 'memo'
            ? await this.memos.start(
                { ...actor, conversationId: conv },
                hit,
                now,
                true,
              )
            : {
                text: this.memos.unknownText(lang, hit.number),
                proposal: null,
                ui: null,
              };
        if (!r.ui) {
          if (conv)
            await this.chat.recordTurn(employee, conv, text, r.text, {
              proposalId: r.proposal?.id ?? null,
              flags: ['voice-control', 'memo'],
              now,
            });
          return {
            ...emptyView('memo'),
            memo: {
              number: hit.kind === 'memo' ? hit.memo.number : hit.number,
              name: '',
              text: r.text,
              proposalId: r.proposal?.id ?? null,
              nextUi: false,
            },
          };
        }
        const seg = await this.memos.uiSegment(actor, r.ui.runId, now);
        if (!seg) return failPlan('conflict');
        const c = compileAdminMemoUi(seg.steps, seg.slots, snapshot);
        memo = {
          runId: seg.runId,
          number: seg.memoNumber,
          name: seg.name,
          from: seg.from,
          to: seg.to,
          raw: c.raw,
          trusted: [...c.trusted, ...Object.values(seg.slots)],
          missingAt: c.missingAt,
        };
      }
    }
    const utterance = text as string;
    // ── предпочтение API (Р-Э6б-5): изменение с операцией — не кликами ──
    let apiMissing = false;
    let catalog: ApiCatalogOp[] = [];
    // Мастер (тестовая сессия) — без API: карточка на боевом API посреди
    // проверки недопустима, мастер проверяет клики (аудит пакета F, P2-2).
    if (!memo && !dryRun && !test && ADMIN_VC_DECISIONS.preferApi) {
      catalog = (
        await this.proposals.catalog(s.accountId, s.siteId, s.role)
      ).map((o) => ({
        rowId: o.rowId,
        key: o.key,
        operationId: o.operationId,
        summary: o.summary,
        kind: o.kind,
        params: o.params.map((x) => ({
          name: x.name,
          in: x.in,
          ...(x.description ? { description: x.description } : {}),
        })),
      }));
      const pref = apiPreference(utterance, catalog);
      if (pref && pref.kind !== 'never') {
        await this.journalApi(
          ctx,
          utterance,
          pref.kind === 'api' ? pref.op.key : '*',
        );
        return {
          ...emptyView('api'),
          api: {
            key: pref.kind === 'api' ? pref.op.key : null,
            ask: apiAskText(utterance, pagePath),
          },
        };
      }
      apiMissing = pref?.kind === 'never';
    }

    if (!memo && !looksLikeCommand(utterance)) return emptyView('not_command');

    // ── диалог и единицы (тестовая сессия мастера их не тратит) ──
    const conversationId = test
      ? null
      : await this.chat.openTurn(employee, now);

    // ── план: мемо, прямой путь или модель ──
    let raw: RawStep[] | null = memo
      ? memo.raw
      : directPlan(utterance, snapshot);
    let origin: 'model' | 'direct' | 'memo' = memo
      ? 'memo'
      : raw
        ? 'direct'
        : 'model';
    let costMicroUsd = 0;
    if (!raw) {
      const p = buildPlanPrompt({
        transcript: utterance,
        snapshot,
        map: [],
        lang,
      });
      const block = apiOperationsBlock(catalog, (x) =>
        detectInjection(x).quarantine ? null : x,
      );
      const user = block ? `${block}\n${p.user}` : p.user;
      let out: string;
      try {
        const r = await this.model.generate({
          system: ADMIN_PLAN_SYSTEM,
          user,
          json: true,
          temperature: 0,
          maxOutputTokens: ADMIN_VC_LIMITS.maxOutputTokens,
          timeoutMs: ADMIN_VC_LIMITS.modelTimeoutMs,
        });
        out = r.text;
        costMicroUsd = await this.recordUsage(s, {
          model: r.model,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cachedInputTokens: r.cachedInputTokens,
        });
      } catch (e) {
        // empty/truncated: провайдер ответил — строка расхода та же, что у
        // ответа (её считает суточный потолок «Админки», adminSpentToday).
        const spent = spentOf(e);
        if (spent) await this.recordUsage(s, spent);
        return failPlan('upstream');
      }
      const apiOp = modelApiOf(out);
      if (apiOp) {
        const op = catalog.find(
          (o) => o.operationId === apiOp || o.key === apiOp,
        );
        if (op) {
          await this.journalApi(ctx, utterance, op.key);
          if (conversationId)
            await this.chat.recordTurn(
              employee,
              conversationId,
              utterance,
              '',
              {
                now,
              },
            );
          return {
            ...emptyView('api'),
            api: { key: op.key, ask: apiAskText(utterance, pagePath) },
          };
        }
      }
      const parsed = parseModelPlan(out);
      if (!parsed) return failPlan('upstream');
      if (!parsed.command) return emptyView('not_command');
      raw = parsed.steps;
      origin = 'model';
    }

    // ── проверка кодом: правила «Админки» поверх нейтральных ──
    const checked = checkAdminPlan({
      transcript: utterance,
      snapshot,
      map: [],
      steps: raw,
      rules,
      hosts: a.hosts,
      state: a.mode,
      noSubmit: !!test && !test.testHost,
      ...(memo ? { trusted: memo.trusted } : {}),
    });
    // ── предпочтение API по целям плана (Р-З9-23): поля + «Сохранить», а
    // у роли есть write-операция с такими параметрами — карточка API, не клики.
    if (
      !memo &&
      !dryRun &&
      !test &&
      ADMIN_VC_DECISIONS.preferApi &&
      catalog.length
    ) {
      const byTargets = apiByPlanTargets(checked.steps, catalog, utterance);
      if (byTargets && byTargets.kind !== 'never') {
        const key = byTargets.kind === 'api' ? byTargets.op.key : null;
        await this.journalApi(ctx, utterance, key ?? '*', 'targets');
        if (conversationId)
          await this.chat.recordTurn(employee, conversationId, utterance, '', {
            now,
          });
        return {
          ...emptyView('api'),
          api: { key, ask: apiAskText(utterance, pagePath) },
        };
      }
    }
    let steps = checked.steps;
    const notes: UiPlanNote[] = [...checked.notes];
    if (memo) {
      // Мемо — цепочка без дыр: шаг вычеркнут — дальше не идём.
      let k = 0;
      while (k < checked.from.length && checked.from[k] === k) k++;
      // Шаги `ui` мемо — только none/nav/local (Р-Э6б-10): шаг с серверным
      // эффектом (кнопка, поле без «Сохранить») — не кликом, конец отрезка.
      const fx = steps.findIndex(
        (x, i) => i < k && isExecutable(x) && x.undo === 'irrev',
      );
      if (fx >= 0) {
        notes.push({
          code: 'bad_kind',
          target: steps[fx].target?.text || null,
        });
        k = fx;
      }
      steps = steps.slice(0, k);
      if (memo.missingAt !== null)
        notes.unshift({ code: 'no_target', target: null });
    }
    const views: AdminPlanStepView[] = steps.map((x) => ({
      ...x,
      state: 'pending',
    }));
    const pnr = pointOfNoReturn(views);
    const executable = views.length > 0;
    const needsConfirm = views.some((x) => x.risk === 'confirm');
    const status: UiPlanStatus = !executable
      ? 'failed'
      : dryRun
        ? 'done'
        : needsConfirm
          ? 'proposed'
          : 'confirmed';
    const confirmBefore = new Date(
      now.getTime() + ADMIN_VC_LIMITS.confirmWindowMs,
    );
    const expiresAt = new Date(now.getTime() + ADMIN_VC_LIMITS.planTtlMs);
    const terminal = status === 'failed' || status === 'done';
    const row = await this.db(s.accountId).assistAdminUiPlan.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId,
        actor: s.employeeRef,
        sessionId: s.sessionId,
        utteranceMasked: maskSensitiveEcho(utterance).slice(0, 600),
        source,
        lang,
        pageUrl: maskPageUrl(snapshot.url).slice(0, 2000),
        steps: (terminal
          ? maskSteps(views)
          : views) as unknown as Prisma.InputJsonValue,
        liveUtterance: terminal ? null : utterance,
        status,
        needsConfirm: !dryRun && needsConfirm,
        confirmedBy: dryRun ? 'dry' : needsConfirm ? null : 'auto',
        confirmBefore,
        expiresAt,
        chainStatus: executable ? (dryRun ? 'clean' : null) : 'clean',
        planOrigin: origin,
        memoRunId: memo?.runId ?? null,
        memoFrom: memo?.from ?? null,
        memoTo: memo ? memo.from + views.length : null,
        voiceTestId: test?.testId ?? null,
        dryRun,
        costMicroUsd,
      },
    });
    const top = views.reduce(
      (acc, x) => (RANK[x.risk] > RANK[acc] ? x.risk : acc),
      'auto',
    );
    await this.journal(
      ctx,
      row,
      'ui-plan',
      'ui.plan',
      !executable ? 'refused' : dryRun ? 'dryrun' : status,
      {
        page: pathOf(row.pageUrl),
        source,
        origin,
        steps: views.length,
        risk: top,
        pnr,
        notes: notes.map((n) => n.code),
        ...(memo ? { memo: memo.number } : {}),
        // Попытки по запрещённым целям (мастер: регистратор считает и их).
        refused: notes
          .filter((n) =>
            ['danger', 'payment', 'denied', 'sensitive_field'].includes(n.code),
          )
          .map((n) => ({ code: n.code, text: n.target })),
      },
    );
    if (conversationId)
      await this.chat.recordTurn(
        employee,
        conversationId,
        utterance,
        planSummary(views, lang),
        { now },
      );
    if (memo && !executable)
      await this.memoEnd(
        ctx,
        row,
        'failed',
        undefined,
        memo.missingAt !== null ? memo.from + views.length : null,
      );
    this.logger.log(
      `admin ui-plan site=${s.siteId} plan=${row.id} steps=${views.length} confirm=${needsConfirm} origin=${origin}`,
    );
    return {
      ...this.view(row),
      notes,
      apiMissing,
      memo: memo
        ? {
            number: memo.number,
            name: memo.name,
            text: null,
            proposalId: null,
            nextUi: false,
          }
        : null,
    };
  }

  private async journalApi(
    ctx: AdminVcCtx,
    utterance: string,
    key: string,
    /** Почему API: глагол команды (по умолчанию) или цели плана (Р-З9-23). */
    by?: 'targets',
  ) {
    await this.journal(
      ctx,
      { id: '-', conversationId: null },
      'ui-plan',
      'ui.plan',
      'api',
      {
        api: key,
        command: maskSensitiveEcho(utterance).slice(0, 200),
        ...(by ? { by } : {}),
      },
    );
  }

  private async recordUsage(
    s: ResolvedAdminSession,
    gen: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
    },
  ): Promise<number> {
    try {
      const r = await this.usage.record(
        this.sitesDb.system(
          'учёт расходов «Админки»: строка site_ai_usage с accountId сайта',
        ),
        {
          accountId: s.accountId,
          siteId: s.siteId,
          operation: 'assist-admin-ui-plan',
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
      return estimateCost(ADMIN_UI_PLAN_MODEL, {
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
      }).costMicroUsd;
    }
  }

  // ── подтверждение, шаги, стоп, продолжение ──────────────────────────────

  private async load(ctx: AdminVcCtx, id: string): Promise<PlanRow> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return failPlan('not_found');
    const s = ctx.session;
    const row = await this.db(s.accountId).assistAdminUiPlan.findFirst({
      where: { id, siteId: s.siteId, actor: s.employeeRef },
    });
    if (!row) return failPlan('not_found');
    return row;
  }

  private stepsOf(row: PlanRow): AdminPlanStepView[] {
    return Array.isArray(row.steps)
      ? (row.steps as unknown as AdminPlanStepView[])
      : [];
  }

  /** Условная запись «от того, что видели» (гонка двух вкладок/повторов). */
  private async update(
    row: PlanRow,
    data: Prisma.AssistAdminUiPlanUpdateManyMutationInput,
  ): Promise<boolean> {
    const r = await this.db(row.accountId).assistAdminUiPlan.updateMany({
      where: {
        id: row.id,
        status: row.status,
        currentStep: row.currentStep,
        updatedAt: row.updatedAt,
      },
      data,
    });
    return r.count === 1;
  }

  private async expireIfDue(ctx: AdminVcCtx, row: PlanRow): Promise<void> {
    if (!LIVE.has(row.status) || row.expiresAt.getTime() > this.now().getTime())
      return;
    await this.finish(ctx, row, this.stepsOf(row), 'expired');
    failPlan('expired');
  }

  /**
   * Конец плана: статус цепочки (§5-бис.15 п.11), значения — маской, сырая
   * команда — стёрта (тем же UPDATE), статус цепочки — НОВОЙ записью журнала
   * (п.12: append-only), мемо — продолжение/стоп, монитор «Админки».
   */
  private async finish(
    ctx: AdminVcCtx,
    row: PlanRow,
    steps: AdminPlanStepView[],
    status: UiPlanStatus,
    extra: Prisma.AssistAdminUiPlanUpdateManyMutationInput = {},
    /** Запись шага, закончившего план, — до записи статуса цепочки. */
    beforeChain?: () => Promise<void>,
  ): Promise<{
    ok: boolean;
    chainStatus: ChainStatus;
    memo: AdminPlanView['memo'];
  }> {
    const chainStatus = chainStatusOf(steps, status);
    const ok = await this.update(row, {
      ...extra,
      steps: maskSteps(steps) as unknown as Prisma.InputJsonValue,
      status,
      chainStatus,
      liveUtterance: null,
    });
    if (!ok) return { ok, chainStatus, memo: null };
    if (beforeChain) await beforeChain();
    await this.journal(ctx, row, 'chain', 'ui.chain', chainStatus, {
      status,
    });
    let memo: AdminPlanView['memo'] = null;
    if (row.memoRunId) memo = await this.memoEnd(ctx, row, status, steps);
    if (!ctx.test) await this.monitorEnd(ctx).catch(() => undefined);
    return { ok, chainStatus, memo };
  }

  /** Итог отрезка мемо → продолжение запуска (предложение, следующий отрезок). */
  private async memoEnd(
    ctx: AdminVcCtx,
    row: PlanRow,
    status: string,
    steps?: ReadonlyArray<{ state?: string }>,
    /** Отрезок не собрался: цель шага на странице не сошлась (`pinMismatch`). */
    pinAt?: number | null,
  ): Promise<AdminPlanView['memo']> {
    if (!row.memoRunId || row.memoFrom === null) return null;
    const seg = await this.memos.uiSegment(
      this.actorOf(ctx.session, row.conversationId, langOf(row.lang)),
      row.memoRunId,
    );
    const to = seg?.to ?? row.memoTo ?? row.memoFrom;
    const complete = status === 'done' && row.memoTo === to;
    // Монитор «требует проверки» (§5-бис.17 п.8): на каком шаге мемо сбой.
    // План исполнен, но отрезок короче — следующий шаг на странице не
    // сошёлся с сохранённым (цели нет/не та) — `pin_mismatch`; шаг упал при
    // исполнении — сбой этого шага.
    const bad = (steps ?? []).findIndex(
      (x) => x.state === 'failed' || x.state === 'manual',
    );
    const fail =
      complete || status === 'stopped'
        ? null
        : pinAt !== undefined && pinAt !== null
          ? { at: pinAt, pin: true }
          : status === 'done'
            ? { at: row.memoTo ?? row.memoFrom, pin: true }
            : {
                at: row.memoFrom + (bad >= 0 ? bad : row.currentStep),
                pin: false,
              };
    const r = await this.memos.afterUi(
      this.actorOf(ctx.session, row.conversationId, langOf(row.lang)),
      row.memoRunId,
      row.memoFrom,
      to,
      complete ? 'done' : status === 'stopped' ? 'stopped' : 'failed',
      undefined,
      fail,
    );
    if (r.text && row.conversationId)
      await this.chat
        .recordTurn(
          this.employee(ctx.session),
          row.conversationId,
          '',
          r.text,
          {
            proposalId: r.proposal?.id ?? null,
            flags: ['voice-control', 'memo'],
          },
        )
        .catch(() => undefined);
    return {
      number: seg?.memoNumber ?? 0,
      name: seg?.name ?? '',
      text: r.text,
      proposalId: r.proposal?.id ?? null,
      nextUi: r.nextUi,
    };
  }

  async confirm(
    ctx: AdminVcCtx,
    id: string,
    body: {
      stepsHash?: unknown;
      by?: unknown;
      text?: unknown;
      voiceTicket?: unknown;
    },
  ): Promise<AdminPlanView> {
    const row = await this.load(ctx, id);
    if (row.status !== 'proposed') {
      if (row.confirmedBy && row.status !== 'expired') return this.view(row);
      return failPlan('conflict');
    }
    await this.expireIfDue(ctx, row);
    const now = this.now();
    const steps = this.stepsOf(row);
    if (now.getTime() > row.confirmBefore.getTime()) {
      await this.finish(ctx, row, steps, 'expired');
      return failPlan('expired');
    }
    if (body?.stepsHash !== adminStepsHash(steps)) return failPlan('changed');
    let by: 'button' | 'voice';
    if (body.by === 'button') by = 'button';
    else if (body.by === 'voice') {
      const text = cleanUtterance(body.text) ?? '';
      const ok =
        !!text &&
        verifyAdminVoiceTicket(voiceTicketKeys(this.env), body.voiceTicket, {
          siteId: ctx.session.siteId,
          actor: ctx.session.employeeRef,
          text,
          now,
        });
      if (!ok) return failPlan('bad_request');
      const r = replyKind(text);
      if (r === 'no' || r === 'stop')
        return this.stop(ctx, id, { by: 'voice' });
      if (r !== 'yes') return failPlan('bad_request');
      by = 'voice';
    } else return failPlan('bad_request');
    await this.assertOn(ctx);
    const pnr = pointOfNoReturn(steps);
    const pnrConfirmedAt = pnr !== null && row.currentStep === pnr ? now : null;
    const ok = await this.update(row, {
      status: 'confirmed',
      confirmedBy: by,
      ...(pnrConfirmedAt ? { pnrConfirmedAt } : {}),
    });
    if (!ok) {
      const again = await this.load(ctx, id);
      if (again.confirmedBy) return this.view(again);
      return failPlan('conflict');
    }
    await this.journal(ctx, row, 'ui-plan', 'ui.confirm', `confirm:${by}`, {
      step: row.currentStep,
      fields: confirmFields(steps, pnr).length,
    });
    return this.view(await this.load(ctx, id));
  }

  async step(
    ctx: AdminVcCtx,
    id: string,
    body: {
      index?: unknown;
      result?: unknown;
      reason?: unknown;
      url?: unknown;
      durationMs?: unknown;
    },
  ): Promise<AdminPlanView> {
    const row = await this.load(ctx, id);
    await this.expireIfDue(ctx, row);
    const result = body?.result;
    if (!(UI_STEP_RESULTS as readonly unknown[]).includes(result))
      return failPlan('bad_request');
    if (row.status !== 'confirmed' && row.status !== 'running')
      return failPlan('conflict');
    const idx = body.index;
    const steps = this.stepsOf(row);
    if (idx !== row.currentStep || typeof idx !== 'number' || !steps[idx])
      return failPlan('conflict');
    const s = steps[idx];
    if (result === 'dispatched' || result === 'done') {
      const a = await this.assertOn(ctx);
      if (hasSideEffect(s)) {
        // Последний рубеж (§5-бис.14 «Админка: нарушение запрета»): шаг на
        // цели класса «никогда» проверки плана не пропускают — это дефект
        // кода или подмена. Режим «Админки» — `off` сразу, инцидент.
        const why =
          neverViolation(s, { rules: a.rules, hosts: a.hosts }) ??
          (adminNeverStep(s) ? 'danger' : null);
        if (why === 'denied') {
          // Запрет кабинета, введённый ПОСЛЕ плана, — не нарушение кода.
          await this.failLive(ctx, row, steps, idx, 'denied');
          return failPlan('conflict');
        }
        if (why) {
          await this.violation(ctx, row, steps, idx, why);
          return failPlan('off');
        }
      }
    }
    // Второе «Да» прямо перед точкой невозврата (Р-60).
    if (result === 'dispatched') {
      const pnr = pointOfNoReturn(steps);
      const now = this.now();
      if (
        pnr === idx &&
        needsSecondYes({
          steps,
          pnr,
          cardFrom: row.cardFrom,
          confirmBefore: row.confirmBefore,
          now,
          pnrConfirmed: row.pnrConfirmedAt !== null,
        })
      ) {
        const ok = await this.update(row, {
          status: 'proposed',
          needsConfirm: true,
          confirmedBy: null,
          confirmBefore: new Date(
            now.getTime() + CHAIN_DECISIONS.secondYesWindowMs,
          ),
          cardFrom: idx,
        });
        if (!ok) return failPlan('conflict');
        await this.journal(ctx, row, 'ui-plan', 'ui.confirm', 'proposed', {
          step: idx,
          reason: 'pnr',
        });
        return this.view(await this.load(ctx, id));
      }
    }
    const next = steps.map((x) => ({ ...x }));
    let currentStep = row.currentStep;
    let status: UiPlanStatus = 'running';
    const last = idx === steps.length - 1;
    const auto = s.risk === 'auto' || s.risk === 'confirm';
    const effect = hasSideEffect(s);
    let logged = result as UiStepResult;
    const reason =
      typeof body.reason === 'string'
        ? body.reason.replace(/[^a-z_]/g, '').slice(0, 40) || null
        : s.reason;
    switch (result as UiStepResult) {
      case 'dispatched':
        if (!effect || !auto || s.state !== 'pending')
          return failPlan('conflict');
        next[idx].state = 'dispatched';
        next[idx].fx = true;
        break;
      case 'done': {
        if (!auto) return failPlan('conflict');
        if (effect && s.state !== 'dispatched') return failPlan('conflict');
        const path = pathOf(body.url);
        if (s.nav && s.expect?.path && !path) return failPlan('bad_request');
        if (
          s.nav &&
          s.expect?.path &&
          path &&
          !pathExpected(path, s.expect.path)
        ) {
          next[idx].state = 'failed';
          status = 'failed';
          logged = 'failed';
          break;
        }
        next[idx].state = 'done';
        currentStep = idx + 1;
        status = last ? 'done' : 'running';
        break;
      }
      case 'manual':
        if (auto) return failPlan('conflict');
        next[idx].state = 'manual';
        currentStep = idx + 1;
        status = 'done';
        break;
      case 'skipped':
      case 'failed':
        next[idx].state = result as string;
        status = 'failed';
        break;
      case 'stopped':
        next[idx].state = 'stopped';
        status = 'stopped';
        break;
    }
    // Монитор «Админки»: подтверждённое изменение, а результат не тот.
    const expectMiss =
      logged === 'failed' &&
      reason === 'expect' &&
      s.undo === 'irrev' &&
      (row.confirmedBy === 'button' || row.confirmedBy === 'voice');
    const logStep = () =>
      this.journal(
        ctx,
        row,
        'ui-step',
        `ui.${s.kind}`,
        expectMiss ? 'expect_miss' : logged,
        { ...this.stepEntry(s), by: row.confirmedBy, url: maskedUrl(body.url) },
        reason,
        typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
          ? Math.max(0, Math.min(600_000, Math.round(body.durationMs)))
          : null,
      );
    let memo: AdminPlanView['memo'] = null;
    let chainStatus: ChainStatus | null = null;
    if (TERMINAL.has(status)) {
      const end = await this.finish(
        ctx,
        row,
        next,
        status,
        { currentStep },
        logStep,
      );
      if (!end.ok) return failPlan('conflict');
      memo = end.memo;
      chainStatus = end.chainStatus;
    } else {
      const ok = await this.update(row, {
        steps: next as unknown as Prisma.InputJsonValue,
        currentStep,
        status,
      });
      if (!ok) return failPlan('conflict');
      await logStep();
    }
    if (expectMiss && !ctx.test)
      await this.monitorMiss(ctx).catch(() => undefined);
    const fresh = await this.load(ctx, id);
    return {
      ...this.view(fresh),
      chainStatus: chainStatus ?? (fresh.chainStatus as ChainStatus | null),
      memo,
    };
  }

  /** Шаг не исполняется по причине, появившейся после плана (запрет кабинета). */
  private async failLive(
    ctx: AdminVcCtx,
    row: PlanRow,
    steps: AdminPlanStepView[],
    idx: number,
    reason: 'denied',
  ): Promise<void> {
    const next = steps.map((x) => ({ ...x }));
    next[idx].state = 'failed';
    await this.finish(ctx, row, next, 'failed');
    await this.journal(
      ctx,
      row,
      'ui-step',
      `ui.${steps[idx].kind}`,
      'failed',
      { ...this.stepEntry(steps[idx]), risk: 'never' },
      reason,
    );
  }

  /** Нарушение запрета: журнал, план стоп, режим «Админки» — `off` сразу. */
  private async violation(
    ctx: AdminVcCtx,
    row: PlanRow,
    steps: AdminPlanStepView[],
    idx: number,
    why: string,
  ): Promise<void> {
    const s = ctx.session;
    await this.journal(
      ctx,
      row,
      'ui-step',
      `ui.${steps[idx].kind}`,
      'violation',
      { ...this.stepEntry(steps[idx]), risk: 'never' },
      why,
    );
    await this.finish(ctx, row, steps, 'stopped');
    if (ctx.test) {
      // Мастер: попытка — в счётчик отчёта (регистратор), режим — тоже `off`.
      await this.db(s.accountId).assistAdminVoiceTest.updateMany({
        where: { id: ctx.test.testId, reportedAt: null },
        data: { attempts: { increment: 1 } },
      });
    }
    await this.downgrade(ctx, 'off', `violation:${why}`, 'violation');
    await this.notifier
      .violation(s.accountId, s.siteId, why)
      .catch(() => undefined);
    this.logger.error(
      `admin ui-plan VIOLATION site=${s.siteId} plan=${row.id} step=${idx} reason=${why}`,
    );
  }

  /** Автоматическое понижение (монитор/нарушение) — запись в журнале. */
  private async downgrade(
    ctx: AdminVcCtx,
    to: 'off' | 'degraded',
    reason: string,
    by: 'monitor' | 'violation',
  ): Promise<boolean> {
    const s = ctx.session;
    const now = this.now();
    const r = await this.db(s.accountId).assistAdminSettings.updateMany({
      where: {
        siteId: s.siteId,
        voiceControlAdminState: to === 'off' ? { not: 'off' } : { in: ['on'] },
      },
      data: {
        voiceControlAdminState: to,
        voiceControlAdminTestId: null,
        voiceControlAdminStateAt: now,
        voiceControlAdminStateBy: by,
        voiceControlAdminStateReason: reason.slice(0, 80),
      },
    });
    if (r.count === 1)
      await this.log.append(
        {
          accountId: s.accountId,
          siteId: s.siteId,
          actor: by === 'violation' ? 'system:violation' : 'system:monitor',
          actorRole: null,
          channel: 'embed',
          conversationId: null,
          connectorId: null,
          operationRowId: null,
          operation: 'voice-control.state',
          kind: 'voice-control',
          outcome: `auto:${to}`,
          httpStatus: null,
          durationMs: null,
          requestMasked: { reason: reason.slice(0, 80) },
          responseBytes: null,
          error: null,
        },
        now,
      );
    return r.count === 1;
  }

  /** ≥ 3 подтверждённых изменений с несошедшимся `expect` за сутки → `degraded`. */
  private async monitorMiss(ctx: AdminVcCtx): Promise<void> {
    const s = ctx.session;
    const since = new Date(this.now().getTime() - 24 * 60 * 60_000);
    const misses = await this.db(s.accountId).assistAdminActionLog.count({
      where: {
        siteId: s.siteId,
        kind: 'ui-step',
        outcome: 'expect_miss',
        at: { gte: since },
      },
    });
    if (misses >= ADMIN_VC_DECISIONS.degradeOnExpectMisses) {
      if (await this.downgrade(ctx, 'degraded', 'expect_misses', 'monitor'))
        await this.notifier.degraded(s.accountId, s.siteId, misses);
    }
  }

  /** ≥ 10 планов и `done` < 50% за сутки → тревога владельцу (раз в сутки). */
  private async monitorEnd(ctx: AdminVcCtx): Promise<void> {
    const s = ctx.session;
    const now = this.now();
    const st = await this.mode.ensureSettings(s.accountId, s.siteId);
    if (
      st.voiceControlAdminAlertAt &&
      now.getTime() - st.voiceControlAdminAlertAt.getTime() < 24 * 60 * 60_000
    )
      return;
    const m = await this.settings.metrics(s.accountId, s.siteId, now);
    if (
      m.plans >= ADMIN_VC_DECISIONS.alertMinPlans &&
      m.done / m.plans < ADMIN_VC_DECISIONS.alertDoneBelow
    ) {
      await this.db(s.accountId).assistAdminSettings.updateMany({
        where: { siteId: s.siteId },
        data: { voiceControlAdminAlertAt: now },
      });
      await this.notifier.poor(s.accountId, s.siteId, m.plans, m.done);
    }
  }

  async stop(
    ctx: AdminVcCtx,
    id: string,
    body: { by?: unknown },
  ): Promise<AdminPlanView> {
    const row = await this.load(ctx, id);
    if (!LIVE.has(row.status)) return this.view(row);
    const by = ['button', 'esc', 'click', 'key', 'voice', 'close'].includes(
      body?.by as string,
    )
      ? (body.by as string)
      : 'button';
    const end = await this.finish(ctx, row, this.stepsOf(row), 'stopped');
    if (!end.ok) return this.view(await this.load(ctx, id));
    await this.journal(ctx, row, 'ui-plan', 'ui.stop', 'stopped', {
      step: row.currentStep,
      by,
    });
    return { ...this.view(await this.load(ctx, id)), memo: end.memo };
  }

  /** Живой план сотрудника (продолжение на новой странице) и ждущее мемо. */
  async active(
    ctx: AdminVcCtx,
  ): Promise<{ plan: AdminPlanView | null; memoRunId: string | null }> {
    const s = ctx.session;
    const now = this.now();
    const row = await this.db(s.accountId).assistAdminUiPlan.findFirst({
      where: {
        siteId: s.siteId,
        actor: s.employeeRef,
        status: { in: [...LIVE] },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });
    const memoRunId = await this.memos.pendingUi(
      this.actorOf(s, null, 'uk'),
      now,
    );
    return { plan: row ? this.view(row) : null, memoRunId };
  }

  /** Продолжение: шаги `after` — цель из НОВОГО снимка, те же проверки. */
  async resume(
    ctx: AdminVcCtx,
    id: string,
    body: { snapshot?: unknown },
  ): Promise<AdminPlanView> {
    const row = await this.load(ctx, id);
    await this.expireIfDue(ctx, row);
    if (row.status !== 'confirmed' && row.status !== 'running')
      return failPlan('conflict');
    const a = await this.assertOn(ctx);
    if (snapshotTooLarge(body?.snapshot)) return failPlan('too_large');
    const snapshot = parseSnapshot(body?.snapshot);
    if (!snapshot) return failPlan('bad_request');
    if (!onSiteHost(snapshot.url, a.hosts)) return failPlan('bad_request');
    if (ctx.test && !onSiteHost(snapshot.url, [ctx.test.host]))
      return failPlan('bad_request');
    if (!zoneAllowed(pathOf(snapshot.url) ?? '/', a.rules))
      return this.stop(ctx, id, { by: 'close' });
    const steps = this.stepsOf(row);
    const r = resolveAfterSteps({
      steps,
      from: row.currentStep,
      snapshot,
      transcript: row.liveUtterance ?? '',
      rules: a.rules,
      hosts: a.hosts,
      state: a.mode,
    });
    const next = r.steps.map((x, i) => ({
      ...x,
      state: steps[i]?.state ?? 'pending',
      ...(steps[i]?.fx ? { fx: true } : {}),
    })) as AdminPlanStepView[];
    let unresolved = r.unresolved;
    let reason: UiStopReason | null = r.reason ?? null;
    let needsConfirm = r.needsConfirm;
    // Правила «Админки» для только что найденных целей.
    if (unresolved === null) {
      for (let k = row.currentStep; k < next.length; k++) {
        if (
          steps[k]?.target?.ref !== 'after' ||
          next[k].target?.ref === 'after'
        )
          continue;
        const z = adminizeResolved(next, k, {
          noSubmit: !!ctx.test && !ctx.test.testHost,
        });
        if (row.memoRunId && isExecutable(z.step) && z.step.undo === 'irrev') {
          // Мемо после перехода — тоже без серверного эффекта (Р-Э6б-10).
          unresolved = k;
          reason = 'bad_kind';
          break;
        }
        if (z.secondPnr) {
          unresolved = k;
          reason = 'second_pnr';
          break;
        }
        if (z.step.risk === 'confirm' && steps[k].risk !== 'confirm')
          needsConfirm = true;
        next[k] = { ...next[k], ...z.step, state: next[k].state };
      }
    }
    if (unresolved !== null) {
      next[unresolved].state = 'failed';
      const end = await this.finish(ctx, row, next, 'failed');
      if (!end.ok) return failPlan('conflict');
      await this.journal(
        ctx,
        row,
        'ui-step',
        `ui.${steps[unresolved].kind}`,
        'failed',
        this.stepEntry(steps[unresolved]),
        reason ?? 'no_target',
      );
      return { ...this.view(await this.load(ctx, id)), memo: end.memo };
    }
    const now = this.now();
    const ok = await this.update(row, {
      steps: next as unknown as Prisma.InputJsonValue,
      ...(needsConfirm
        ? {
            status: 'proposed',
            needsConfirm: true,
            confirmedBy: null,
            confirmBefore: new Date(
              now.getTime() + ADMIN_VC_LIMITS.confirmWindowMs,
            ),
            cardFrom: row.currentStep,
          }
        : {}),
    });
    if (!ok) return failPlan('conflict');
    return this.view(await this.load(ctx, id));
  }

  // ── «верни как было»: только поля до «Сохранить» (Р-Э6б-11) ───────────

  async undo(
    ctx: AdminVcCtx,
    id: string,
    body: { decision?: unknown; by?: unknown },
  ): Promise<AdminUndoView> {
    let row = await this.load(ctx, id);
    const now = this.now();
    const out = (
      p: PlanRow,
      refused: AdminUndoView['refused'],
      fields: number[] = [],
    ): AdminUndoView => ({
      planId: p.id,
      fields: fields.map((i) => ({
        i,
        text: this.stepsOf(p)[i]?.target?.text ?? '',
      })),
      refused,
      chainStatus: (p.chainStatus as ChainStatus | null) ?? null,
    });
    if (now.getTime() - row.createdAt.getTime() > CHAIN_DECISIONS.undoWindowMs)
      return out(row, 'expired');
    if (LIVE.has(row.status)) {
      await this.stop(ctx, id, { by: 'voice' });
      row = await this.load(ctx, id);
    }
    if (
      row.chainStatus === 'compensated' ||
      row.chainStatus === 'partially_compensated'
    )
      return out(row, 'nothing');
    if (body?.decision === 'keep') {
      await this.journal(ctx, row, 'chain', 'ui.undo', 'kept', {});
      return out(row, 'nothing');
    }
    const c = undoCandidates(this.stepsOf(row));
    if (c.refused) return out(row, c.refused);
    const a = await this.access(ctx.session, !!ctx.test, now);
    if (a.mode !== 'on') return out(row, 'degraded');
    // В «Админке» серверного `comp` кликом нет — только поля (`local`).
    const fields = c.fields.filter(
      (i) => this.stepsOf(row)[i]?.undo === 'local',
    );
    await this.journal(ctx, row, 'chain', 'ui.undo', 'proposed', {
      fields: fields.length,
      by: body?.by === 'command' ? 'command' : 'offer',
    });
    return out(row, fields.length ? null : 'nothing', fields);
  }

  async undoReport(
    ctx: AdminVcCtx,
    id: string,
    body: { results?: unknown },
  ): Promise<AdminUndoView> {
    const row = await this.load(ctx, id);
    // Окно «Вернуть» (10 мин) + время карточки — позже отчёт не меняет
    // статус цепочки (аудит Э6-бис (е) (1), как у «Сайта»).
    if (
      this.now().getTime() - row.createdAt.getTime() >
      CHAIN_DECISIONS.undoWindowMs + CHAIN_DECISIONS.offerTimeoutMs
    )
      return failPlan('expired');
    if (LIVE.has(row.status)) return failPlan('conflict');
    if (
      row.chainStatus === 'compensated' ||
      row.chainStatus === 'partially_compensated'
    )
      return failPlan('conflict');
    const steps = this.stepsOf(row);
    const allowed = new Set(
      undoCandidates(steps).fields.filter((i) => steps[i]?.undo === 'local'),
    );
    const seen = new Set<number>();
    const results: Array<{ i: number; result: UndoResult }> = [];
    for (const r of Array.isArray(body?.results) ? body.results : []) {
      if (!r || typeof r !== 'object') continue;
      const i = (r as { i?: unknown }).i;
      const res = (r as { result?: unknown }).result;
      if (
        typeof i !== 'number' ||
        !allowed.has(i) ||
        seen.has(i) ||
        !['done', 'failed', 'unknown', 'gone'].includes(res as string)
      )
        continue;
      seen.add(i);
      results.push({ i, result: res as UndoResult });
    }
    if (!results.length) return failPlan('bad_request');
    const next = chainAfterUndo(steps, results);
    const ok = await this.db(row.accountId).assistAdminUiPlan.updateMany({
      where: { id: row.id, chainStatus: row.chainStatus },
      data: { chainStatus: next },
    });
    if (ok.count !== 1) return failPlan('conflict');
    // Статус цепочки — новой записью (append-only, §5-бис.15 п.12).
    await this.journal(ctx, row, 'chain', 'ui.undo', next, {
      results: results.map((r) => ({ i: r.i, result: r.result })),
    });
    return { planId: row.id, fields: [], refused: null, chainStatus: next };
  }

  // ── представление ───────────────────────────────────────────────────────

  view(row: PlanRow): AdminPlanView {
    const steps = this.stepsOf(row);
    const pnr = pointOfNoReturn(steps);
    return {
      kind: 'plan',
      planId: row.id,
      status: row.status as UiPlanStatus,
      steps,
      currentStep: row.currentStep,
      notes: [],
      needsConfirm: row.needsConfirm,
      stepsHash: adminStepsHash(steps),
      confirmBefore: row.confirmBefore.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      marks: marksOf(steps),
      pnr,
      pnrConfirm:
        row.status === 'proposed' &&
        pnr !== null &&
        row.currentStep === pnr &&
        row.cardFrom === pnr &&
        !row.pnrConfirmedAt,
      fields: LIVE.has(row.status) ? confirmFields(steps, pnr) : [],
      chainStatus: (row.chainStatus as ChainStatus | null) ?? null,
    };
  }

  /** План тестовой сессии (для отчёта мастера) — снимков нет, только итоги. */
  async testPlans(accountId: string, testId: string) {
    return this.db(accountId).assistAdminUiPlan.findMany({
      where: { voiceTestId: testId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        dryRun: true,
        status: true,
        steps: true,
        utteranceMasked: true,
      },
    });
  }
}

/** Значения полей в плане после конца — маской (минимизация ПД). */
function maskSteps(steps: AdminPlanStepView[]): AdminPlanStepView[] {
  return steps.map((x) => ({
    ...x,
    value: x.value ? maskSensitiveEcho(x.value) : null,
  }));
}

function maskedUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    const x = new URL(u);
    return maskPageUrl(`${x.origin}${x.pathname}`).slice(0, 300);
  } catch {
    return null;
  }
}

function emptyView(kind: AdminPlanView['kind']): AdminPlanView {
  return {
    kind,
    planId: null,
    status: null,
    steps: [],
    currentStep: 0,
    notes: [],
    needsConfirm: false,
    stepsHash: null,
    confirmBefore: null,
    expiresAt: null,
  };
}

function refused(code: 'denied'): AdminPlanView {
  return { ...emptyView('plan'), notes: [{ code, target: null }] };
}

/** Чистые помощники для спеков. */
export const __test = { maskSteps, planSummary, marksOf };
