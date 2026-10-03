/**
 * Голосовой план посетителя — режим «Сайт» (Э6-бис (а); ТЗ помощника
 * §5-бис.3–6, §5-бис.9, §4-бис.5). Зовут маршруты `/widget/v1/ui-plan*`
 * (assist-widget/widget-ui-plan.controller.ts) ПОСЛЕ сессии посетителя и
 * лимитов частоты. Вся база — AssistPublicDb (роль assist_public).
 *
 * Порядок построения плана (все потолки — ДО платного вызова):
 *  1. Источник команды (§5-бис.6 п.1): `voice` — только с годным билетом
 *     голоса на ЭТОТ текст (распознано у нас); `typed` — набрано в поле
 *     нашего iframe (iframe не шлёт сюда ни `V4CAssist('ask')`, ни
 *     `postMessage` страницы). Без речи или набора плана нет.
 *  2. Доступность: рубильник, голос сайта (тариф, ключ, микрофон
 *     включён владельцем), переключатель `on`/`degraded`, правила.
 *  3. Снимок (недоверенные данные): строгий разбор, ПД маскированы ещё раз,
 *     страница — на хосте сайта и в разрешённой зоне.
 *  4. Единицы (команда — ответ диалога, §5-бис.9), потолок планов сайта в
 *     сутки (вызывающий), деньги дня (резерв сайт + платформа).
 *  5. План: прямой путь без модели (точное совпадение) или модель
 *     (temperature 0, JSON) → `checkPlan` КОДОМ → план в базе.
 * Снимок не сохраняется нигде; в журнал — только описание цели шага.
 * В лог — только id и коды (§6.6): ни текста команды, ни подписей.
 *
 * Аудит Э6-бис (03.10.2026):
 *  - шаг с побочным эффектом (клик, поле, список, флажок, переход)
 *    исполняется НЕ БОЛЕЕ ОДНОГО РАЗА: исполнитель сначала отмечает его
 *    `dispatched` (атомарно, один раз — условный UPDATE), действие — после
 *    записи; `done` такого шага без `dispatched` не принимается. Страница
 *    перезагрузилась между действием и отчётом — шаг остаётся `dispatched`,
 *    и на новой странице его НЕ повторяют: навигационный — сверка адреса,
 *    остальные — «мог уже выполниться, проверьте сами» (`skipped`,
 *    причина `interrupted`), план остановлен;
 *  - `done` навигационного шага с `expect.path` — только с адресом
 *    страницы (иначе сверять нечего);
 *  - сырые значения полей и текст команды — только пока план живой
 *    (plan-store.ts, `liveValues`); путь страницы с ПД — маской.
 */
import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { voiceTicketKey } from '../../../config/voice-env';
import {
  readVoiceControlPlatform,
  readWidgetRelease,
  releaseForSite,
  RELEASE_RE,
} from '../../../common/voice-control-platform';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import { maskSensitiveEcho } from '../../../shared/assist-chat-core/post-filter';
import { estimateCost } from '../../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../../shared/gemini-model';
import {
  readState,
  siteDailyCapMicroUsd,
} from '../../assist-billing/public/entitlements';
import type { SubscriptionState } from '../../assist-billing/subscription-state';
import { isNewDialog } from '../../assist-billing/units';
import { SiteBudget } from '../../assist-site-chat/budget';
import type {
  WidgetSiteContext,
  WidgetVisitor,
} from '../../assist-site-chat/chat-types';
import { safePageUrl } from '../../assist-site-chat/prompt';
import { insertOnlyUsageDb } from '../../assist-site-chat/usage';
import {
  confirmSeenUiElements,
  pageUiElements,
} from '../../assist-site-media/public/ui-map';
import type { UiVisitorViewport } from '../../site-core/ui-map/ui-map-model';
import { SiteVoiceService } from '../../assist-site-voice/public/site-voice.service';
import { markVoiceDialog } from '../../assist-site-voice/public/voice-dialog';
import { verifyVoiceTicket } from '../../assist-site-voice/public/voice-ticket';
import { replyKind } from '../../assist-ui-core/action-words';
import { directPlan } from '../../assist-ui-core/direct-plan';
import {
  checkPlan,
  onSiteHost,
  resolveAfterSteps,
  type RawStep,
  type UiMapRef,
} from '../../assist-ui-core/plan-checks';
import {
  buildPlanPrompt,
  parseModelPlan,
} from '../../assist-ui-core/plan-prompt';
import { neverViolation } from '../../assist-ui-core/wizard';
import { zoneAllowed } from '../../assist-ui-core/rules';
import {
  maskPageUrl,
  parseSnapshot,
  snapshotTooLarge,
} from '../../assist-ui-core/snapshot';
import {
  UI_STEP_RESULTS,
  type UiPlanStatus,
  type UiRisk,
  type UiSnapshot,
  type UiStepResult,
} from '../../assist-ui-core/types';
import { GeminiText } from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import type {
  UiPlanConfirmRequest,
  UiPlanRequest,
  UiPlanStepReport,
  UiPlanStepView,
  UiPlanStopRequest,
  UiPlanView,
} from '../api-types';
import {
  plansPerSitePerDay,
  VOICE_CONTROL_DEFAULTS,
  voiceControlAccess,
  voiceControlPlatformEnabled,
  type VoiceControlAccess,
} from '../voice-control-config';
import { claimPlanAnswer, quotaLeft } from './plan-billing';
import {
  clearDeadLiveValues,
  insertActionLog,
  insertPlan,
  readActivePlan,
  readPlan,
  readSiteVoiceControl,
  updatePlan,
  type PlanRow,
} from './plan-store';
import { tripVoiceControl } from './voice-test-store';

export const UI_PLAN_PRICING_MODEL = GEMINI_MODEL;

export interface UiPlanCtx {
  site: WidgetSiteContext;
  visitor: WidgetVisitor;
  /** Вид вёрстки посетителя (Ш4) — для подтверждения карты снимком. */
  viewport?: UiVisitorViewport;
  /**
   * Ш4: хеш IP с солью на окно устаревания (неделя) — ключ голоса «найден»
   * в журнале карты; без него — суточный `visitor.ipHash`.
   */
  voteIpHash?: string;
  /**
   * (г) Тестовая сессия мастера Т-2 (заголовок WIDGET_VOICE_TEST_HEADER,
   * проверен VoiceTestService.session): режим в любом состоянии сайта, без
   * расхода диалогов тарифа; планы помечаются `voiceTestId`.
   */
  voiceTest?: { testId: string; testHost: boolean } | null;
}

/** Отказы маршрутов плана — коды REST-ответа (assist-widget переводит). */
export type UiPlanFailure =
  | 'bad_request'
  | 'off'
  | 'not_found'
  | 'expired'
  | 'conflict'
  | 'changed'
  | 'quota'
  | 'budget'
  | 'site_limit'
  | 'upstream'
  /** Снимок больше SNAPSHOT_LIMITS.bodyChars (тело — потолок app.setup.ts). */
  | 'too_large';

export class UiPlanError extends Error {
  constructor(readonly failure: UiPlanFailure) {
    super(failure);
    this.name = 'UiPlanError';
  }
}

const fail = (f: UiPlanFailure): never => {
  throw new UiPlanError(f);
};

/** Отпечаток шагов карточки: подтверждение относится ровно к ним (§5-бис.5). */
export function stepsHash(steps: UiPlanStepView[]): string {
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

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function cleanUtterance(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return t && t.length <= VOICE_CONTROL_DEFAULTS.maxUtteranceChars ? t : null;
}

const LIVE: ReadonlySet<UiPlanStatus> = new Set([
  'proposed',
  'confirmed',
  'running',
  'paused',
]);

/**
 * Шаги с побочным эффектом на странице: исполняются не более одного раза
 * (`dispatched` до действия). Подсветка, прокрутка, ожидание и реплика —
 * без эффекта, их повтор безвреден.
 */
const EFFECT_KINDS: ReadonlySet<string> = new Set([
  'click',
  'fill',
  'select',
  'check',
  'navigate',
]);

export function hasSideEffect(s: { kind: string; nav: boolean }): boolean {
  return s.nav || EFFECT_KINDS.has(s.kind);
}

const RANK: Record<UiRisk, number> = {
  auto: 0,
  confirm: 1,
  manual: 2,
  never: 3,
};

function pathOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** Путь страницы совпал с ожиданием шага (`/x` или `/x*`). */
export function pathExpected(path: string, want: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '') || '/';
  if (want.endsWith('*')) return norm(path).startsWith(norm(want.slice(0, -1)));
  return norm(path) === norm(want);
}

@Injectable()
export class SiteUiPlanService {
  private readonly logger = new Logger(SiteUiPlanService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly db: AssistPublicDb,
    private readonly budget: SiteBudget,
    private readonly usage: AiUsageRecorder,
    private readonly model: GeminiText,
    private readonly voice: SiteVoiceService,
  ) {}

  /**
   * Есть ли режим у посетителя (конфиг виджета и маршруты). (г) Рубильник
   * платформы — env (верхняя граница) И настройка платформы в базе (её
   * выключает монитор при нарушении запрета на ≥ 2 сайтах или оператор);
   * `testSession` — тестовая сессия мастера (режим в любом состоянии).
   */
  async access(
    site: Pick<WidgetSiteContext, 'siteId'>,
    state: Pick<SubscriptionState, 'planId'>,
    testSession = false,
  ): Promise<VoiceControlAccess & { plansPerDay: number | null }> {
    const [row, voice, platform] = await Promise.all([
      readSiteVoiceControl(this.db, site.siteId),
      this.voice.access(site, state),
      readVoiceControlPlatform(this.db),
    ]);
    return {
      ...voiceControlAccess({
        platformEnabled:
          voiceControlPlatformEnabled(this.env) && platform.enabled,
        voice,
        state: row?.voiceControlSiteState,
        rules: row?.voiceControlSiteRules ?? null,
        testSession,
      }),
      plansPerDay: row?.voiceControlPlansPerDay ?? null,
    };
  }

  /** Режим всё ещё включён (рубильник, голос, переключатель, правила) — иначе `off`. */
  private async assertOn(ctx: UiPlanCtx): Promise<VoiceControlAccess> {
    const state = await readState(this.db, ctx.site.accountId, this.now());
    const access = await this.access(ctx.site, state, !!ctx.voiceTest);
    if (!access.mode || !access.rules) fail('off');
    return access;
  }

  /** Адрес страницы — на хосте сайта (мастер Т-2 проверяет снимки тем же правилом). */
  onHost(url: string, hosts: string[]): boolean {
    return onSiteHost(url, hosts);
  }

  /** Подтверждённые хосты сайта + origin страницы (проверен гвардом). */
  async siteHosts(site: WidgetSiteContext): Promise<string[]> {
    const rows = await this.db.siteHost.findMany({
      where: { siteId: site.siteId, status: 'verified' },
      select: { host: true },
    });
    const hosts = rows.map((h) => h.host);
    try {
      hosts.push(new URL(site.parentOrigin).hostname);
    } catch {
      /* origin уже проверен гвардом */
    }
    return hosts;
  }

  // ── построение плана ────────────────────────────────────────────────────

  async create(
    ctx: UiPlanCtx,
    body: UiPlanRequest,
    siteDayHit: (limit: number) => Promise<boolean>,
  ): Promise<UiPlanView> {
    const { site, visitor } = ctx;
    const now = this.now();
    const text = cleanUtterance(body?.text);
    if (!text) return fail('bad_request');
    // §5-бис.6 п.1: команда — только из речи (билет) или набора в iframe.
    let source: 'voice' | 'typed';
    if (body.source === 'voice') {
      const ok = verifyVoiceTicket(voiceTicketKey(this.env), body.voiceTicket, {
        siteId: site.siteId,
        visitorId: visitor.visitorId,
        text,
        now,
      });
      if (!ok) return fail('bad_request');
      source = 'voice';
    } else if (body.source === 'typed') {
      source = 'typed';
    } else return fail('bad_request');

    const state = await readState(this.db, site.accountId, now);
    const test = ctx.voiceTest ?? null;
    const access = await this.access(site, state, !!test);
    if (!access.mode || !access.rules) return fail('off');
    const rules = access.rules;
    // (г) Сухой прогон — только мастеру Т-2 (обычный посетитель — 400).
    const dryRun = body.dryRun === true;
    if (dryRun && !test) return fail('bad_request');
    // Выпуск чанков — метка для канарейки монитора. Аудит (г) 03.10: со
    // слов iframe — только если это ВЫПУСК ЭТОГО САЙТА по настройке
    // платформы (канарейка по хешу или стабильный); иначе посетитель своего
    // сайта вне канарейки метил бы планы канареечным выпуском и проваливал
    // их — ложный откат выпуска всей платформе.
    const release =
      typeof body.release === 'string' &&
      RELEASE_RE.test(body.release) &&
      body.release ===
        releaseForSite(
          site.siteId,
          await readWidgetRelease(this.db, now.getTime()),
        )
        ? body.release
        : null;
    // Тестовая сессия мастера, как предпросмотр, не тратит диалогов тарифа
    // и потолка планов сайта (деньги дня — резервируются как обычно).
    const free = site.preview || !!test;

    if (snapshotTooLarge(body.snapshot)) return fail('too_large');
    const snapshot = parseSnapshot(body.snapshot);
    if (!snapshot) return fail('bad_request');
    const hosts = await this.siteHosts(site);
    if (!onSiteHost(snapshot.url, hosts)) return fail('bad_request');
    await this.confirmSeen(ctx, snapshot, hosts, now);
    await clearDeadLiveValues(this.db, {
      siteId: site.siteId,
      visitorId: visitor.visitorId,
      now,
    });
    const pagePath = pathOf(snapshot.url) ?? '/';
    const lang =
      body.lang === 'uk' || body.lang === 'ru' || body.lang === 'en'
        ? body.lang
        : null;
    if (!zoneAllowed(pagePath, rules)) {
      // Страница вне зоны владельца — плана нет, ни денег, ни единиц.
      return refusedView('denied');
    }

    // ── единицы и потолок планов сайта ──
    if (!free && !(await quotaLeft(this.db, site.accountId, state)))
      return fail('quota');
    // Потолок — оверрайд оператора (решение владельца п.2) или тариф.
    const dayCap = plansPerSitePerDay(access.plansPerDay, state.planId);
    if (!free && !(await siteDayHit(dayCap))) return fail('site_limit');

    // ── план: прямой путь или модель ──
    let raw: RawStep[] | null = directPlan(text, snapshot);
    const direct = raw !== null;
    let command = true;
    const map = await this.mapRefs(ctx, snapshot.url, hosts);
    if (!raw) {
      const prompt = buildPlanPrompt({
        transcript: text,
        snapshot,
        map,
        lang: lang ?? 'uk',
      });
      const est = estimateCost(UI_PLAN_PRICING_MODEL, {
        inputTokens: Math.max(
          VOICE_CONTROL_DEFAULTS.reserveInputTokens,
          Math.ceil((prompt.system.length + prompt.user.length) / 2),
        ),
        outputTokens: VOICE_CONTROL_DEFAULTS.maxOutputTokens,
      }).costMicroUsd;
      const capRow = await this.db.$queryRawUnsafe<
        Array<{ cap: number | null }>
      >(
        `SELECT "dailyCapMicroUsd" AS cap FROM "sites"."assist_sites" WHERE "siteId" = $1`,
        site.siteId,
      );
      const cap = capRow[0]?.cap;
      const reserved = await this.budget.reserve(this.db, {
        siteId: site.siteId,
        siteCapMicroUsd: siteDailyCapMicroUsd(
          cap === null || cap === undefined ? null : Number(cap),
          state,
        ),
        estMicroUsd: Math.max(1_000, est),
        now,
      });
      if (!reserved.ok) {
        this.logger.warn(`ui-plan: ${reserved.denied} (site ${site.siteId})`);
        return fail('budget');
      }
      let actual = 0;
      let out: string;
      try {
        const r = await this.model.generate({
          system: prompt.system,
          user: prompt.user,
          json: true,
          temperature: 0,
          maxOutputTokens: VOICE_CONTROL_DEFAULTS.maxOutputTokens,
          timeoutMs: VOICE_CONTROL_DEFAULTS.modelTimeoutMs,
        });
        out = r.text;
        const u = await this.usage.record(insertOnlyUsageDb(this.db), {
          accountId: site.accountId,
          siteId: site.siteId,
          operation: 'assist-ui-plan',
          model: r.model,
          units: {
            inputTokens: r.inputTokens,
            cachedInputTokens: r.cachedInputTokens,
            outputTokens: r.outputTokens,
          },
        });
        actual = u.costMicroUsd;
      } catch (e) {
        this.logger.warn(
          `ui-plan model failed site=${site.siteId}: ${(e as Error | null)?.name ?? 'Error'}`,
        );
        return fail('upstream');
      } finally {
        await this.budget.settle(this.db, reserved.reservation, actual);
      }
      const parsed = parseModelPlan(out);
      if (!parsed) return fail('upstream');
      command = parsed.command;
      raw = parsed.steps;
    }
    if (!command) return notCommandView();

    // ── проверка кодом ──
    const checked = checkPlan({
      transcript: text,
      snapshot,
      map,
      steps: raw,
      rules,
      hosts,
      state: access.mode,
    });

    // ── диалог, единицы, план ──
    const conversationId = await this.conversation(
      ctx,
      body,
      snapshot.url,
      hosts,
      now,
    );
    if (source === 'voice')
      await markVoiceDialog(this.db, {
        accountId: site.accountId,
        conversationId,
        state,
        preview: site.preview,
      });
    if (
      !free &&
      !(await claimPlanAnswer(this.db, {
        accountId: site.accountId,
        conversationId,
        state,
      }))
    )
      return fail('quota');

    const steps: UiPlanStepView[] = checked.steps.map((s) => ({
      ...s,
      state: 'pending',
    }));
    const executable = steps.length > 0;
    // Сухой прогон: план проверен и показан (подсветка в iframe мастера),
    // исполнять нечего — сразу `done`, без сырых значений.
    const status: UiPlanStatus = !executable
      ? 'failed'
      : dryRun
        ? 'done'
        : checked.needsConfirm
          ? 'proposed'
          : 'confirmed';
    const confirmBefore = new Date(
      now.getTime() + VOICE_CONTROL_DEFAULTS.confirmWindowMs,
    );
    const expiresAt = new Date(
      now.getTime() + VOICE_CONTROL_DEFAULTS.planTtlMs,
    );
    const planId = await insertPlan(this.db, {
      accountId: site.accountId,
      siteId: site.siteId,
      conversationId,
      visitorId: visitor.visitorId,
      utteranceMasked: maskSensitiveEcho(text),
      utterance: text,
      source,
      lang,
      pageUrl: snapshot.url,
      steps,
      status,
      needsConfirm: !dryRun && checked.needsConfirm,
      confirmedBy: dryRun ? 'dry' : checked.needsConfirm ? null : 'auto',
      confirmBefore,
      expiresAt,
      voiceTestId: test?.testId ?? null,
      dryRun,
      release,
    });
    // Журнал: сам план и каждая отказанная цель (метрика «0 нарушений» Т-4
    // считает попытки по запрещённым целям — часть (г)).
    const top = steps.reduce<UiRisk>(
      (a, s) => (RANK[s.risk] > RANK[a] ? s.risk : a),
      'auto',
    );
    await insertActionLog(this.db, {
      accountId: site.accountId,
      siteId: site.siteId,
      planId,
      stepIndex: 0,
      action: 'plan',
      target: null,
      url: snapshot.url,
      risk: top,
      confirmedBy: dryRun ? 'dry' : checked.needsConfirm ? null : 'auto',
      result: !executable ? 'skipped' : dryRun ? 'dryrun' : 'proposed',
      reason:
        checked.notes
          .map((n) => n.code)
          .join(',')
          .slice(0, 200) || null,
      valueMasked: null,
      durationMs: null,
    });
    for (const n of checked.notes)
      await insertActionLog(this.db, {
        accountId: site.accountId,
        siteId: site.siteId,
        planId,
        stepIndex: 0,
        action: 'refused',
        target: n.target ? { text: n.target } : null,
        url: snapshot.url,
        risk: 'never',
        confirmedBy: null,
        result: 'skipped',
        reason: n.code,
        valueMasked: null,
        durationMs: null,
      });
    await this.touch(conversationId, now);
    this.logger.log(
      `ui-plan site=${site.siteId} plan=${planId} steps=${steps.length} confirm=${checked.needsConfirm} notes=${checked.notes.length} direct=${direct}`,
    );
    return {
      kind: 'plan',
      planId,
      conversationId,
      status,
      steps,
      currentStep: 0,
      notes: checked.notes,
      needsConfirm: !dryRun && checked.needsConfirm,
      stepsHash: stepsHash(steps),
      confirmBefore: confirmBefore.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Ш4: снимок загрузчика — браузерное подтверждение элементов карты этой
   * страницы (`lastSeenAt`, сброс промахов своего вида у УЖЕ известных;
   * новых не создаёт, снимок не хранит). Сбой — не повод отказать в плане.
   */
  private async confirmSeen(
    ctx: UiPlanCtx,
    snapshot: UiSnapshot,
    hosts: string[],
    now: Date,
  ): Promise<void> {
    if (!ctx.viewport) return;
    try {
      await confirmSeenUiElements(this.db, {
        accountId: ctx.site.accountId,
        siteId: ctx.site.siteId,
        visitorId: ctx.visitor.visitorId,
        ipHash: ctx.voteIpHash ?? ctx.visitor.ipHash,
        pageUrl: snapshot.url,
        siteHosts: hosts,
        viewport: ctx.viewport,
        seen: snapshot.elements.map((e) => ({
          tag: e.tag,
          label: e.text,
          assistId: e.assistId,
          role: e.role,
        })),
        now,
      });
    } catch {
      /* карта — справочно */
    }
  }

  /**
   * Карта интерфейса страницы (Э6/Ш4) — запасной путь поиска цели (m1…m20):
   * элементы СВОЕГО вида вёрстки посетителя (снятое на телефоне компьютеру
   * не предлагается) и без устаревших для этого вида.
   */
  private async mapRefs(
    ctx: UiPlanCtx,
    pageUrl: string,
    hosts: string[],
  ): Promise<UiMapRef[]> {
    try {
      const els = await pageUiElements(
        this.db,
        ctx.site.siteId,
        pageUrl,
        hosts,
        { viewport: ctx.viewport },
      );
      return els
        .slice(0, VOICE_CONTROL_DEFAULTS.promptMapElements)
        .map((e, i) => ({
          ref: `m${i + 1}`,
          selector: e.selector,
          label: e.label,
          tag: e.tag,
        }));
    } catch {
      return [];
    }
  }

  /** Диалог посетителя: тот же, если он его; иначе — новый (как чат). */
  private async conversation(
    ctx: UiPlanCtx,
    body: UiPlanRequest,
    pageUrl: string,
    hosts: string[],
    now: Date,
  ): Promise<string> {
    const { site, visitor } = ctx;
    const id =
      typeof body.conversationId === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(body.conversationId)
        ? body.conversationId
        : null;
    const conv = id
      ? await this.db.assistSiteConversation.findFirst({
          where: { id, siteId: site.siteId, visitorId: visitor.visitorId },
          select: { id: true, lastMessageAt: true },
        })
      : null;
    if (conv) {
      if (isNewDialog(conv.lastMessageAt, now))
        await this.db.assistSiteConversation.update({
          where: { id: conv.id },
          data: { answers: 0, dialogCounted: false, voice: false },
          select: { id: true },
        });
      return conv.id;
    }
    const created = await this.db.assistSiteConversation.create({
      data: {
        accountId: site.accountId,
        siteId: site.siteId,
        visitorId: visitor.visitorId,
        ipHash: visitor.ipHash,
        parentOrigin: site.parentOrigin,
        pageUrl: safePageUrl(pageUrl, hosts),
        locale: body.lang ?? null,
        openedBy: 'user',
        lastMessageAt: now,
      },
      select: { id: true },
    });
    return created.id;
  }

  private async touch(convId: string, at: Date): Promise<void> {
    await this.db.assistSiteConversation.update({
      where: { id: convId },
      data: { lastMessageAt: at, stateVersion: { increment: 1 } },
      select: { id: true },
    });
  }

  // ── подтверждение, шаги, стоп, продолжение ──────────────────────────────

  private async load(ctx: UiPlanCtx, id: string): Promise<PlanRow> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail('not_found');
    const plan = await readPlan(this.db, {
      id,
      siteId: ctx.site.siteId,
      visitorId: ctx.visitor.visitorId,
    });
    if (!plan) return fail('not_found');
    return plan;
  }

  /** Живой план с истёкшим сроком — `expired` (условно) и отказ. */
  private async expireIfDue(ctx: UiPlanCtx, plan: PlanRow): Promise<void> {
    if (
      !LIVE.has(plan.status) ||
      plan.expiresAt.getTime() > this.now().getTime()
    )
      return;
    await updatePlan(this.db, plan, this.who(ctx), {
      steps: plan.steps,
      currentStep: plan.currentStep,
      status: 'expired',
      needsConfirm: plan.needsConfirm,
      confirmedBy: plan.confirmedBy,
    });
    fail('expired');
  }

  private who(ctx: UiPlanCtx) {
    return { siteId: ctx.site.siteId, visitorId: ctx.visitor.visitorId };
  }

  async confirm(
    ctx: UiPlanCtx,
    id: string,
    body: UiPlanConfirmRequest,
  ): Promise<UiPlanView> {
    const plan = await this.load(ctx, id);
    // Повтор «Да» после перезагрузки — тот же ответ, исполнения нет (§4-бис.5).
    if (plan.status !== 'proposed') {
      if (plan.confirmedBy && plan.status !== 'expired') return view(plan);
      return fail('conflict');
    }
    await this.expireIfDue(ctx, plan);
    const now = this.now();
    if (now.getTime() > plan.confirmBefore.getTime()) {
      await updatePlan(this.db, plan, this.who(ctx), {
        steps: plan.steps,
        currentStep: plan.currentStep,
        status: 'expired',
        needsConfirm: plan.needsConfirm,
        confirmedBy: null,
      });
      return fail('expired');
    }
    // Карточка показывала ЭТИ шаги — иначе новое подтверждение.
    if (body?.stepsHash !== stepsHash(plan.steps)) return fail('changed');
    let by: 'button' | 'voice';
    if (body.by === 'button') by = 'button';
    else if (body.by === 'voice') {
      const text = cleanUtterance(body.text) ?? '';
      const ok =
        !!text &&
        verifyVoiceTicket(voiceTicketKey(this.env), body.voiceTicket, {
          siteId: ctx.site.siteId,
          visitorId: ctx.visitor.visitorId,
          text,
          now,
        });
      if (!ok) return fail('bad_request');
      const r = replyKind(text);
      if (r === 'no' || r === 'stop')
        return this.stop(ctx, id, { by: 'voice' });
      if (r !== 'yes') return fail('bad_request');
      by = 'voice';
    } else return fail('bad_request');
    // Владелец выключил режим после показа карточки — «Да» уже не исполняет.
    await this.assertOn(ctx);
    const ok = await updatePlan(this.db, plan, this.who(ctx), {
      steps: plan.steps,
      currentStep: plan.currentStep,
      status: 'confirmed',
      needsConfirm: plan.needsConfirm,
      confirmedBy: by,
    });
    if (!ok) {
      const again = await this.load(ctx, id);
      if (again.confirmedBy) return view(again);
      return fail('conflict');
    }
    await insertActionLog(this.db, {
      accountId: ctx.site.accountId,
      siteId: ctx.site.siteId,
      planId: plan.id,
      stepIndex: plan.currentStep,
      action: 'confirm',
      target: null,
      url: null,
      risk: 'confirm',
      confirmedBy: by,
      result: 'done',
      reason: null,
      valueMasked: null,
      durationMs: null,
    });
    return view({ ...plan, status: 'confirmed', confirmedBy: by });
  }

  async step(
    ctx: UiPlanCtx,
    id: string,
    body: UiPlanStepReport,
  ): Promise<UiPlanView> {
    const plan = await this.load(ctx, id);
    await this.expireIfDue(ctx, plan);
    const result = body?.result;
    if (!(UI_STEP_RESULTS as readonly unknown[]).includes(result))
      return fail('bad_request');
    if (plan.status !== 'confirmed' && plan.status !== 'running')
      return fail('conflict');
    const idx = body.index;
    if (idx !== plan.currentStep || !plan.steps[idx]) return fail('conflict');
    // Выключение режима останавливает и идущий план: следующий клик
    // (`dispatched` ждёт записи) и продвижение плана сервер не принимает;
    // отказ/стоп/«нажмите сами» — принимает всегда.
    const s = plan.steps[idx];
    if (result === 'dispatched' || result === 'done') {
      const access = await this.assertOn(ctx);
      // (г) Последний рубеж (§5-бис.14 «нарушение запрета»): шаг, который
      // вот-вот исполнится (или исполнен), — цель класса «никогда». Проверки
      // плана такого не пропускают: это дефект кода или подмена шага. Сайт
      // — в `off` сразу (функция базы умеет только выключить), шаг не
      // подтверждается (`dispatched` без записи — клика не будет), монитор
      // пишет инцидент и шлёт уведомления.
      if (hasSideEffect(s)) {
        const why = neverViolation(s, {
          rules: access.rules as NonNullable<typeof access.rules>,
          hosts: await this.siteHosts(ctx.site),
        });
        // Аудит (г) 03.10: запрет КАБИНЕТА (`denied` — слова/пути
        // владельца) мог появиться ПОСЛЕ плана — владелец правит список во
        // время идущего плана (мастер Т-2 сам предлагает запреты). Это не
        // дефект кода: шаг не исполняется, план — провал, в журнал —
        // «стоп-лист при исполнении»; ни предохранителя, ни счёта к
        // рубильнику платформы (иначе любой кабинет выключал бы режим всей
        // платформе правкой своих запретов на двух сайтах).
        if (why === 'denied') {
          await this.deniedLive(ctx, plan, idx, s);
          return fail('conflict');
        }
        if (why) {
          await this.violation(ctx, plan, idx, s, why);
          return fail('off');
        }
      }
    }
    const steps = plan.steps.map((x) => ({ ...x }));
    let currentStep = plan.currentStep;
    let status: UiPlanStatus = 'running';
    const last = idx === plan.steps.length - 1;
    const auto = s.risk === 'auto' || s.risk === 'confirm';
    const effect = hasSideEffect(s);
    let logged: UiStepResult = result as UiStepResult;
    switch (result as UiStepResult) {
      case 'dispatched':
        // `dispatched` — ДО действия с побочным эффектом и ровно один раз
        // (§4-бис.5, аудит Э6-бис): перезагрузка страницы до `done` не
        // приведёт к повтору — шаг уже не `pending`.
        if (!effect || !auto || s.state !== 'pending') return fail('conflict');
        steps[idx].state = 'dispatched';
        break;
      case 'done': {
        if (!auto) return fail('conflict');
        if (effect && s.state !== 'dispatched') return fail('conflict');
        const path = pathOf(body.url);
        // Навигация с ожидаемым адресом: без адреса сверять нечего — отказ
        // (iframe после перехода шлёт адрес новой страницы).
        if (s.nav && s.expect?.path && !path) return fail('bad_request');
        if (
          s.nav &&
          s.expect?.path &&
          path &&
          !pathExpected(path, s.expect.path)
        ) {
          // Страница не та — «план остановлен» (§4-бис.5), не продолжаем.
          steps[idx].state = 'failed';
          status = 'failed';
          logged = 'failed';
          break;
        }
        steps[idx].state = 'done';
        currentStep = idx + 1;
        status = last ? 'done' : 'running';
        break;
      }
      case 'manual':
        if (auto) return fail('conflict');
        steps[idx].state = 'manual';
        currentStep = idx + 1;
        status = 'done';
        break;
      case 'skipped':
      case 'failed':
        steps[idx].state = result as UiStepResult;
        status = 'failed';
        break;
      case 'stopped':
        steps[idx].state = 'stopped';
        status = 'stopped';
        break;
    }
    const ok = await updatePlan(this.db, plan, this.who(ctx), {
      steps,
      currentStep,
      status,
      needsConfirm: plan.needsConfirm,
      confirmedBy: plan.confirmedBy,
    });
    if (!ok) return fail('conflict');
    await insertActionLog(this.db, {
      accountId: ctx.site.accountId,
      siteId: ctx.site.siteId,
      planId: plan.id,
      stepIndex: idx,
      action: s.kind,
      target: s.target
        ? {
            role: s.target.role,
            text: s.target.text,
            assistId: s.target.assistId,
            path: pathOf(s.target.href),
          }
        : null,
      url: (() => {
        const u = body.url;
        if (typeof u !== 'string') return null;
        try {
          const x = new URL(u);
          return maskPageUrl(`${x.origin}${x.pathname}`).slice(0, 300);
        } catch {
          return null;
        }
      })(),
      risk: s.risk,
      confirmedBy: plan.confirmedBy,
      result: logged,
      reason:
        typeof body.reason === 'string'
          ? body.reason.replace(/[^a-z_]/g, '').slice(0, 40) || null
          : s.reason,
      valueMasked: s.value ? maskSensitiveEcho(s.value) : null,
      durationMs:
        typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
          ? Math.max(0, Math.min(600_000, Math.round(body.durationMs)))
          : null,
    });
    return view({ ...plan, steps, currentStep, status });
  }

  /**
   * Цель шага попала под запрет кабинета, введённый после плана: шаг —
   * `failed` (причина `denied`, монитор считает это «стоп-листом при
   * исполнении»), план — провал; сайт не выключается.
   */
  private async deniedLive(
    ctx: UiPlanCtx,
    plan: PlanRow,
    idx: number,
    s: UiPlanStepView,
  ): Promise<void> {
    const steps = plan.steps.map((x) => ({ ...x }));
    steps[idx].state = 'failed';
    await updatePlan(this.db, plan, this.who(ctx), {
      steps,
      currentStep: plan.currentStep,
      status: 'failed',
      needsConfirm: plan.needsConfirm,
      confirmedBy: plan.confirmedBy,
    });
    await insertActionLog(this.db, {
      accountId: ctx.site.accountId,
      siteId: ctx.site.siteId,
      planId: plan.id,
      stepIndex: idx,
      action: s.kind,
      target: s.target
        ? {
            role: s.target.role,
            text: s.target.text,
            assistId: s.target.assistId,
            path: pathOf(s.target.href),
          }
        : null,
      url: null,
      risk: 'never',
      confirmedBy: plan.confirmedBy,
      result: 'failed',
      reason: 'denied',
      valueMasked: null,
      durationMs: null,
    });
  }

  /** Нарушение запрета: журнал, план стоп, сайт — `off` (предохранитель базы). */
  private async violation(
    ctx: UiPlanCtx,
    plan: PlanRow,
    idx: number,
    s: UiPlanStepView,
    why: string,
  ): Promise<void> {
    await insertActionLog(this.db, {
      accountId: ctx.site.accountId,
      siteId: ctx.site.siteId,
      planId: plan.id,
      stepIndex: idx,
      action: 'violation',
      target: s.target
        ? {
            role: s.target.role,
            text: s.target.text,
            assistId: s.target.assistId,
            path: pathOf(s.target.href),
          }
        : null,
      url: null,
      risk: 'never',
      confirmedBy: plan.confirmedBy,
      result: 'failed',
      reason: why,
      valueMasked: null,
      durationMs: null,
    });
    await updatePlan(this.db, plan, this.who(ctx), {
      steps: plan.steps,
      currentStep: plan.currentStep,
      status: 'stopped',
      needsConfirm: plan.needsConfirm,
      confirmedBy: plan.confirmedBy,
    });
    // Тестовая сессия мастера сайт сразу не выключает — её план и так не
    // на посетителях; нарушение в журнале, и монитор на ближайшем проходе
    // (≤ 10 мин) выключит сайт и пришлёт инцидент (аудит (г): так задумано
    // — нарушение запрета есть дефект кода и в тестовой сессии).
    if (!ctx.voiceTest)
      await tripVoiceControl(this.db, {
        siteId: ctx.site.siteId,
        reason: `violation:${why}`,
      });
    this.logger.error(
      `ui-plan VIOLATION site=${ctx.site.siteId} plan=${plan.id} step=${idx} reason=${why}`,
    );
  }

  async stop(
    ctx: UiPlanCtx,
    id: string,
    body: UiPlanStopRequest,
  ): Promise<UiPlanView> {
    const plan = await this.load(ctx, id);
    if (!LIVE.has(plan.status)) return view(plan);
    const by = ['button', 'esc', 'click', 'voice', 'close'].includes(body?.by)
      ? body.by
      : 'button';
    const ok = await updatePlan(this.db, plan, this.who(ctx), {
      steps: plan.steps,
      currentStep: plan.currentStep,
      status: 'stopped',
      needsConfirm: plan.needsConfirm,
      confirmedBy: plan.confirmedBy,
    });
    if (!ok) return view(await this.load(ctx, id));
    await insertActionLog(this.db, {
      accountId: ctx.site.accountId,
      siteId: ctx.site.siteId,
      planId: plan.id,
      stepIndex: plan.currentStep,
      action: 'stop',
      target: null,
      url: null,
      risk: 'auto',
      confirmedBy: plan.confirmedBy,
      result: 'stopped',
      reason: by,
      valueMasked: null,
      durationMs: null,
    });
    return view({ ...plan, status: 'stopped' });
  }

  /** Живой план посетителя — iframe продолжает его на новой странице. */
  async active(ctx: UiPlanCtx): Promise<UiPlanView | null> {
    const now = this.now();
    await clearDeadLiveValues(this.db, { ...this.who(ctx), now });
    const plan = await readActivePlan(this.db, { ...this.who(ctx), now });
    return plan ? view(plan) : null;
  }

  /**
   * Продолжение на новой странице: шаги `after` получают цели из нового
   * снимка и проходят те же проверки (риск только растёт).
   */
  async resume(
    ctx: UiPlanCtx,
    id: string,
    body: { snapshot: unknown },
  ): Promise<UiPlanView> {
    const plan = await this.load(ctx, id);
    await this.expireIfDue(ctx, plan);
    if (plan.status !== 'confirmed' && plan.status !== 'running')
      return fail('conflict');
    const now = this.now();
    const state = await readState(this.db, ctx.site.accountId, now);
    const access = await this.access(ctx.site, state, !!ctx.voiceTest);
    if (!access.mode || !access.rules) return fail('off');
    if (snapshotTooLarge(body?.snapshot)) return fail('too_large');
    const snapshot = parseSnapshot(body?.snapshot);
    if (!snapshot) return fail('bad_request');
    const hosts = await this.siteHosts(ctx.site);
    if (!onSiteHost(snapshot.url, hosts)) return fail('bad_request');
    await this.confirmSeen(ctx, snapshot, hosts, now);
    if (!zoneAllowed(pathOf(snapshot.url) ?? '/', access.rules))
      return this.stop(ctx, id, { by: 'close' });
    const r = resolveAfterSteps({
      steps: plan.steps,
      from: plan.currentStep,
      snapshot,
      // Сырой текст команды (пока план живой): значения с телефоном/e-mail
      // сверяются посимвольно — маска их не нашла бы.
      transcript: plan.utterance,
      rules: access.rules,
      hosts,
      state: access.mode,
    });
    const steps = r.steps.map((s, i) => ({
      ...s,
      state: plan.steps[i]?.state ?? 'pending',
    })) as UiPlanStepView[];
    let status: UiPlanStatus = plan.status;
    let needsConfirm = plan.needsConfirm;
    let confirmedBy = plan.confirmedBy;
    if (r.unresolved !== null) {
      steps[r.unresolved].state = 'failed';
      status = 'failed';
    } else if (r.needsConfirm) {
      // Шаг стал «с подтверждением» — новая карточка (§5-бис.5).
      status = 'proposed';
      needsConfirm = true;
      confirmedBy = null;
    }
    const confirmBefore =
      status === 'proposed'
        ? new Date(now.getTime() + VOICE_CONTROL_DEFAULTS.confirmWindowMs)
        : null;
    const ok = await updatePlan(this.db, plan, this.who(ctx), {
      steps,
      currentStep: plan.currentStep,
      status,
      needsConfirm,
      confirmedBy,
      confirmBefore,
    });
    if (!ok) return fail('conflict');
    if (r.unresolved !== null)
      await insertActionLog(this.db, {
        accountId: ctx.site.accountId,
        siteId: ctx.site.siteId,
        planId: plan.id,
        stepIndex: r.unresolved,
        action: plan.steps[r.unresolved].kind,
        target: { text: plan.steps[r.unresolved].target?.text ?? null },
        url: snapshot.url,
        risk: plan.steps[r.unresolved].risk,
        confirmedBy,
        result: 'failed',
        reason: 'no_target',
        valueMasked: null,
        durationMs: null,
      });
    // Новое окно подтверждения — с момента новой карточки.
    return view({
      ...plan,
      steps,
      status,
      needsConfirm,
      confirmedBy,
      confirmBefore: confirmBefore ?? plan.confirmBefore,
    });
  }
}

function view(plan: PlanRow): UiPlanView {
  return {
    kind: 'plan',
    planId: plan.id,
    conversationId: plan.conversationId,
    status: plan.status,
    steps: plan.steps,
    currentStep: plan.currentStep,
    notes: [],
    needsConfirm: plan.needsConfirm,
    stepsHash: stepsHash(plan.steps),
    confirmBefore: plan.confirmBefore.toISOString(),
    expiresAt: plan.expiresAt.toISOString(),
  };
}

function notCommandView(): UiPlanView {
  return {
    kind: 'not_command',
    planId: null,
    conversationId: null,
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

function refusedView(code: 'denied'): UiPlanView {
  return { ...notCommandView(), kind: 'plan', notes: [{ code, target: null }] };
}
