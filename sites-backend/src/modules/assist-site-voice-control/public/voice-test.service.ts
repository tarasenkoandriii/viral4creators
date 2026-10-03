/**
 * Мастер проверки голосового управления Т-2 — публичная часть (Э6-бис (г),
 * ТЗ помощника §5-бис.11, §5-бис.13; решение владельца 03.10.2026 п.1).
 * Зовут маршруты `/widget/v1/voice-test/*` (assist-widget) после сессии
 * посетителя; вся база — AssistPublicDb (роль assist_public).
 *
 *  - `exchange` — одноразовая ссылка кабинета (`?v4c_voicetest=`, 30 мин,
 *    сайт + origin страницы) → тестовая сессия ЭТОГО посетителя (30 мин,
 *    sessionStorage iframe). Тестовая сессия видит голосовое управление в
 *    любом состоянии сайта (`test` — только она), диалоги тарифа не тратит;
 *  - `session` — сессия из заголовка (или null — обычный посетитель);
 *  - `analyze` — снимок страницы → команды сухого прогона и прогона с
 *    нажатием, «запреты без звука», список 1 (бесплатно, без модели);
 *  - `report` — итог: вердикт считает КОД (assist-ui-core/wizard.ts);
 *    безопасные прогоны и сухие планы — по планам ЭТОЙ сессии в базе, запреты
 *    — заново по присланному снимку (клиенту в этом не верим), выпуск
 *    загрузчика — по настройке платформы. Отчёт сдаётся один раз.
 * В лог — только id и коды (§6.6).
 */
import { randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  readWidgetRelease,
  releaseForSite,
} from '../../../common/voice-control-platform';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import { readState } from '../../assist-billing/public/entitlements';
import {
  maskLabel,
  parseSnapshot,
  snapshotTooLarge,
} from '../../assist-ui-core/snapshot';
import type { UiSnapshot } from '../../assist-ui-core/types';
import {
  denySuggestions,
  forbiddenProbes,
  markupFragment,
  neverList,
  parseSuspicious,
  suggestCommands,
  WIZARD_LIMITS,
  wizardVerdict,
  type MicPolicy,
  type MicStatus,
  type WizardDryRun,
  type WizardEnvFacts,
  type WizardLang,
  type WizardMarkupFacts,
  type WizardSafeRun,
} from '../../assist-ui-core/wizard';
import type {
  VoiceTestAnalyzeRequest,
  VoiceTestAnalyzeView,
  VoiceTestReportRequest,
  VoiceTestReportView,
  VoiceTestSessionView,
  WizardReport,
} from '../api-types';
import {
  UiPlanError,
  type UiPlanCtx,
  SiteUiPlanService,
} from './ui-plan.service';
import {
  exchangeTestToken,
  readTestPlans,
  readTestSession,
  sha256Hex,
  writeTestReport,
} from './voice-test-store';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

const fail = (f: 'bad_request' | 'not_found' | 'off' | 'conflict'): never => {
  throw new UiPlanError(f);
};

const int = (v: unknown, max: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0;

const langOf = (v: unknown): WizardLang =>
  v === 'ru' || v === 'en' ? v : 'uk';

const MIC: readonly MicStatus[] = [
  'ok',
  'denied_policy',
  'denied_user',
  'no_device',
  'ios_gesture',
  'skipped',
];
const POLICY: readonly MicPolicy[] = ['allowed', 'denied', 'unknown'];

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

const KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SEL_RE = /^[\p{L}\p{N}\s#.:()[\]="'_*^$|~+>,\\/-]{1,200}$/u;

/** Строгий разбор фактов окружения (данные страницы — недоверенные). */
export function parseEnvFacts(raw: unknown): WizardEnvFacts {
  const o = obj(raw);
  return {
    widget: o.widget === true,
    chunks: o.chunks === true,
    csp: int(o.csp, 1000),
    tt: int(o.tt, 1000),
    micPolicy: (POLICY as readonly unknown[]).includes(o.micPolicy)
      ? (o.micPolicy as MicPolicy)
      : 'unknown',
    // Выпуск — по настройке платформы (сервер), не со слов страницы.
    release: null,
  };
}

export function parseMarkupFacts(raw: unknown): WizardMarkupFacts {
  const o = obj(raw);
  const unnamed = (Array.isArray(o.unnamed) ? o.unnamed : [])
    .slice(0, WIZARD_LIMITS.listItems)
    .map(obj)
    .filter((u) => typeof u.key === 'string' && KEY_RE.test(u.key))
    .map((u) => ({
      key: u.key as string,
      tag:
        typeof u.tag === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(u.tag)
          ? u.tag
          : 'other',
      selector:
        typeof u.selector === 'string' && SEL_RE.test(u.selector)
          ? u.selector
          : '',
    }));
  const duplicates = (Array.isArray(o.duplicates) ? o.duplicates : [])
    .slice(0, 20)
    .map(obj)
    .filter((d) => typeof d.name === 'string' && d.name.length <= 80)
    .map((d) => ({
      name: maskLabel(d.name as string),
      count: int(d.count, 999),
    }));
  return {
    total: int(o.total, 10_000),
    withId: int(o.withId, 10_000),
    unnamed,
    closedShadow: int(o.closedShadow, 1000),
    extIframes: int(o.extIframes, 1000),
    duplicates,
    denied: int(o.denied, 1000),
  };
}

@Injectable()
export class VoiceTestService {
  private readonly logger = new Logger(VoiceTestService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly db: AssistPublicDb,
    private readonly plans: SiteUiPlanService,
  ) {}

  /** Тестовая сессия из заголовка; нет/чужая/истекла — null (обычный посетитель). */
  async session(
    ctx: Pick<UiPlanCtx, 'site' | 'visitor'>,
    raw: string | undefined,
  ): Promise<{ testId: string; testHost: boolean } | null> {
    if (typeof raw !== 'string' || !TOKEN_RE.test(raw)) return null;
    const row = await readTestSession(this.db, {
      sessionHash: sha256Hex(raw),
      siteId: ctx.site.siteId,
      visitorId: ctx.visitor.visitorId,
      now: this.now(),
    });
    return row ? { testId: row.id, testHost: row.testHost } : null;
  }

  async exchange(
    ctx: UiPlanCtx,
    body: { token?: unknown } | null,
  ): Promise<VoiceTestSessionView> {
    const token = body?.token;
    if (typeof token !== 'string' || !TOKEN_RE.test(token))
      return fail('not_found');
    const now = this.now();
    const session = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + WIZARD_LIMITS.sessionTtlMs);
    let origin: string;
    try {
      origin = new URL(ctx.site.parentOrigin).origin;
    } catch {
      return fail('not_found');
    }
    const row = await exchangeTestToken(this.db, {
      tokenHash: sha256Hex(token),
      siteId: ctx.site.siteId,
      origin,
      visitorId: ctx.visitor.visitorId,
      sessionHash: sha256Hex(session),
      sessionExpiresAt: expiresAt,
      now,
    });
    if (!row) return fail('not_found');
    const state = await readState(this.db, ctx.site.accountId, now);
    const access = await this.plans.access(ctx.site, state, true);
    if (!access.mode || !access.rules) return fail('off');
    this.logger.log(
      `voice-test session site=${ctx.site.siteId} test=${row.id}`,
    );
    return {
      session,
      testId: row.id,
      expiresAt: expiresAt.toISOString(),
      testHost: row.testHost,
      voiceControl: {
        mode: 'on',
        denySelectors: access.rules.denySelectors,
        allowSelectors: access.rules.allowSelectors,
        maxSteps: access.rules.maxSteps,
      },
    };
  }

  private async mine(ctx: UiPlanCtx, tid: string) {
    if (!ctx.voiceTest || ctx.voiceTest.testId !== tid)
      return fail('not_found');
    const state = await readState(this.db, ctx.site.accountId, this.now());
    const access = await this.plans.access(ctx.site, state, true);
    if (!access.mode || !access.rules) return fail('off');
    return { rules: access.rules, hosts: await this.plans.siteHosts(ctx.site) };
  }

  private snapshotOf(raw: unknown, hosts: string[]): UiSnapshot {
    if (snapshotTooLarge(raw)) return fail('bad_request');
    const s = parseSnapshot(raw);
    if (!s) return fail('bad_request');
    if (!this.plans.onHost(s.url, hosts)) return fail('bad_request');
    return s;
  }

  async analyze(
    ctx: UiPlanCtx,
    tid: string,
    body: VoiceTestAnalyzeRequest | null,
  ): Promise<VoiceTestAnalyzeView> {
    const { rules, hosts } = await this.mine(ctx, tid);
    const snapshot = this.snapshotOf(body?.snapshot, hosts);
    const lang = langOf(body?.lang);
    return {
      commands: suggestCommands({ snapshot, rules, hosts, lang }),
      forbidden: forbiddenProbes({ snapshot, rules, hosts, lang }),
      never: neverList({ snapshot, rules, hosts }),
    };
  }

  async report(
    ctx: UiPlanCtx,
    tid: string,
    body: VoiceTestReportRequest | null,
  ): Promise<VoiceTestReportView> {
    if (JSON.stringify(body ?? {}).length > WIZARD_LIMITS.bodyChars)
      return fail('bad_request');
    const { rules, hosts } = await this.mine(ctx, tid);
    const snapshot = this.snapshotOf(body?.snapshot, hosts);
    const lang = langOf(body?.lang);
    const now = this.now();
    const env = parseEnvFacts(body?.env);
    env.release = releaseForSite(
      ctx.site.siteId,
      await readWidgetRelease(this.db, now.getTime()),
    );
    const mic: MicStatus = (MIC as readonly unknown[]).includes(body?.mic)
      ? (body?.mic as MicStatus)
      : 'skipped';
    const markup = parseMarkupFacts(body?.markup);
    const suspicious = parseSuspicious(body?.suspicious);
    const keys = new Set(suspicious.map((s) => s.key));
    const reviewed: Record<string, 'deny' | 'safe'> = {};
    for (const [k, v] of Object.entries(obj(body?.reviewed)))
      if (keys.has(k) && (v === 'deny' || v === 'safe')) reviewed[k] = v;

    // Планы этой сессии — истина (не слова страницы).
    const rows = await readTestPlans(this.db, {
      testId: tid,
      siteId: ctx.site.siteId,
      visitorId: ctx.visitor.visitorId,
    });
    const execSteps = (raw: unknown) =>
      (Array.isArray(raw) ? raw : []).filter(
        (s) =>
          !!s &&
          typeof s === 'object' &&
          ((s as { risk?: unknown }).risk === 'auto' ||
            (s as { risk?: unknown }).risk === 'confirm'),
      ) as Array<{ state?: unknown }>;
    const okBy = new Map<string, number>();
    for (const d of (Array.isArray(body?.dry) ? body.dry : []).slice(0, 10)) {
      const o = obj(d);
      if (typeof o.planId === 'string') okBy.set(o.planId, int(o.ok, 15));
    }
    const dry: WizardDryRun[] = rows
      .filter((r) => r.dryRun)
      .slice(-WIZARD_LIMITS.dryCommands)
      .map((r) => {
        const steps = execSteps(r.steps).length;
        return {
          planId: r.id,
          command: r.utteranceMasked.slice(0, 120),
          steps,
          ok: Math.min(okBy.get(r.id) ?? 0, steps),
        };
      });
    const safe: WizardSafeRun[] = rows
      .filter((r) => !r.dryRun)
      .slice(-WIZARD_LIMITS.safeCommands)
      .map((r) => {
        const ex = execSteps(r.steps);
        return {
          planId: r.id,
          command: r.utteranceMasked.slice(0, 120),
          status: r.status,
          done:
            r.status === 'done' &&
            ex.length > 0 &&
            ex.every((s) => s.state === 'done') &&
            !(Array.isArray(r.steps) ? r.steps : []).some(
              (s) =>
                !!s &&
                typeof s === 'object' &&
                ['manual', 'failed'].includes(
                  String((s as { state?: unknown }).state),
                ),
            ),
        };
      });
    const forbidden = forbiddenProbes({ snapshot, rules, hosts, lang });
    const verdict = wizardVerdict({
      env,
      mic,
      markup,
      suspicious,
      reviewed,
      dry,
      safe,
      forbidden,
    });
    let page = '/';
    try {
      page = new URL(snapshot.url).pathname;
    } catch {
      /* разобран выше */
    }
    const report: WizardReport = {
      v: 1,
      lang,
      page,
      host: (() => {
        try {
          return new URL(snapshot.url).host;
        } catch {
          return '';
        }
      })(),
      testHost: ctx.voiceTest?.testHost ?? false,
      result: verdict.result,
      items: verdict.items,
      env,
      mic,
      markup,
      never: neverList({ snapshot, rules, hosts }),
      suspicious,
      reviewed,
      denySuggestions: denySuggestions(suspicious, reviewed),
      dry,
      safe,
      forbidden,
      fragment: markupFragment({
        unnamed: markup.unnamed,
        suspicious,
        reviewed,
        lang,
      }),
    };
    const validUntil = new Date(now.getTime() + WIZARD_LIMITS.validMs);
    const ok = await writeTestReport(this.db, {
      id: tid,
      siteId: ctx.site.siteId,
      visitorId: ctx.visitor.visitorId,
      report,
      result: verdict.result,
      validUntil,
      release: env.release,
      pages: [page],
      now,
    });
    if (!ok) return fail('conflict');
    this.logger.log(
      `voice-test report site=${ctx.site.siteId} test=${tid} result=${verdict.result}`,
    );
    return {
      testId: tid,
      result: verdict.result,
      validUntil: validUntil.toISOString(),
      report,
    };
  }
}
