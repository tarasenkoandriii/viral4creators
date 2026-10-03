/**
 * Мок `/widget/v1/ui-plan*` стенда e2e (Э6-бис (а)) — с НАСТОЯЩИМИ
 * проверками плана кодом: снимок, стоп-лист, значения из сказанного, хосты,
 * жест, риск, «после перехода» — это `sites-backend/src/modules/assist-ui-core`
 * (тот же код, что на сервере; без базы и Nest). Состояние плана — та же
 * машина, что `assist-site-voice-control/public/ui-plan.service.ts`
 * (подтверждение с отпечатком шагов, `dispatched` один раз, стоп, активный
 * план, продолжение; аудит Э6-бис — выключенный режим (`voiceControl`
 * сайта убран через `/__mock/site`) не принимает ни «Да», ни
 * `dispatched`/`done`, ни продолжение — VOICE_CONTROL_OFF; `dispatched` до
 * любого шага с побочным эффектом, `done` без него — конфликт; `done`
 * навигации с `expect.path` — адрес обязателен и сверяется). Модель плана — подделка: «ответ модели» на команду
 * задаёт тест/фикстура (`vcModel`: цели — по видимому тексту/разметке, как
 * назвала бы их модель), без него — прямой путь без модели.
 *
 * Бизнес-правила денег, тарифа и роли БД здесь НЕ воспроизводятся — их
 * проверяют приёмочные тесты sites-backend (`acceptance/e6b`).
 */
import crypto from 'node:crypto';
import type http from 'node:http';
// Пакет sites-backend — CommonJS: загрузчик ESM стенда (tsx, Playwright)
// не видит его именованные экспорты — берём модуль целиком (`default` у
// CommonJS — это module.exports) и раскладываем.
import * as pcNs from '../../../sites-backend/src/modules/assist-ui-core/plan-checks';
import * as rulesNs from '../../../sites-backend/src/modules/assist-ui-core/rules';
import * as snapNs from '../../../sites-backend/src/modules/assist-ui-core/snapshot';
import * as directNs from '../../../sites-backend/src/modules/assist-ui-core/direct-plan';
import * as wordsNs from '../../../sites-backend/src/modules/assist-ui-core/action-words';
import * as normNs from '../../../sites-backend/src/modules/assist-ui-core/normalize';
import type { RawStep } from '../../../sites-backend/src/modules/assist-ui-core/plan-checks';
import type {
  UiPlanStep,
  UiSnapshot,
  VoiceControlRules,
} from '../../../sites-backend/src/modules/assist-ui-core/types';

const cjs = <T>(ns: T): T => (ns as T & { default?: T }).default ?? ns;
const { checkPlan, onSiteHost, resolveAfterSteps } = cjs(pcNs);
const { defaultVoiceControlRules, rulesOf, zoneAllowed } = cjs(rulesNs);
const { parseSnapshot } = cjs(snapNs);
const { directPlan, looksLikeCommand } = cjs(directNs);
const { replyKind } = cjs(wordsNs);
const { normText } = cjs(normNs);

/** Шаг «ответа модели» в фикстуре: цель — описанием, как её видит модель. */
export interface ModelStep {
  kind: string;
  /** Цель на текущей странице: по разметке или видимому тексту (и роли). */
  find?: { assistId?: string; text?: string; role?: string };
  /** Цель на следующей странице (после перехода) — описанием. */
  after?: { assistId?: string; text?: string; role?: string };
  value?: string;
  risk?: string;
  say?: string;
  expect?: { path?: string; appear?: string; textChange?: boolean };
  /** Для navigate — адрес ссылки (модель может «выдумать» и чужой). */
  url?: string;
}

export interface VcSite {
  siteId: string;
  allowedOrigins: string[];
  voiceControl?: {
    mode: 'on' | 'degraded';
    denySelectors?: string[];
    allowSelectors?: string[];
    maxSteps?: number;
  };
  vcRules?: unknown;
  /** Нормализованный текст команды → «ответ модели» (или `not_command`). */
  vcModel?: Record<string, ModelStep[] | 'not_command'>;
}

type StepView = UiPlanStep & { state: string };

interface MockPlan {
  id: string;
  siteId: string;
  visitorId: string;
  conversationId: string;
  transcript: string;
  steps: StepView[];
  currentStep: number;
  status: string;
  needsConfirm: boolean;
  confirmedBy: string | null;
  createdAt: number;
}

export interface VcLog {
  /** Тела запросов `POST /widget/v1/ui-plan` как пришли (проверка ПД в снимке). */
  bodies: string[];
  plans: Array<{
    planId: string | null;
    siteId: string;
    text: string;
    source: string;
    steps: Array<{
      kind: string;
      risk: string;
      text: string;
      reason: string | null;
    }>;
    notes: string[];
  }>;
  steps: Array<{
    planId: string;
    index: number;
    result: string;
    reason: string | null;
    /** Итог, записанный сервером (`done` не на той странице — `failed`). */
    logged?: string;
  }>;
  stops: Array<{ planId: string; by: string }>;
  confirms: Array<{ planId: string; by: string }>;
  resumes: number;
}

export function freshVcLog(): VcLog {
  return {
    bodies: [],
    plans: [],
    steps: [],
    stops: [],
    confirms: [],
    resumes: 0,
  };
}

const PLANS = new Map<string, MockPlan>();

/** Шаг с побочным эффектом — как `hasSideEffect` сервиса. */
const EFFECT_KINDS = new Set(['click', 'fill', 'select', 'check', 'navigate']);
const effect = (s: { kind: string; nav: boolean }) =>
  s.nav || EFFECT_KINDS.has(s.kind);

/** Путь совпал с ожиданием (`/x` или `/x*`) — как `pathExpected` сервиса. */
function pathExpected(path: string, want: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '') || '/';
  if (want.endsWith('*')) return norm(path).startsWith(norm(want.slice(0, -1)));
  return norm(path) === norm(want);
}

function pathOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function hash(steps: StepView[]): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        steps.map((s) => [
          s.kind,
          s.target?.ref,
          s.target?.text,
          s.value,
          s.risk,
        ])
      )
    )
    .digest('base64url')
    .slice(0, 22);
}

function view(
  p: MockPlan,
  notes: Array<{ code: string; target: string | null }> = []
) {
  return {
    kind: 'plan',
    planId: p.id,
    conversationId: p.conversationId,
    status: p.status,
    steps: p.steps,
    currentStep: p.currentStep,
    notes,
    needsConfirm: p.needsConfirm,
    stepsHash: hash(p.steps),
    confirmBefore: new Date(p.createdAt + 60_000).toISOString(),
    expiresAt: new Date(p.createdAt + 600_000).toISOString(),
  };
}

/** «Модель»: описание цели → ref элемента снимка (как назвала бы модель). */
function fakeModel(
  text: string,
  snap: UiSnapshot,
  site: VcSite
): RawStep[] | 'not_command' | null {
  const entry = site.vcModel?.[normText(text).replace(/[.!?]+$/u, '')];
  if (!entry) return null;
  if (entry === 'not_command') return entry;
  return entry.map((s) => {
    const raw: RawStep = {
      kind: s.kind,
      value: s.value,
      risk: s.risk,
      say: s.say,
      expect: s.expect,
    };
    if (s.after) raw.target = { ...s.after };
    else if (s.url) raw.target = s.url;
    else if (s.find) {
      // Как модель: разметка, если она есть на странице, иначе видимый текст.
      const f = s.find;
      const byId = f.assistId
        ? snap.elements.find((e) => e.assistId === f.assistId)
        : undefined;
      const hit =
        byId ||
        snap.elements.find(
          (e) =>
            !!f.text &&
            normText(e.text || e.hiddenLabel || '') === normText(f.text) &&
            (f.role ? e.role === f.role : true)
        );
      raw.target = hit ? hit.ref : 'e999';
    }
    return raw;
  });
}

function hostsOf(site: VcSite): string[] {
  return site.allowedOrigins.map((o) => {
    try {
      return new URL(o).hostname;
    } catch {
      return o;
    }
  });
}

function rules(site: VcSite): VoiceControlRules | null {
  if (site.vcRules !== undefined) return rulesOf(site.vcRules);
  const r = defaultVoiceControlRules();
  if (site.voiceControl) {
    r.denySelectors = site.voiceControl.denySelectors ?? [];
    r.allowSelectors = site.voiceControl.allowSelectors ?? [];
    r.maxSteps = site.voiceControl.maxSteps ?? r.maxSteps;
  }
  return r;
}

type Reply = (status: number, body: unknown) => void;

export async function uiPlanRoute(
  req: http.IncomingMessage,
  p: string,
  tok: { visitorId: string; siteId: string },
  site: VcSite | undefined,
  body: () => Promise<{ raw: string; json: Record<string, unknown> }>,
  log: VcLog,
  reply: Reply
): Promise<boolean> {
  if (!p.startsWith('/widget/v1/ui-plan')) return false;
  const ok = (data: unknown) => reply(200, { success: true, data });
  const err = (status: number, code: string) =>
    reply(status, { success: false, error: { code, message: code } });
  if (!site) {
    err(404, 'NOT_FOUND');
    return true;
  }
  const mineActive = () =>
    [...PLANS.values()]
      .filter(
        (x) =>
          x.siteId === tok.siteId &&
          x.visitorId === tok.visitorId &&
          ['proposed', 'confirmed', 'running'].includes(x.status) &&
          Date.now() - x.createdAt < 600_000
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (req.method === 'GET' && p === '/widget/v1/ui-plan/active') {
    const a = mineActive();
    ok({ plan: a ? view(a) : null });
    return true;
  }
  if (req.method === 'POST' && p === '/widget/v1/ui-plan') {
    const { raw, json: b } = await body();
    log.bodies.push(raw);
    if (!site.voiceControl) {
      err(403, 'VOICE_CONTROL_OFF');
      return true;
    }
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const source = b.source;
    if (
      !text ||
      (source !== 'typed' && source !== 'voice') ||
      (source === 'voice' && typeof b.voiceTicket !== 'string')
    ) {
      err(400, 'BAD_REQUEST');
      return true;
    }
    const snap = parseSnapshot(b.snapshot);
    const hosts = hostsOf(site);
    if (!snap || !onSiteHost(snap.url, hosts)) {
      err(400, 'BAD_REQUEST');
      return true;
    }
    const r = rules(site);
    if (!r) {
      err(403, 'VOICE_CONTROL_OFF');
      return true;
    }
    if (!zoneAllowed(new URL(snap.url).pathname, r)) {
      ok({
        kind: 'plan',
        planId: null,
        conversationId: null,
        status: null,
        steps: [],
        currentStep: 0,
        notes: [{ code: 'denied', target: null }],
        needsConfirm: false,
        stepsHash: null,
        confirmBefore: null,
        expiresAt: null,
      });
      return true;
    }
    const model = fakeModel(text, snap, site);
    if (
      model === 'not_command' ||
      (!model && !directPlan(text, snap) && !looksLikeCommand(text))
    ) {
      ok({
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
      });
      return true;
    }
    const rawSteps = model ?? directPlan(text, snap) ?? [];
    const checked = checkPlan({
      transcript: text,
      snapshot: snap,
      map: [],
      steps: rawSteps,
      rules: r,
      hosts,
      state: site.voiceControl.mode,
    });
    const steps = checked.steps.map((s) => ({ ...s, state: 'pending' }));
    const plan: MockPlan = {
      id: 'pl_' + crypto.randomBytes(8).toString('hex'),
      siteId: tok.siteId,
      visitorId: tok.visitorId,
      conversationId:
        typeof b.conversationId === 'string'
          ? b.conversationId
          : 'c_' + crypto.randomBytes(6).toString('hex'),
      transcript: text,
      steps,
      currentStep: 0,
      status: steps.length
        ? checked.needsConfirm
          ? 'proposed'
          : 'confirmed'
        : 'failed',
      needsConfirm: checked.needsConfirm,
      confirmedBy: checked.needsConfirm ? null : 'auto',
      createdAt: Date.now(),
    };
    PLANS.set(plan.id, plan);
    log.plans.push({
      planId: plan.id,
      siteId: tok.siteId,
      text,
      source,
      steps: steps.map((s) => ({
        kind: s.kind,
        risk: s.risk,
        text: s.target?.text ?? '',
        reason: s.reason,
      })),
      notes: checked.notes.map((n) => n.code),
    });
    ok(view(plan, checked.notes));
    return true;
  }
  const m =
    /^\/widget\/v1\/ui-plan\/([A-Za-z0-9_-]{1,64})\/(confirm|step|stop|resume)$/.exec(
      p
    );
  if (!m || req.method !== 'POST') {
    err(404, 'NOT_FOUND');
    return true;
  }
  const plan = PLANS.get(m[1]);
  if (!plan || plan.siteId !== tok.siteId || plan.visitorId !== tok.visitorId) {
    err(404, 'NOT_FOUND');
    return true;
  }
  const { json: b } = await body();
  const live = ['proposed', 'confirmed', 'running', 'paused'];
  // D3 аудита: режим выключен после построения плана — «Да», следующий шаг
  // (dispatched/done) и продолжение не принимаются; стоп и отказ — да.
  const needsOn =
    m[2] === 'confirm' ||
    m[2] === 'resume' ||
    (m[2] === 'step' && (b.result === 'dispatched' || b.result === 'done'));
  if (needsOn && !site.voiceControl) {
    err(403, 'VOICE_CONTROL_OFF');
    return true;
  }
  switch (m[2]) {
    case 'confirm': {
      if (plan.status !== 'proposed') {
        if (plan.confirmedBy && plan.status !== 'expired') ok(view(plan));
        else err(409, 'PLAN_CONFLICT');
        return true;
      }
      if (Date.now() - plan.createdAt > 60_000) {
        plan.status = 'expired';
        err(409, 'PLAN_EXPIRED');
        return true;
      }
      if (b.stepsHash !== hash(plan.steps)) {
        err(409, 'PLAN_CHANGED');
        return true;
      }
      if (b.by === 'voice') {
        const k = typeof b.text === 'string' ? replyKind(b.text) : null;
        if (typeof b.voiceTicket !== 'string' || !k) {
          err(400, 'BAD_REQUEST');
          return true;
        }
        if (k === 'no' || k === 'stop') {
          plan.status = 'stopped';
          log.stops.push({ planId: plan.id, by: 'voice' });
          ok(view(plan));
          return true;
        }
        if (k !== 'yes') {
          err(400, 'BAD_REQUEST');
          return true;
        }
      } else if (b.by !== 'button') {
        err(400, 'BAD_REQUEST');
        return true;
      }
      plan.status = 'confirmed';
      plan.confirmedBy = b.by as string;
      log.confirms.push({ planId: plan.id, by: b.by as string });
      ok(view(plan));
      return true;
    }
    case 'stop': {
      if (live.includes(plan.status)) {
        plan.status = 'stopped';
        log.stops.push({ planId: plan.id, by: String(b.by) });
      }
      ok(view(plan));
      return true;
    }
    case 'step': {
      const idx = b.index;
      const result = b.result as string;
      if (
        (plan.status !== 'confirmed' && plan.status !== 'running') ||
        idx !== plan.currentStep ||
        !plan.steps[idx as number]
      ) {
        err(409, 'PLAN_CONFLICT');
        return true;
      }
      const i = idx as number;
      const s = plan.steps[i];
      const auto = s.risk === 'auto' || s.risk === 'confirm';
      const last = i === plan.steps.length - 1;
      let logged = result;
      if (result === 'dispatched') {
        if (!effect(s) || !auto || s.state !== 'pending') {
          err(409, 'PLAN_CONFLICT');
          return true;
        }
        s.state = 'dispatched';
        plan.status = 'running';
      } else if (result === 'done') {
        if (!auto || (effect(s) && s.state !== 'dispatched')) {
          err(409, 'PLAN_CONFLICT');
          return true;
        }
        const path = pathOf(b.url);
        if (s.nav && s.expect?.path && !path) {
          err(400, 'BAD_REQUEST');
          return true;
        }
        if (
          s.nav &&
          s.expect?.path &&
          path &&
          !pathExpected(path, s.expect.path)
        ) {
          s.state = 'failed';
          plan.status = 'failed';
          logged = 'failed';
        } else {
          s.state = 'done';
          plan.currentStep = i + 1;
          plan.status = last ? 'done' : 'running';
        }
      } else if (result === 'manual') {
        if (auto) {
          err(409, 'PLAN_CONFLICT');
          return true;
        }
        s.state = 'manual';
        plan.currentStep = i + 1;
        plan.status = 'done';
      } else if (['failed', 'skipped', 'stopped'].includes(result)) {
        s.state = result;
        plan.status = result === 'stopped' ? 'stopped' : 'failed';
      } else {
        err(400, 'BAD_REQUEST');
        return true;
      }
      log.steps.push({
        planId: plan.id,
        index: i,
        result,
        reason: typeof b.reason === 'string' ? b.reason : null,
        logged,
      });
      ok(view(plan));
      return true;
    }
    case 'resume': {
      log.resumes++;
      if (plan.status !== 'confirmed' && plan.status !== 'running') {
        err(409, 'PLAN_CONFLICT');
        return true;
      }
      const snap = parseSnapshot(b.snapshot);
      const r = rules(site);
      if (!snap || !r || !site.voiceControl) {
        err(400, 'BAD_REQUEST');
        return true;
      }
      const out = resolveAfterSteps({
        steps: plan.steps,
        from: plan.currentStep,
        snapshot: snap,
        transcript: plan.transcript,
        rules: r,
        hosts: hostsOf(site),
        state: site.voiceControl.mode,
      });
      plan.steps = out.steps.map((s, k) => ({
        ...s,
        state: plan.steps[k]?.state ?? 'pending',
      }));
      if (out.unresolved !== null) {
        plan.steps[out.unresolved].state = 'failed';
        plan.status = 'failed';
      } else if (out.needsConfirm) {
        plan.status = 'proposed';
        plan.needsConfirm = true;
        plan.confirmedBy = null;
        plan.createdAt = Date.now();
      }
      ok(view(plan));
      return true;
    }
  }
  return true;
}
