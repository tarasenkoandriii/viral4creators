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
 *
 * Цепочки (Э6-бис (д), §5-бис.15; Р-59, Р-60, Р-63…Р-65):
 *  - класс обратимости каждого шага и точка невозврата (ТН) — кодом
 *    (`checkPlan`); ≤ 1 ТН на команду; второе «Да» прямо перед ТН, если
 *    после карточки был переход или прошло > 60 с (`needsSecondYes`);
 *  - при завершении — статус цепочки (`chainStatus`); после сбоя/стопа
 *    iframe предлагает «Вернуть / Оставить», «отмени последнее» — тот же
 *    маршрут `undo` (поля — из памяти загрузчика, серверное — «уберите
 *    сами» до Э6-тер (и)); единицы не тратятся, потолок планов — да.
 * Мемо (Э6-бис (е), §5-бис.17; Р-61, Р-62, Р-68…Р-72):
 *  - выбор: прямой путь по фразе опубликованного мемо (без модели, без
 *    единиц) → lite-выбор БЕЗ снимка страницы → обычный план;
 *  - шаги — из ЗАКРЕПЛЁННОЙ версии, цели — по отпечатку `pin` (не сошёлся —
 *    `pinMismatch`, 0 кликов), значения — только слоты; дальше тот же
 *    `checkPlan`; в конце — проверка цели (`goalStatus`);
 *  - мемо выключили/«требует проверки» во время плана — следующий шаг не
 *    исполняется; повтор того же мемо в 60 с — вопрос «повторить?».
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
import {
  chainAfterUndo,
  chainStatusOf,
  needsSecondYes,
  pointOfNoReturn,
  undoCandidates,
  type UndoResult,
} from '../../assist-ui-core/chain';
import {
  CHAIN_DECISIONS,
  MEMO_DECISIONS,
} from '../../assist-ui-core/decisions';
import { directPlan, looksLikeCommand } from '../../assist-ui-core/direct-plan';
import {
  buildMemoChoicePrompt,
  checkSlots,
  compileMemo,
  directMemo,
  memoMentioned,
  MEMO_LANGS,
  MEMO_LIMITS,
  memoApplies,
  parseMemoChoice,
  type MemoLang,
  type MemoSlotValues,
  type PublishedMemo,
} from '../../assist-ui-core/memo';
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
  type ChainStatus,
  type GoalStatus,
  type UiPin,
  type UiPlanNote,
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
  UiSkillsView,
  UiUndoReport,
  UiUndoRequest,
  UiUndoView,
} from '../api-types';
import {
  plansPerSitePerDay,
  VOICE_CONTROL_DEFAULTS,
  voiceControlAccess,
  voiceControlPlatformEnabled,
  type VoiceControlAccess,
} from '../voice-control-config';
import { memoAlive, memoGoalRates, readPublishedMemos } from './memo-store';
import { claimPlanAnswer, quotaLeft } from './plan-billing';
import {
  clearDeadLiveValues,
  insertActionLog,
  insertPlan,
  readActivePlan,
  readPlan,
  readSiteVoiceControl,
  recentSameMemo,
  updateChainStatus,
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

    // ── (е) мемо: прямой путь по фразе — до единиц и денег ──
    // Мемо — только в `on` (и тестовой сессии мастера); в `degraded` план
    // мемо ниже станет подсветкой первого шага (`checkPlan` со state).
    const memos = dryRun
      ? []
      : (await this.memosFor(site.siteId)).filter((m) =>
          memoApplies(m, pagePath, ctx.viewport ?? null),
        );
    let memo: MemoPick | null = null;
    if (memos.length) {
      const d = directMemo(text, memos, now);
      if (d) memo = { ...d, via: 'direct' };
    }
    // Фраза мемо может не начинаться с глагола («запис на консультацію»):
    // iframe шлёт сюда и такие тексты, если у сайта есть мемо. Не мемо и не
    // команда — вопрос в чат, без денег и единиц.
    // Lite-выбор — только если команда делит слово с именем/фразой/целью
    // какого-то мемо шаблона («поклади футболку і покажи кошик»).
    const memoish = !memo && memos.some((m) => memoMentioned(text, m.content));
    if (!memo && !memoish && !looksLikeCommand(text)) return notCommandView();

    // ── единицы и потолок планов сайта ──
    // В-72 (Р-70): мемо прямым путём единиц не тратит; потолок — общий.
    const unitsFree =
      free || (memo?.via === 'direct' && !MEMO_DECISIONS.directMemoSpendsUnits);
    if (!unitsFree && !(await quotaLeft(this.db, site.accountId, state)))
      return fail('quota');
    // Потолок — оверрайд оператора (решение владельца п.2) или тариф.
    const dayCap = plansPerSitePerDay(access.plansPerDay, state.planId);
    if (!free && !(await siteDayHit(dayCap))) return fail('site_limit');

    // ── (е) lite-выбор мемо моделью БЕЗ снимка страницы ──
    let memoNotes: UiPlanNote[] = [];
    if (!memo && memoish) {
      memo = await this.chooseMemo(ctx, {
        text,
        memos,
        lang: lang ?? 'uk',
        now,
        state,
      });
      // Не мемо и не команда — вопрос в чат (единиц не тратим).
      if (!memo && !looksLikeCommand(text)) return notCommandView();
    }

    // ── план: мемо, прямой путь или модель ──
    let raw: RawStep[] | null = null;
    let pins: Array<UiPin | null> | undefined;
    let trusted: string[] = [];
    let goalRaw: number | null = null;
    let pinMismatchAt: number | null = null;
    let origin: 'model' | 'direct' | 'memo' = 'model';
    if (memo) {
      const comp = compileMemo(memo.memo.content, memo.values, snapshot);
      raw = comp.raw;
      pins = comp.pins;
      // Признанные кодом значения: слоты (`checkSlots`) и константы ВЕРСИИ
      // (их проверили ворота: не ПД, не свободный текст формы, §5-бис.17
      // п.3). Без констант `select`/поиск с константой вычёркивался
      // `value_not_said` — мемо обрывалось (аудит 03.10). Живой список
      // вариантов `select` по-прежнему сверяет `judgeStep`.
      trusted = [
        ...memo.trusted,
        ...memo.memo.content.steps.flatMap((s) =>
          s.value && 'const' in s.value ? [s.value.const] : [],
        ),
      ];
      goalRaw = comp.goalFrom;
      pinMismatchAt = comp.pinMismatchAt;
      origin = 'memo';
      const stepText = (i: number | null) =>
        i === null
          ? null
          : (memo?.memo.content.steps[i]?.target?.pin.text ?? null);
      if (comp.pinMismatchAt !== null)
        memoNotes = [
          { code: 'pin_mismatch', target: stepText(comp.pinMismatchAt) },
        ];
      else if (comp.missingAt !== null)
        memoNotes = [{ code: 'no_target', target: stepText(comp.missingAt) }];
    } else {
      raw = directPlan(text, snapshot);
      if (raw) origin = 'direct';
    }
    let command = true;
    const map = memo ? [] : await this.mapRefs(ctx, snapshot.url, hosts);
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
      const out = await this.paidModelCall(ctx, state, {
        system: prompt.system,
        user: prompt.user,
        estMicroUsd: Math.max(1_000, est),
        maxOutputTokens: VOICE_CONTROL_DEFAULTS.maxOutputTokens,
        timeoutMs: VOICE_CONTROL_DEFAULTS.modelTimeoutMs,
        now,
      });
      const parsed = parseModelPlan(out);
      if (!parsed) return fail('upstream');
      command = parsed.command;
      raw = parsed.steps;
    }
    if (!command) return notCommandView();

    // ── проверка кодом (мемо — подсказка, а не разрешение: те же проверки) ──
    const checked = checkPlan({
      transcript: text,
      snapshot,
      map,
      steps: raw,
      rules,
      hosts,
      state: access.mode,
      ...(memo
        ? {
            trusted,
            pins,
            extraSteps: MEMO_LIMITS.goalSteps,
          }
        : {}),
    });
    let checkedSteps = checked.steps;
    let goalFrom: number | null = null;
    if (memo) {
      // Мемо — цепочка без дыр: шаг вычеркнут — дальше не идём (цель не
      // проверяем — её не достичь), номера шагов — как в версии.
      let k = 0;
      while (k < checked.from.length && checked.from[k] === k) k++;
      checkedSteps = checked.steps.slice(0, k);
      goalFrom = goalRaw !== null && goalRaw < k ? goalRaw : null;
    }
    const notes = [...memoNotes, ...checked.notes];
    const needsConfirm = checkedSteps.some((s) => s.risk === 'confirm');

    // ── (е) повтор того же мемо с теми же слотами в 60 с — вопрос ──
    let repeat = false;
    let slotsHash: string | null = null;
    if (memo) {
      slotsHash = memoSlotsHash(memo.memo, memo.values);
      repeat =
        body.repeat !== true &&
        (await recentSameMemo(this.db, {
          siteId: site.siteId,
          visitorId: visitor.visitorId,
          memoId: memo.memo.memoId,
          slotsHash,
          since: new Date(now.getTime() - MEMO_LIMITS.repeatWindowMs),
        }));
    }

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
      !unitsFree &&
      !(await claimPlanAnswer(this.db, {
        accountId: site.accountId,
        conversationId,
        state,
      }))
    )
      return fail('quota');

    const steps: UiPlanStepView[] = checkedSteps.map((s) => ({
      ...s,
      state: 'pending',
    }));
    const executable = steps.length > 0;
    const askFirst = needsConfirm || (repeat && executable);
    // Сухой прогон: план проверен и показан (подсветка в iframe мастера),
    // исполнять нечего — сразу `done`, без сырых значений.
    const status: UiPlanStatus = !executable
      ? 'failed'
      : dryRun
        ? 'done'
        : askFirst
          ? 'proposed'
          : 'confirmed';
    const confirmBefore = new Date(
      now.getTime() + VOICE_CONTROL_DEFAULTS.confirmWindowMs,
    );
    const expiresAt = new Date(
      now.getTime() + VOICE_CONTROL_DEFAULTS.planTtlMs,
    );
    const memoText = memo ? memoTextOf(memo.memo, lang ?? 'uk') : null;
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
      needsConfirm: !dryRun && askFirst,
      confirmedBy: dryRun ? 'dry' : askFirst ? null : 'auto',
      confirmBefore,
      expiresAt,
      voiceTestId: test?.testId ?? null,
      dryRun,
      release,
      planOrigin: origin,
      memoId: memo?.memo.memoId ?? null,
      memoVersion: memo?.memo.version ?? null,
      memoSlotsHash: slotsHash,
      goalFrom,
      chainStatus: executable ? null : 'clean',
      extra: memo ? { trusted, memoText } : undefined,
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
      target: memo ? { memo: memo.memo.number, via: memo.via } : null,
      url: snapshot.url,
      risk: top,
      confirmedBy: dryRun ? 'dry' : askFirst ? null : 'auto',
      result: !executable ? 'skipped' : dryRun ? 'dryrun' : 'proposed',
      reason:
        notes
          .map((n) => n.code)
          .join(',')
          .slice(0, 200) || null,
      valueMasked: null,
      durationMs: null,
    });
    for (const n of notes)
      await insertActionLog(this.db, {
        accountId: site.accountId,
        siteId: site.siteId,
        planId,
        stepIndex: n.code === 'pin_mismatch' ? (pinMismatchAt ?? 0) : 0,
        action: 'refused',
        target: n.target ? { text: n.target } : null,
        url: snapshot.url,
        risk: n.code === 'second_pnr' ? 'confirm' : 'never',
        confirmedBy: null,
        result: 'skipped',
        reason: n.code,
        valueMasked: null,
        durationMs: null,
        pinMismatch: n.code === 'pin_mismatch',
      });
    await this.touch(conversationId, now);
    this.logger.log(
      `ui-plan site=${site.siteId} plan=${planId} steps=${steps.length} confirm=${askFirst} notes=${notes.length} origin=${origin}${memo ? ` memo=${memo.memo.number} via=${memo.via}` : ''}`,
    );
    const pnr = pointOfNoReturn(steps);
    return {
      kind: 'plan',
      planId,
      conversationId,
      status,
      steps,
      currentStep: 0,
      notes,
      needsConfirm: !dryRun && askFirst,
      stepsHash: stepsHash(steps),
      confirmBefore: confirmBefore.toISOString(),
      expiresAt: expiresAt.toISOString(),
      marks: marksOf(steps),
      pnr,
      pnrConfirm: false,
      memo: memoText,
      repeat: repeat && executable,
      goalFrom,
      goalStatus: null,
      chainStatus: executable ? null : 'clean',
    };
  }

  /** (е) Есть ли у сайта опубликованные мемо (признак для конфига iframe). */
  async hasMemos(siteId: string): Promise<boolean> {
    return (await this.memosFor(siteId)).length > 0;
  }

  /** Опубликованные мемо сайта (представление; сбой — как будто мемо нет). */
  private async memosFor(siteId: string): Promise<PublishedMemo[]> {
    try {
      return await readPublishedMemos(this.db, siteId);
    } catch (e) {
      this.logger.warn(
        `memo read failed site=${siteId}: ${(e as Error | null)?.name ?? 'Error'}`,
      );
      return [];
    }
  }

  /**
   * Платный вызов модели: резерв денег дня (сайт + платформа), вызов, учёт
   * операции `assist-ui-plan`, расчёт резерва. Сбой — `upstream`/`budget`.
   */
  private async paidModelCall(
    ctx: UiPlanCtx,
    state: SubscriptionState,
    p: {
      system: string;
      user: string;
      estMicroUsd: number;
      maxOutputTokens: number;
      timeoutMs: number;
      now: Date;
    },
  ): Promise<string> {
    const { site } = ctx;
    const capRow = await this.db.$queryRawUnsafe<Array<{ cap: number | null }>>(
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
      estMicroUsd: p.estMicroUsd,
      now: p.now,
    });
    if (!reserved.ok) {
      this.logger.warn(`ui-plan: ${reserved.denied} (site ${site.siteId})`);
      return fail('budget');
    }
    let actual = 0;
    try {
      const r = await this.model.generate({
        system: p.system,
        user: p.user,
        json: true,
        temperature: 0,
        maxOutputTokens: p.maxOutputTokens,
        timeoutMs: p.timeoutMs,
      });
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
      return r.text;
    } catch (e) {
      if (e instanceof UiPlanError) throw e;
      this.logger.warn(
        `ui-plan model failed site=${site.siteId}: ${(e as Error | null)?.name ?? 'Error'}`,
      );
      return fail('upstream');
    } finally {
      await this.budget.settle(this.db, reserved.reservation, actual);
    }
  }

  /**
   * (е) Lite-выбор мемо (§5-бис.17 п.5 п.3): модель видит ТОЛЬКО команду и
   * список мемо шаблона блоком данных — без снимка и текста страницы;
   * отвечает `{ memo, slots }`. Слоты проверяет код (`checkSlots`);
   * не выбрала/сбой/не сказано — обычный план (null).
   */
  private async chooseMemo(
    ctx: UiPlanCtx,
    p: {
      text: string;
      memos: PublishedMemo[];
      lang: MemoLang;
      now: Date;
      state: SubscriptionState;
    },
  ): Promise<MemoPick | null> {
    const prompt = buildMemoChoicePrompt({
      transcript: p.text,
      memos: p.memos,
      lang: p.lang,
    });
    const est = estimateCost(UI_PLAN_PRICING_MODEL, {
      inputTokens: Math.max(
        MEMO_LIMITS.choiceReserveInputTokens,
        Math.ceil((prompt.system.length + prompt.user.length) / 2),
      ),
      outputTokens: MEMO_LIMITS.choiceMaxOutputTokens,
    }).costMicroUsd;
    let out: string;
    try {
      out = await this.paidModelCall(ctx, p.state, {
        system: prompt.system,
        user: prompt.user,
        estMicroUsd: Math.max(200, est),
        maxOutputTokens: MEMO_LIMITS.choiceMaxOutputTokens,
        timeoutMs: MEMO_LIMITS.choiceTimeoutMs,
        now: p.now,
      });
    } catch (e) {
      // Бюджет дня исчерпан — так и скажем; сбой выбора — обычный план.
      if (e instanceof UiPlanError && e.failure === 'budget') throw e;
      return null;
    }
    const choice = parseMemoChoice(out, p.memos);
    if (!choice) return null;
    const slots = checkSlots(choice.memo.content, choice.slots, p.text, p.now);
    if (!slots) return null;
    return { memo: choice.memo, ...slots, via: 'lite' };
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
      ...endOf(plan, plan.steps, 'expired'),
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
        ...endOf(plan, plan.steps, 'expired'),
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
    // (д) Р-60: карточка, где текущий шаг — точка невозврата, и есть «Да
    // прямо перед ней» (вторая карточка или первая на этой странице).
    const pnr = pointOfNoReturn(plan.steps);
    const pnrConfirmedAt =
      pnr !== null && plan.currentStep === pnr ? now : null;
    const ok = await updatePlan(this.db, plan, this.who(ctx), {
      steps: plan.steps,
      currentStep: plan.currentStep,
      status: 'confirmed',
      needsConfirm: plan.needsConfirm,
      confirmedBy: by,
      pnrConfirmedAt,
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
    return view({
      ...plan,
      status: 'confirmed',
      confirmedBy: by,
      pnrConfirmedAt: pnrConfirmedAt ?? plan.pnrConfirmedAt,
    });
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
    // (е) Мемо выключили/«требует проверки» во время плана — следующий
    // шаг не исполняется (§5-бис.17 п.5 п.8); версия закреплена в плане.
    if (
      plan.memoId &&
      (result === 'dispatched' || (result === 'done' && !hasSideEffect(s))) &&
      !(await memoAlive(this.db, {
        siteId: ctx.site.siteId,
        memoId: plan.memoId,
      }))
    ) {
      await this.failLive(ctx, plan, idx, s, 'memo_off');
      return fail('conflict');
    }
    // (д) Р-60, В-65: точка невозврата после перехода или окна 60 с —
    // отдельная карточка «после этого отменить нельзя» прямо перед ней.
    if (result === 'dispatched') {
      const pnr = pointOfNoReturn(plan.steps);
      const now = this.now();
      if (
        pnr === idx &&
        needsSecondYes({
          steps: plan.steps,
          pnr,
          cardFrom: plan.cardFrom,
          confirmBefore: plan.confirmBefore,
          now,
          pnrConfirmed: plan.pnrConfirmedAt !== null,
        })
      ) {
        const confirmBefore = new Date(
          now.getTime() + CHAIN_DECISIONS.secondYesWindowMs,
        );
        const ok2 = await updatePlan(this.db, plan, this.who(ctx), {
          steps: plan.steps,
          currentStep: plan.currentStep,
          status: 'proposed',
          needsConfirm: true,
          confirmedBy: null,
          confirmBefore,
          cardFrom: idx,
        });
        if (!ok2) return fail('conflict');
        await insertActionLog(this.db, {
          accountId: ctx.site.accountId,
          siteId: ctx.site.siteId,
          planId: plan.id,
          stepIndex: idx,
          action: 'confirm',
          target: s.target ? { text: s.target.text } : null,
          url: null,
          risk: 'confirm',
          confirmedBy: null,
          result: 'proposed',
          reason: 'pnr',
          valueMasked: null,
          durationMs: null,
        });
        return view({
          ...plan,
          status: 'proposed',
          needsConfirm: true,
          confirmedBy: null,
          confirmBefore,
          cardFrom: idx,
        });
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
        // (д) След на сайте: действие могло произойти (статус цепочки).
        steps[idx].fx = true;
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
    const end = TERMINAL.has(status) ? endOf(plan, steps, status) : null;
    const ok = await updatePlan(this.db, plan, this.who(ctx), {
      steps,
      currentStep,
      status,
      needsConfirm: plan.needsConfirm,
      confirmedBy: plan.confirmedBy,
      ...(end ?? {}),
    });
    if (!ok) return fail('conflict');
    const reasonCode =
      typeof body.reason === 'string'
        ? body.reason.replace(/[^a-z_]/g, '').slice(0, 40) || null
        : s.reason;
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
      reason: reasonCode,
      valueMasked: s.value ? maskSensitiveEcho(s.value) : null,
      durationMs:
        typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
          ? Math.max(0, Math.min(600_000, Math.round(body.durationMs)))
          : null,
      // (е) Живая цель шага мемо оказалась другой (загрузчик: `changed`).
      pinMismatch:
        !!plan.memoId &&
        !!s.pin &&
        logged === 'failed' &&
        reasonCode === 'changed',
    });
    return view({
      ...plan,
      steps,
      currentStep,
      status,
      chainStatus: end?.chainStatus ?? plan.chainStatus,
      goalStatus: end?.goalStatus ?? plan.goalStatus,
    });
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
    await this.failLive(ctx, plan, idx, s, 'denied');
  }

  /**
   * Шаг не исполняется по причине, появившейся ПОСЛЕ плана (запрет
   * кабинета, мемо выключено): шаг — `failed`, план — провал, статус цепочки.
   */
  private async failLive(
    ctx: UiPlanCtx,
    plan: PlanRow,
    idx: number,
    s: UiPlanStepView,
    reason: 'denied' | 'memo_off',
  ): Promise<void> {
    const steps = plan.steps.map((x) => ({ ...x }));
    steps[idx].state = 'failed';
    await updatePlan(this.db, plan, this.who(ctx), {
      steps,
      currentStep: plan.currentStep,
      status: 'failed',
      needsConfirm: plan.needsConfirm,
      confirmedBy: plan.confirmedBy,
      ...endOf(plan, steps, 'failed'),
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
      risk: reason === 'denied' ? 'never' : s.risk,
      confirmedBy: plan.confirmedBy,
      result: 'failed',
      reason,
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
      ...endOf(plan, plan.steps, 'stopped'),
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
    const end = endOf(plan, plan.steps, 'stopped');
    const ok = await updatePlan(this.db, plan, this.who(ctx), {
      steps: plan.steps,
      currentStep: plan.currentStep,
      status: 'stopped',
      needsConfirm: plan.needsConfirm,
      confirmedBy: plan.confirmedBy,
      ...end,
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
    return view({ ...plan, status: 'stopped', ...end });
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
      trusted: plan.trusted,
    });
    const steps = r.steps.map((s, i) => ({
      ...s,
      state: plan.steps[i]?.state ?? 'pending',
      ...(plan.steps[i]?.fx ? { fx: true } : {}),
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
    const end = TERMINAL.has(status) ? endOf(plan, steps, status) : null;
    const ok = await updatePlan(this.db, plan, this.who(ctx), {
      steps,
      currentStep: plan.currentStep,
      status,
      needsConfirm,
      confirmedBy,
      confirmBefore,
      // (д) Новая карточка — с текущего шага (второе «Да» перед ТН — по ней).
      cardFrom: status === 'proposed' ? plan.currentStep : null,
      ...(end ?? {}),
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
        reason: r.reason ?? 'no_target',
        valueMasked: null,
        durationMs: null,
        pinMismatch: r.reason === 'pin_mismatch',
      });
    // Новое окно подтверждения — с момента новой карточки.
    return view({
      ...plan,
      steps,
      status,
      needsConfirm,
      confirmedBy,
      confirmBefore: confirmBefore ?? plan.confirmBefore,
      cardFrom: status === 'proposed' ? plan.currentStep : plan.cardFrom,
      chainStatus: end?.chainStatus ?? plan.chainStatus,
      goalStatus: end?.goalStatus ?? plan.goalStatus,
    });
  }

  // ── (д) возврат: «Вернуть / Оставить», «отмени последнее» ──────────────

  /**
   * Что вернуть (§5-бис.15 п.6 п.4–8, п.7; Р-64, Р-65): поля этой страницы
   * — из памяти загрузчика (сервер прежних значений не знает и не хранит),
   * серверные действия — «уберите сами» (компенсации — Э6-тер (и)). Только
   * план ЭТОГО посетителя, в окне 10 мин, не после отправки формы, ≤ 3 шагов.
   * «Оставить» (или 60 с без ответа) — статус `kept`. Единицы не тратит.
   */
  async undo(
    ctx: UiPlanCtx,
    id: string,
    body: UiUndoRequest,
    siteDayHit: (limit: number) => Promise<boolean> = async () => true,
  ): Promise<UiUndoView> {
    let plan = await this.load(ctx, id);
    const now = this.now();
    const by = body?.by === 'command' ? 'command' : 'offer';
    const out = (
      p: PlanRow,
      refused: UiUndoView['refused'],
      fields: number[] = [],
      manual: number[] = [],
    ): UiUndoView => ({
      planId: p.id,
      fields: fields.map((i) => ({ i, text: p.steps[i]?.target?.text ?? '' })),
      manual: manual.map((i) => ({ i, text: p.steps[i]?.target?.text ?? '' })),
      chainStatus: (p.chainStatus as ChainStatus | null) ?? null,
      refused,
    });
    if (now.getTime() - plan.createdAt.getTime() > CHAIN_DECISIONS.undoWindowMs)
      return out(plan, 'expired');
    // «Верни как было» во время плана — сначала стоп.
    if (LIVE.has(plan.status)) {
      await this.stop(ctx, id, { by: 'voice' });
      plan = await this.load(ctx, id);
    }
    if (
      plan.chainStatus === 'compensated' ||
      plan.chainStatus === 'partially_compensated'
    )
      return out(plan, 'nothing');
    if (body?.decision === 'keep') {
      if (plan.chainStatus === 'kept' || plan.chainStatus === 'unknown')
        await insertActionLog(this.db, {
          accountId: ctx.site.accountId,
          siteId: ctx.site.siteId,
          planId: plan.id,
          stepIndex: plan.currentStep,
          action: 'undo',
          target: null,
          url: null,
          risk: 'auto',
          confirmedBy: by,
          result: 'skipped',
          reason: 'keep',
          valueMasked: null,
          durationMs: null,
        });
      return out(plan, 'nothing');
    }
    const c = undoCandidates(plan.steps);
    if (c.refused) return out(plan, c.refused);
    // `degraded` — только подсветка (§5-бис.15 п.8): полей не трогаем.
    const state = await readState(this.db, ctx.site.accountId, now);
    const access = await this.access(ctx.site, state, !!ctx.voiceTest);
    // Р-65: «отмени последнее» — в суточном потолке планов сайта (единиц — нет).
    const free = ctx.site.preview || !!ctx.voiceTest;
    if (
      !free &&
      !(await siteDayHit(plansPerSitePerDay(access.plansPerDay, state.planId)))
    )
      return fail('site_limit');
    if (access.mode !== 'on')
      return out(plan, 'degraded', [], [...c.fields, ...c.manual]);
    await insertActionLog(this.db, {
      accountId: ctx.site.accountId,
      siteId: ctx.site.siteId,
      planId: plan.id,
      stepIndex: plan.currentStep,
      action: 'undo',
      target: null,
      url: null,
      risk: 'auto',
      confirmedBy: by,
      result: 'proposed',
      reason: `fields:${c.fields.length},manual:${c.manual.length}`,
      valueMasked: null,
      durationMs: null,
    });
    return out(plan, null, c.fields, c.manual);
  }

  /**
   * Итог возврата полей у загрузчика (по одной строке журнала `undo` на
   * шаг, значений нет — прежние значения не покидают браузер, §5-бис.15
   * п.7) → статус цепочки (`compensated`/`partially_compensated`/`unknown`).
   */
  async undoReport(
    ctx: UiPlanCtx,
    id: string,
    body: UiUndoReport,
  ): Promise<UiUndoView> {
    const plan = await this.load(ctx, id);
    if (LIVE.has(plan.status)) return fail('conflict');
    if (
      plan.chainStatus === 'compensated' ||
      plan.chainStatus === 'partially_compensated'
    )
      return fail('conflict');
    const c = undoCandidates(plan.steps);
    const allowed = new Set(c.fields);
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
    if (!results.length) return fail('bad_request');
    const next = chainAfterUndo(plan.steps, results);
    const ok = await updateChainStatus(this.db, {
      id: plan.id,
      ...this.who(ctx),
      from: plan.chainStatus,
      to: next,
    });
    if (!ok) return fail('conflict');
    for (const r of results)
      await insertActionLog(this.db, {
        accountId: ctx.site.accountId,
        siteId: ctx.site.siteId,
        planId: plan.id,
        stepIndex: r.i,
        action: 'undo',
        target: plan.steps[r.i]?.target
          ? { text: plan.steps[r.i].target?.text ?? null }
          : null,
        url: null,
        risk: plan.steps[r.i]?.risk ?? 'auto',
        confirmedBy: null,
        result:
          r.result === 'done'
            ? 'done'
            : r.result === 'failed'
              ? 'failed'
              : 'skipped',
        reason: r.result === 'done' ? null : r.result,
        valueMasked: null,
        durationMs: null,
        undoOf: r.i,
      });
    return {
      planId: plan.id,
      fields: [],
      manual: c.manual.map((i) => ({
        i,
        text: plan.steps[i]?.target?.text ?? '',
      })),
      chainStatus: next,
      refused: null,
    };
  }

  /**
   * (е) «Я умею» (§5-бис.17 п.11, В-74, Р-72): до 5 опубликованных мемо с
   * `listed`, успехом цели ≥ 80% за 7 дней (без запусков — показываем),
   * именами на языке посетителя. Номеров и фраз — нет; бесплатно.
   */
  async skills(ctx: UiPlanCtx, langRaw: unknown): Promise<UiSkillsView> {
    const lang: MemoLang =
      langRaw === 'ru' || langRaw === 'en' ? langRaw : 'uk';
    const now = this.now();
    const state = await readState(this.db, ctx.site.accountId, now);
    const access = await this.access(ctx.site, state, !!ctx.voiceTest);
    if (access.mode !== 'on') return { names: [] };
    const memos = (await this.memosFor(ctx.site.siteId)).filter(
      (m) => m.listed,
    );
    if (!memos.length) return { names: [] };
    const rates = await memoGoalRates(this.db, {
      siteId: ctx.site.siteId,
      since: new Date(now.getTime() - MEMO_DECISIONS.skillsWindowMs),
    });
    const names: string[] = [];
    for (const m of memos) {
      const r = rates.get(m.memoId);
      if (
        r &&
        r.runs > 0 &&
        r.reached / r.runs < MEMO_DECISIONS.skillsMinGoalRate
      )
        continue;
      const n = memoTextOf(m, lang).name;
      if (n && !names.includes(n)) names.push(n);
      if (names.length >= MEMO_DECISIONS.skillsMax) break;
    }
    return { names };
  }
}

/** (е) Выбранное мемо: значения слотов, признанные кодом, и как выбрано. */
interface MemoPick {
  memo: PublishedMemo;
  values: MemoSlotValues;
  trusted: string[];
  via: 'direct' | 'lite';
}

/** Отпечаток слотов (без значений в базе) — «повторить ещё раз?». */
export function memoSlotsHash(
  m: PublishedMemo,
  values: MemoSlotValues,
): string {
  const sorted = Object.keys(values)
    .sort()
    .map((k) => [k, values[k]]);
  return createHash('sha256')
    .update(`${m.memoId}:${JSON.stringify(sorted)}`)
    .digest('base64url')
    .slice(0, 22);
}

/** Имя мемо и описание цели на языке посетителя (иначе — первое заданное). */
function memoTextOf(
  m: PublishedMemo,
  lang: MemoLang,
): { name: string; goal: string } {
  const pick = (r: Partial<Record<MemoLang, string>>) =>
    r[lang] ?? MEMO_LANGS.map((l) => r[l]).find(Boolean) ?? '';
  return { name: pick(m.content.names), goal: pick(m.content.goal.text) };
}

/** Пометки предпросмотра (§5-бис.15 п.5): ↺ local, ⇄ comp, ⚠ irrev, ✋ manual. */
export function marksOf(
  steps: ReadonlyArray<Pick<UiPlanStepView, 'risk' | 'undo'>>,
): Array<UiPlanStepView['undo'] | 'manual'> {
  return steps.map((s) =>
    s.risk === 'manual' || s.risk === 'never' ? 'manual' : (s.undo ?? 'irrev'),
  );
}

/**
 * Итог плана при завершении: статус цепочки (§5-бис.15 п.11) и — у мемо —
 * цели (§5-бис.17 п.5 п.7). Сбой на точке невозврата после `dispatched` —
 * `unknown` («не знаю, отправилось ли»).
 */
export function endOf(
  plan: Pick<PlanRow, 'memoId' | 'goalFrom'>,
  steps: UiPlanStepView[],
  status: UiPlanStatus,
): { chainStatus: ChainStatus; goalStatus: GoalStatus | null } {
  const chainStatus = chainStatusOf(steps, status);
  if (!plan.memoId) return { chainStatus, goalStatus: null };
  if (status === 'done')
    return {
      chainStatus,
      goalStatus: plan.goalFrom !== null ? 'reached' : 'unknown',
    };
  const pnr = pointOfNoReturn(steps);
  const pnrUnknown =
    pnr !== null && steps[pnr].fx === true && steps[pnr].state !== 'done';
  return { chainStatus, goalStatus: pnrUnknown ? 'unknown' : 'not_reached' };
}

const TERMINAL: ReadonlySet<UiPlanStatus> = new Set([
  'done',
  'stopped',
  'failed',
  'expired',
]);

function view(plan: PlanRow): UiPlanView {
  const pnr = pointOfNoReturn(plan.steps);
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
    marks: marksOf(plan.steps),
    pnr,
    pnrConfirm:
      plan.status === 'proposed' &&
      pnr !== null &&
      plan.currentStep === pnr &&
      plan.cardFrom === pnr &&
      !plan.pnrConfirmedAt,
    memo: plan.memoText,
    repeat: false,
    goalFrom: plan.goalFrom,
    goalStatus: (plan.goalStatus as GoalStatus | null) ?? null,
    chainStatus: (plan.chainStatus as ChainStatus | null) ?? null,
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
