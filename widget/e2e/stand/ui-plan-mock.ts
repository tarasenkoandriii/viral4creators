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
import * as wizardNs from '../../../sites-backend/src/modules/assist-ui-core/wizard';
import * as chainNs from '../../../sites-backend/src/modules/assist-ui-core/chain';
import type { RawStep } from '../../../sites-backend/src/modules/assist-ui-core/plan-checks';
import { liveModelOn, liveModelPlan } from './live-model';
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
const {
  denySuggestions,
  forbiddenProbes,
  markupFragment,
  neverList,
  parseSuspicious,
  suggestCommands,
  wizardVerdict,
} = cjs(wizardNs);
// Э6-бис (д): цепочки — те же правила, что на сервере (возврат, статус).
const {
  chainAfterUndo,
  chainStatusOf,
  compRemoves,
  nextUndo,
  pointOfNoReturn,
  undoCandidates,
  undoResults,
} = cjs(chainNs);

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
    /** Э6-тер: у сайта есть мемо; «Я вмію» — имена мемо (skills). */
    memos?: boolean;
    skills?: string[];
  };
  vcRules?: unknown;
  /** Нормализованный текст команды → «ответ модели» (или `not_command`). */
  vcModel?: Record<string, ModelStep[] | 'not_command'>;
  /**
   * Э6-бис (г): одноразовые ссылки мастера проверки Т-2 (как выдал бы
   * кабинет). Сайт без `voiceControl` = режим `test`: план — только у
   * тестовой сессии мастера (заголовок `X-Assist-Voice-Test`).
   */
  vtTokens?: string[];
}

type StepView = UiPlanStep & {
  state: string;
  fx?: boolean;
  /** (Э6-тер (и)) Состояние возврата шага (как `undone` сервера). */
  undone?: 'dispatched' | 'done' | 'failed' | 'unknown' | 'gone' | null;
  /** Заход 9 (Р-З9-4): возврат шага начат сервером (как `undoAsked`). */
  undoAsked?: boolean;
};

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
  /** (г) План тестовой сессии мастера и сухой прогон. */
  testId?: string | null;
  dryRun?: boolean;
  /** (д) Статус цепочки после завершения и возврата. */
  chainStatus?: string | null;
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
  /** (д) Возвраты: запросы `/undo` и итоги `/undo-report` (тела как пришли). */
  undos: Array<{ planId: string; kind: 'undo' | 'report'; raw: string }>;
  /** (г) Мастер проверки: обмены ссылок, анализы, отчёты (тела как пришли). */
  vt: {
    sessions: Array<{ siteId: string; ok: boolean }>;
    analyses: number;
    reports: Array<{
      body: Record<string, unknown>;
      result: string;
      items: unknown[];
    }>;
  };
}

export function freshVcLog(): VcLog {
  return {
    bodies: [],
    plans: [],
    steps: [],
    stops: [],
    confirms: [],
    resumes: 0,
    undos: [],
    vt: { sessions: [], analyses: 0, reports: [] },
  };
}

/** (г) Тестовые сессии мастера: сессия → тест, сайт, посетитель. */
const VT_SESSIONS = new Map<
  string,
  { testId: string; siteId: string; visitorId: string; reported: boolean }
>();
const VT_USED = new Set<string>();

/** Тестовая сессия из заголовка (как VoiceTestService.session). */
export function vtSessionOf(
  req: http.IncomingMessage,
  tok: { visitorId: string; siteId: string }
): string | null {
  const h = req.headers['x-assist-voice-test'];
  const v = typeof h === 'string' ? VT_SESSIONS.get(h) : undefined;
  return v &&
    v.siteId === tok.siteId &&
    v.visitorId === tok.visitorId &&
    !v.reported
    ? v.testId
    : null;
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
    // (д) Пометки ↺/⇄/⚠/✋ и точка невозврата — как у сервера.
    marks: p.steps.map((s) =>
      s.risk === 'manual' || s.risk === 'never' ? 'manual' : (s.undo ?? 'irrev')
    ),
    pnr: pointOfNoReturn(p.steps),
    pnrConfirm: false,
    memo: null,
    repeat: false,
    goalStatus: null,
    chainStatus: p.chainStatus ?? null,
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

/** (Э6-тер (и)) Ответ возврата — как `UiUndoView` сервера. */
function undoView(plan: MockPlan, fields: number[]) {
  const c = undoCandidates(plan.steps);
  const t = (i: number) => ({ i, text: plan.steps[i]?.target?.text ?? '' });
  return {
    planId: plan.id,
    fields: fields.map(t),
    manual: c.manual.map(t),
    comp: null as unknown,
    chainStatus: plan.chainStatus ?? null,
    refused: null,
  };
}

/** Компенсация для загрузчика — как `compView` сервера. */
function compViewMock(plan: MockPlan, i: number, dispatched: boolean) {
  const s = plan.steps[i];
  const c = s.comp;
  if (!c) return null;
  const variant: string[] = [];
  for (let k = i - 1; k >= 0 && variant.length < 2; k--) {
    const x = plan.steps[k];
    if (x.nav) break;
    if (x.kind === 'select' && x.state === 'done' && x.value)
      variant.push(x.value);
  }
  return {
    i,
    text: s.target?.text ?? '',
    row: c.row,
    assistId: c.assistId,
    at: c.at,
    variant,
    allow: [
      ...(compRemoves(c.assistId) ? ['remove'] : []),
      ...(c.sub ? ['unsubscribe'] : []),
    ],
    dispatched,
  };
}

/** Следующая работа возврата или итог цепочки (как `undoNext` сервера). */
function undoNextMock(plan: MockPlan) {
  for (let guard = 0; guard < 4; guard++) {
    const n = nextUndo(plan.steps);
    if (n.kind === 'fields') return undoView(plan, n.idx);
    if (n.kind === 'comp')
      return { ...undoView(plan, []), comp: compViewMock(plan, n.i, false) };
    if (n.kind === 'end') break;
    plan.steps[n.i].undone = 'unknown';
  }
  const r = undoResults(plan.steps);
  if (r.length) plan.chainStatus = chainAfterUndo(plan.steps, r);
  return undoView(plan, []);
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
  // (г) Тестовая сессия мастера: режим в любом состоянии сайта.
  const test = vtSessionOf(req, tok);
  if (test && !site.voiceControl)
    site = { ...site, voiceControl: { mode: 'on' } };
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

  // (е)/Э6-тер: «Я вмію» — имена мемо сайта (как `skills` сервера).
  if (req.method === 'GET' && p === '/widget/v1/ui-plan/skills') {
    ok({ names: site.voiceControl?.skills ?? [] });
    return true;
  }
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
    // (г) Сухой прогон — только мастеру.
    if (b.dryRun === true && !test) {
      err(400, 'BAD_REQUEST');
      return true;
    }
    const dryRun = b.dryRun === true;
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
    // Заход 9: Т-1 `transcript-live` — живая модель вместо фикстуры стенда.
    const model = liveModelOn()
      ? await liveModelPlan({
          text,
          snapshot: snap,
          lang: typeof b.lang === 'string' ? b.lang : 'uk',
        })
      : fakeModel(text, snap, site);
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
      // Э6-тер (и): компенсации объявленных пар — как у сервера.
      compensations: true,
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
        ? dryRun
          ? 'done'
          : checked.needsConfirm
            ? 'proposed'
            : 'confirmed'
        : 'failed',
      needsConfirm: !dryRun && checked.needsConfirm,
      confirmedBy: dryRun ? 'dry' : checked.needsConfirm ? null : 'auto',
      createdAt: Date.now(),
      testId: test,
      dryRun,
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
    /^\/widget\/v1\/ui-plan\/([A-Za-z0-9_-]{1,64})\/(confirm|step|stop|resume|undo|undo-report)$/.exec(
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
  const end = () => {
    if (!live.includes(plan.status))
      plan.chainStatus = chainStatusOf(plan.steps, plan.status);
  };
  switch (m[2]) {
    case 'undo': {
      log.undos.push({ planId: plan.id, kind: 'undo', raw: JSON.stringify(b) });
      if (live.includes(plan.status)) {
        plan.status = 'stopped';
        end();
      }
      if (b.decision === 'keep') {
        ok({
          planId: plan.id,
          fields: [],
          manual: [],
          comp: null,
          chainStatus: plan.chainStatus,
          refused: 'nothing',
        });
        return true;
      }
      const c = undoCandidates(plan.steps);
      if (c.refused) {
        ok({
          planId: plan.id,
          fields: [],
          manual: [],
          comp: null,
          chainStatus: plan.chainStatus ?? null,
          refused: c.refused,
        });
        return true;
      }
      // `degraded` — компенсаций нет (как у сервера).
      if (site.voiceControl?.mode === 'degraded') {
        const t = (i: number) => ({
          i,
          text: plan.steps[i]?.target?.text ?? '',
        });
        // Заход 9 (§5-бис.15 п.8): обратные кнопки — только для подсветки.
        const show = c.comp
          .map((i) => compViewMock(plan, i, false))
          .filter((v): v is NonNullable<typeof v> => !!v)
          .map((v) => ({
            i: v.i,
            text: v.text,
            row: v.row,
            assistId: v.assistId,
            at: v.at,
            variant: v.variant,
          }));
        ok({
          planId: plan.id,
          fields: [],
          manual: [...c.fields, ...c.manual, ...c.comp].map(t),
          comp: null,
          show,
          chainStatus: plan.chainStatus ?? null,
          refused: 'degraded',
        });
        return true;
      }
      // Заход 9 (Р-З9-4): отметка «возврат начат» — как у сервера.
      for (const i of c.order) plan.steps[i].undoAsked = true;
      ok(undoNextMock(plan));
      return true;
    }
    case 'undo-report': {
      log.undos.push({
        planId: plan.id,
        kind: 'report',
        raw: JSON.stringify(b),
      });
      const n = nextUndo(plan.steps);
      // Заход 9 (Р-З9-4): без принятого «Вернуть» — 409 (как сервер).
      const nextIdx =
        n.kind === 'fields'
          ? n.idx
          : n.kind === 'comp' || n.kind === 'stale'
            ? [n.i]
            : [];
      if (!nextIdx.every((i) => plan.steps[i].undoAsked === true)) {
        err(409, 'PLAN_CONFLICT');
        return true;
      }
      // Э6-тер (и): отметка «начат» компенсации — один раз, ДО действия.
      if (b.dispatch !== undefined) {
        if (n.kind !== 'comp' || n.i !== b.dispatch) {
          err(409, 'PLAN_CONFLICT');
          return true;
        }
        plan.steps[n.i].undone = 'dispatched';
        ok({ ...undoView(plan, []), comp: compViewMock(plan, n.i, true) });
        return true;
      }
      if (b.next === true) {
        ok(undoNextMock(plan));
        return true;
      }
      const allowed =
        n.kind === 'fields' ? n.idx : n.kind === 'stale' ? [n.i] : [];
      const results = (
        Array.isArray(b.results)
          ? (b.results as Array<{
              i: number;
              result: 'done' | 'failed' | 'unknown' | 'gone';
            }>)
          : []
      ).filter((r) => allowed.includes(r.i));
      if (!results.length) {
        err(400, 'BAD_REQUEST');
        return true;
      }
      for (const r of results) plan.steps[r.i].undone = r.result;
      for (const i of allowed)
        if (!plan.steps[i].undone) plan.steps[i].undone = 'gone';
      ok(undoNextMock(plan));
      return true;
    }
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
        end();
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
        s.fx = true;
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
      end();
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
        compensations: true,
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

/**
 * (г) Мастер проверки Т-2 — `/widget/v1/voice-test/*` (как
 * assist-site-voice-control/public/voice-test.service.ts): обмен ссылки
 * (один раз, сайт), анализ (команды, запреты без звука, список 1 —
 * настоящий `assist-ui-core/wizard`), отчёт (вердикт — тем же кодом; планы
 * сессии — из мока). Деньги, роль БД и годность — sites-backend.
 */
export async function voiceTestRoute(
  req: http.IncomingMessage,
  p: string,
  tok: { visitorId: string; siteId: string },
  site: VcSite | undefined,
  body: () => Promise<{ raw: string; json: Record<string, unknown> }>,
  log: VcLog,
  reply: Reply
): Promise<boolean> {
  if (!p.startsWith('/widget/v1/voice-test')) return false;
  const ok = (data: unknown) => reply(200, { success: true, data });
  const err = (status: number, code: string) =>
    reply(status, { success: false, error: { code, message: code } });
  if (!site || req.method !== 'POST') {
    err(404, 'NOT_FOUND');
    return true;
  }
  const { json: b } = await body();
  if (p === '/widget/v1/voice-test/session') {
    const token = typeof b.token === 'string' ? b.token : '';
    const valid = !!site.vtTokens?.includes(token) && !VT_USED.has(token);
    log.vt.sessions.push({ siteId: tok.siteId, ok: valid });
    if (!valid) {
      err(403, 'VOICE_TEST_INVALID');
      return true;
    }
    VT_USED.add(token);
    const session = crypto.randomBytes(32).toString('base64url');
    const testId = 'vt_' + crypto.randomBytes(6).toString('hex');
    VT_SESSIONS.set(session, {
      testId,
      siteId: tok.siteId,
      visitorId: tok.visitorId,
      reported: false,
    });
    const r = rules(site);
    ok({
      session,
      testId,
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      testHost: false,
      voiceControl: {
        mode: 'on',
        denySelectors: r?.denySelectors ?? [],
        allowSelectors: r?.allowSelectors ?? [],
        maxSteps: r?.maxSteps ?? 6,
      },
    });
    return true;
  }
  const m =
    /^\/widget\/v1\/voice-test\/([A-Za-z0-9_-]{1,64})\/(analyze|report)$/.exec(
      p
    );
  const test = vtSessionOf(req, tok);
  if (!m || !test || test !== m[1]) {
    err(403, 'VOICE_TEST_INVALID');
    return true;
  }
  const snap = parseSnapshot(b.snapshot);
  const r = rules(site);
  const hosts = hostsOf(site);
  if (!snap || !r || !onSiteHost(snap.url, hosts)) {
    err(400, 'BAD_REQUEST');
    return true;
  }
  const lang = b.lang === 'ru' || b.lang === 'en' ? b.lang : 'uk';
  if (m[2] === 'analyze') {
    log.vt.analyses++;
    ok({
      commands: suggestCommands({ snapshot: snap, rules: r, hosts, lang }),
      forbidden: forbiddenProbes({ snapshot: snap, rules: r, hosts, lang }),
      never: neverList({ snapshot: snap, rules: r, hosts }),
    });
    return true;
  }
  const mine = [...PLANS.values()].filter((x) => x.testId === test);
  const exec = (x: MockPlan) =>
    x.steps.filter((s) => s.risk === 'auto' || s.risk === 'confirm');
  const okBy = new Map<string, number>();
  for (const d of Array.isArray(b.dry) ? b.dry : []) {
    const o = d as Record<string, unknown>;
    if (typeof o.planId === 'string' && typeof o.ok === 'number')
      okBy.set(o.planId, o.ok);
  }
  const dry = mine
    .filter((x) => x.dryRun)
    .map((x) => ({
      planId: x.id,
      command: x.transcript,
      steps: exec(x).length,
      ok: Math.min(okBy.get(x.id) ?? 0, exec(x).length),
    }));
  const safe = mine
    .filter((x) => !x.dryRun)
    .slice(-3)
    .map((x) => ({
      planId: x.id,
      command: x.transcript,
      status: x.status,
      done:
        x.status === 'done' &&
        exec(x).every((s) => s.state === 'done') &&
        !x.steps.some((s) => s.state === 'manual' || s.state === 'failed'),
    }));
  const env = (b.env ?? {}) as Record<string, unknown>;
  const mic = (typeof b.mic === 'string' ? b.mic : 'skipped') as 'ok';
  const suspicious = parseSuspicious(b.suspicious);
  const reviewed = (b.reviewed ?? {}) as Record<string, 'deny' | 'safe'>;
  const markupRaw = (b.markup ?? {}) as Record<string, unknown>;
  const markup = {
    total: Number(markupRaw.total) || 0,
    withId: Number(markupRaw.withId) || 0,
    unnamed: Array.isArray(markupRaw.unnamed)
      ? (markupRaw.unnamed as Array<{
          key: string;
          tag: string;
          selector: string;
        }>)
      : [],
    closedShadow: Number(markupRaw.closedShadow) || 0,
    extIframes: Number(markupRaw.extIframes) || 0,
    duplicates: Array.isArray(markupRaw.duplicates)
      ? (markupRaw.duplicates as Array<{ name: string; count: number }>)
      : [],
    denied: Number(markupRaw.denied) || 0,
  };
  const forbidden = forbiddenProbes({ snapshot: snap, rules: r, hosts, lang });
  const verdict = wizardVerdict({
    env: {
      widget: env.widget === true,
      chunks: env.chunks === true,
      csp: Number(env.csp) || 0,
      tt: Number(env.tt) || 0,
      micPolicy:
        env.micPolicy === 'denied' || env.micPolicy === 'allowed'
          ? env.micPolicy
          : 'unknown',
      release: null,
    },
    mic,
    markup,
    suspicious,
    reviewed,
    dry,
    safe,
    forbidden,
  });
  VT_SESSIONS.forEach((v) => {
    if (v.testId === test) v.reported = true;
  });
  log.vt.reports.push({
    body: b,
    result: verdict.result,
    items: verdict.items,
  });
  ok({
    testId: test,
    result: verdict.result,
    validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    report: {
      items: verdict.items,
      never: neverList({ snapshot: snap, rules: r, hosts }),
      denySuggestions: denySuggestions(suspicious, reviewed),
      fragment: markupFragment({
        unnamed: markup.unnamed,
        suspicious,
        reviewed,
        lang,
      }),
      dry,
      safe,
      forbidden,
    },
  });
  return true;
}
