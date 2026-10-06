/**
 * Мок голосового управления «Админкой» стенда e2e (Э6-бис (б)) —
 * `/assist-admin/v1/voice-control|ui-plan*|voice-test*` на origin «Админки»
 * (`admin-mock.ts` отдаёт сюда эти пути с сессией сотрудника). Проверки
 * плана — НАСТОЯЩИЕ: `checkAdminPlan`, `apiPreference`, `confirmFields`
 * из `sites-backend/src/modules/assist-admin-voice/admin-voice-rules.ts`
 * (тот же код, что на сервере; без базы и Nest). Модель плана — подделка:
 * «ответ модели» на команду задаёт тест (`/__mock/admin-vc`), без него —
 * прямой путь без модели. `leak` — «дефект сервера» для проверки второй
 * линии на странице: план из фикстуры БЕЗ проверок кода (регистратор
 * мастера должен поймать попытку, отправка на рабочем хосте — заглушиться).
 *
 * Бизнес-правила тарифа, ролей, журнала, монитора и мастера — приёмка
 * sites-backend (`acceptance/e6b-admin`).
 *
 * Аудит 06.10: прогон мемо «Админки» — `memo-page|memo-report` с НАСТОЯЩИМ
 * итогом страницы и вердиктом (`admin-memo-check.ts` sites-backend); права
 * и каталог операций — приёмка `acceptance/e8/admin-memo-check.spec.ts`.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import * as rulesNs from '../../../sites-backend/src/modules/assist-admin-voice/admin-voice-rules';
import * as snapNs from '../../../sites-backend/src/modules/assist-ui-core/snapshot';
import * as directNs from '../../../sites-backend/src/modules/assist-ui-core/direct-plan';
import * as coreRulesNs from '../../../sites-backend/src/modules/assist-ui-core/rules';
import * as memoCheckNs from '../../../sites-backend/src/modules/assist-admin-actions/admin-memo-check';
import type { AdminMemoContent } from '../../../sites-backend/src/modules/assist-admin-actions/admin-memo';
import type {
  UiPlanStep,
  UiSnapshot,
} from '../../../sites-backend/src/modules/assist-ui-core/types';

const cjs = <T>(ns: T): T => (ns as T & { default?: T }).default ?? ns;
const { apiPreference, checkAdminPlan, confirmFields } = cjs(rulesNs);
const { parseSnapshot } = cjs(snapNs);
const { directPlan, looksLikeCommand } = cjs(directNs);
const { defaultVoiceControlRules } = cjs(coreRulesNs);
const {
  adminMemoCheckPage,
  adminMemoCheckVerdict,
  adminMemoHasPageSteps,
  adminMemoStepLines,
} = cjs(memoCheckNs);

/** Шаг «ответа модели»: цель — видимым текстом (как её назвала бы модель). */
export interface AdminModelStep {
  kind: string;
  text?: string;
  value?: string;
  risk?: string;
}

interface Plan {
  id: string;
  sub: string;
  status: string;
  steps: Array<UiPlanStep & { state: string }>;
  currentStep: number;
  notes: Array<{ code: string; target: string | null }>;
  needsConfirm: boolean;
  stepsHash: string;
  pnr: number | null;
  fields: Array<{ i: number; label: string; value: string }>;
  dryRun: boolean;
  testId: string | null;
}

const V = {
  /** Режим сайта; по умолчанию выключен (тесты Э7/Э8 его не видят). */
  mode: null as 'on' | 'degraded' | null,
  model: {} as Record<string, AdminModelStep[]>,
  leak: false,
  plans: new Map<string, Plan>(),
  snapshots: [] as UiSnapshot[],
  tests: new Map<
    string,
    {
      token: string;
      sub: string | null;
      testHost: boolean;
      attempts: number;
      submits: number;
      report: unknown;
      /** Прогон мемо: содержимое версии, проверенные страницы, итог. */
      memo?: {
        content: AdminMemoContent;
        pages: ReturnType<typeof adminMemoCheckPage>[];
        result: string | null;
      };
    }
  >(),
};

export function adminVcReset(): void {
  V.mode = null;
  V.model = {};
  V.leak = false;
  V.plans.clear();
  V.snapshots.length = 0;
  V.tests.clear();
}

/** Управление тестом: режим, «ответы модели», «дефект сервера», ссылка мастера. */
export function adminVcSet(b: Record<string, unknown>): unknown {
  if (b.mode !== undefined) V.mode = b.mode as typeof V.mode;
  if (b.model && typeof b.model === 'object')
    V.model = b.model as Record<string, AdminModelStep[]>;
  if (typeof b.leak === 'boolean') V.leak = b.leak;
  if (typeof b.testToken === 'string') {
    const id = crypto.randomUUID();
    V.tests.set(id, {
      token: b.testToken,
      sub: null,
      testHost: b.testHost === true,
      attempts: 0,
      submits: 0,
      report: null,
      ...(b.memo && typeof b.memo === 'object'
        ? {
            memo: {
              content: b.memo as AdminMemoContent,
              pages: [],
              result: null,
            },
          }
        : {}),
    });
    return { testId: id };
  }
  return { ok: true };
}

export function adminVcLog() {
  return {
    plans: [...V.plans.values()].map((p) => ({
      id: p.id,
      status: p.status,
      steps: p.steps.map((s) => ({
        kind: s.kind,
        text: s.target?.text ?? null,
        risk: s.risk,
        state: s.state,
      })),
    })),
    snapshots: V.snapshots,
    tests: [...V.tests.values()].map((t) => ({
      attempts: t.attempts,
      submits: t.submits,
      report: t.report,
      memo: t.memo
        ? { pages: t.memo.pages.map((x) => x.path), result: t.memo.result }
        : null,
    })),
  };
}

const CATALOG = [
  {
    rowId: 'r1',
    key: 'shop.deleteOrder',
    operationId: 'deleteOrder',
    summary: 'Видалити замовлення',
    kind: 'danger' as const,
  },
  {
    rowId: 'r2',
    key: 'shop.updateOrderStatus',
    operationId: 'updateOrderStatus',
    summary: 'Змінити статус замовлення',
    kind: 'write' as const,
  },
];

const hashOf = (steps: unknown) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(steps))
    .digest('base64url')
    .slice(0, 32);

function view(p: Plan) {
  return {
    kind: 'plan',
    planId: p.id,
    status: p.status,
    steps: p.steps,
    currentStep: p.currentStep,
    notes: p.notes,
    needsConfirm: p.needsConfirm,
    stepsHash: p.stepsHash,
    confirmBefore: null,
    expiresAt: null,
    marks: p.steps.map((s) =>
      s.risk === 'manual' || s.risk === 'never' ? 'manual' : s.undo
    ),
    pnr: p.pnr,
    pnrConfirm: false,
    fields: p.fields,
    chainStatus: null,
    api: null,
    apiMissing: false,
    memo: null,
  };
}

const empty = (kind: string, extra: object = {}) => ({
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
  ...extra,
});

/** «Ответ модели» фикстуры → сырые шаги по снимку (цель — по видимому тексту). */
function modelSteps(text: string, snap: UiSnapshot) {
  const m = V.model[text];
  if (!m) return null;
  return m.map((s) => {
    const el = s.text
      ? snap.elements.find((e) => e.text === s.text) ||
        snap.elements.find((e) => e.text.indexOf(s.text as string) === 0)
      : undefined;
    return {
      kind: s.kind,
      target: el ? el.ref : null,
      value: s.value ?? null,
      risk: s.risk,
    };
  });
}

/** «Дефект сервера» (`leak`): шаги фикстуры без проверок кода. */
function leakedSteps(text: string, snap: UiSnapshot): UiPlanStep[] {
  return (V.model[text] || []).map((s, i) => {
    const el = snap.elements.find((e) => e.text === s.text);
    return {
      i,
      kind: s.kind as UiPlanStep['kind'],
      target: el
        ? {
            ref: el.ref,
            assistId: el.assistId,
            role: el.role,
            text: el.text,
            selector: null,
            href: el.href,
          }
        : null,
      value: s.value ?? null,
      expect: null,
      risk: (s.risk as UiPlanStep['risk']) || 'auto',
      reason: null,
      nav: false,
      say: null,
      undo: 'local',
    } as UiPlanStep;
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(
    JSON.stringify(
      status < 400
        ? { success: true, data: body }
        : { success: false, error: body }
    )
  );
}

async function body(
  req: http.IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

export async function adminVcRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  sub: string,
  host: string
): Promise<void> {
  const testHeader = String(req.headers['x-assist-admin-voice-test'] || '');
  const test = V.tests.get(testHeader);
  const testOk = !!test && test.sub === sub && !test.report;
  if (req.method === 'GET' && p === '/assist-admin/v1/voice-control') {
    const mode = V.mode ?? (testOk ? 'on' : null);
    return json(res, 200, {
      mode,
      state: V.mode ?? 'test',
      denySelectors: [],
      allowSelectors: [],
      maxSteps: 10,
      voice: false,
      consentVersion: 'admin-consent-1',
    });
  }
  const off = () => json(res, 409, { code: 'ADMIN_VC_OFF', message: 'off' });
  if (req.method === 'POST' && p === '/assist-admin/v1/voice-test/session') {
    const b = await body(req);
    const hit = [...V.tests.entries()].find(
      ([, t]) => t.token === b.token && !t.sub
    );
    if (!hit)
      return json(res, 404, { code: 'ADMIN_VC_NOT_FOUND', message: 'nf' });
    hit[1].sub = sub;
    const m = hit[1].memo;
    return json(res, 200, {
      testId: hit[0],
      testHost: hit[1].testHost,
      host,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      ...(m
        ? {
            memo: {
              number: 7,
              name: m.content.names.uk ?? '',
              version: 1,
              pageSteps: adminMemoHasPageSteps(m.content),
              steps: adminMemoStepLines(m.content, 'uk'),
            },
          }
        : {}),
    });
  }
  const mcm =
    /^\/assist-admin\/v1\/voice-test\/([0-9a-f-]{36})\/(memo-page|memo-report)$/.exec(
      p
    );
  if (req.method === 'POST' && mcm) {
    const t = V.tests.get(mcm[1]);
    const m = t?.memo;
    if (!t || !m || t.sub !== sub || m.result)
      return json(res, 404, { code: 'ADMIN_VC_NOT_FOUND', message: 'nf' });
    const b = await body(req);
    if (mcm[2] === 'memo-page') {
      const snap = parseSnapshot(b.snapshot);
      if (!snap)
        return json(res, 400, { code: 'ADMIN_VC_BAD_REQUEST', message: 'bad' });
      V.snapshots.push(snap);
      const page = adminMemoCheckPage(m.content, snap, {
        rules: defaultVoiceControlRules(),
        hosts: [host],
      });
      m.pages = [...m.pages.filter((x) => x.path !== page.path), page];
      return json(res, 200, { ...page, pages: m.pages.length });
    }
    const v = adminMemoCheckVerdict(m.content, m.pages, [], 0);
    m.result = v.result;
    return json(res, 200, { testId: mcm[1], result: v.result, report: v });
  }
  const vtm =
    /^\/assist-admin\/v1\/voice-test\/([0-9a-f-]{36})\/(analyze|attempt|report)$/.exec(
      p
    );
  if (req.method === 'POST' && vtm) {
    const t = V.tests.get(vtm[1]);
    if (!t || t.sub !== sub || t.report)
      return json(res, 404, { code: 'ADMIN_VC_NOT_FOUND', message: 'nf' });
    const b = await body(req);
    if (vtm[2] === 'analyze')
      return json(res, 200, {
        commands: [
          { text: 'введи Терміново в Нотатка', safe: true },
          { text: 'натисни Клієнти', safe: true },
        ],
        forbidden: [],
        never: [],
        dangerButtons: [],
      });
    if (vtm[2] === 'attempt') {
      if (b.kind === 'submit') t.submits++;
      else t.attempts += 1;
      return json(res, 200, { attempts: t.attempts });
    }
    const fail = t.attempts > 0;
    t.report = {
      result: fail ? 'fail' : 'pass',
      attempts: t.attempts,
      submitsBlocked: b.submitsBlocked,
      mic: b.mic,
      env: b.env,
      dry: b.dry,
    };
    return json(res, 200, {
      testId: vtm[1],
      result: fail ? 'fail' : 'pass',
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      report: t.report,
    });
  }
  const mode = V.mode ?? (testOk ? 'on' : null);
  if (!mode) return off();
  if (req.method === 'GET' && p === '/assist-admin/v1/ui-plan/active') {
    const live = [...V.plans.values()]
      .reverse()
      .find(
        (x) =>
          x.sub === sub &&
          ['proposed', 'confirmed', 'running'].includes(x.status)
      );
    return json(res, 200, { plan: live ? view(live) : null, memoRunId: null });
  }
  if (req.method === 'POST' && p === '/assist-admin/v1/ui-plan') {
    const b = await body(req);
    const text = typeof b.text === 'string' ? b.text : '';
    const snap = parseSnapshot(b.snapshot);
    if (!snap)
      return json(res, 400, { code: 'ADMIN_VC_BAD_REQUEST', message: 'bad' });
    V.snapshots.push(snap);
    const dry = b.dryRun === true;
    if (!dry) {
      const pref = apiPreference(text, CATALOG);
      if (pref && pref.kind !== 'never')
        return json(res, 200, {
          ...empty('api'),
          api: { key: pref.kind === 'api' ? pref.op.key : null },
        });
    }
    if (!V.model[text] && !looksLikeCommand(text))
      return json(res, 200, empty('not_command'));
    let steps: UiPlanStep[];
    let notes: Array<{ code: string; target: string | null }> = [];
    let pnr: number | null = null;
    if (V.leak && V.model[text]) {
      steps = leakedSteps(text, snap);
    } else {
      const raw = modelSteps(text, snap) ?? directPlan(text, snap) ?? [];
      const c = checkAdminPlan({
        transcript: text,
        snapshot: snap,
        map: [],
        steps: raw,
        rules: defaultVoiceControlRules(),
        hosts: [new URL(snap.url).hostname],
        state: mode,
        noSubmit: testOk && !test!.testHost,
      });
      steps = c.steps;
      notes = c.notes;
      pnr = c.pnr;
    }
    const withState = steps.map((s) => ({ ...s, state: 'pending' }));
    const needsConfirm = steps.some((s) => s.risk === 'confirm');
    const plan: Plan = {
      id: crypto.randomUUID(),
      sub,
      status: !steps.length ? 'failed' : needsConfirm ? 'proposed' : 'running',
      steps: withState,
      currentStep: 0,
      notes,
      needsConfirm,
      stepsHash: hashOf(steps),
      pnr,
      fields: confirmFields(steps, pnr),
      dryRun: dry,
      testId: testOk ? testHeader : null,
    };
    V.plans.set(plan.id, plan);
    return json(res, 200, view(plan));
  }
  const pm =
    /^\/assist-admin\/v1\/ui-plan\/([0-9a-f-]{36})\/(confirm|step|stop|resume|undo|undo-report)$/.exec(
      p
    );
  if (req.method === 'POST' && pm) {
    const plan = V.plans.get(pm[1]);
    if (!plan || plan.sub !== sub)
      return json(res, 404, { code: 'ADMIN_VC_NOT_FOUND', message: 'nf' });
    const b = await body(req);
    switch (pm[2]) {
      case 'confirm':
        if (plan.status !== 'proposed')
          return json(res, 409, { code: 'ADMIN_VC_CONFLICT', message: 'c' });
        if (b.stepsHash !== plan.stepsHash)
          return json(res, 409, { code: 'ADMIN_VC_CHANGED', message: 'ch' });
        plan.status = 'running';
        return json(res, 200, view(plan));
      case 'step': {
        const i = Number(b.index);
        const s = plan.steps[i];
        if (!s || plan.status !== 'running' || i !== plan.currentStep)
          return json(res, 409, { code: 'ADMIN_VC_CONFLICT', message: 'c' });
        const r = String(b.result);
        if (r === 'dispatched') {
          if (s.state !== 'pending')
            return json(res, 409, { code: 'ADMIN_VC_CONFLICT', message: 'c' });
          s.state = 'dispatched';
          return json(res, 200, view(plan));
        }
        s.state = r;
        if (r === 'done') {
          plan.currentStep = i + 1;
          if (plan.currentStep >= plan.steps.length) plan.status = 'done';
        } else plan.status = r === 'manual' ? 'done' : 'failed';
        return json(res, 200, view(plan));
      }
      case 'stop':
        if (['proposed', 'confirmed', 'running'].includes(plan.status))
          plan.status = 'stopped';
        return json(res, 200, view(plan));
      case 'resume':
        return json(res, 200, view(plan));
      case 'undo':
        return json(res, 200, {
          planId: plan.id,
          fields: plan.steps
            .filter(
              (s) =>
                s.state === 'done' &&
                (s.kind === 'fill' || s.kind === 'select' || s.kind === 'check')
            )
            .map((s) => ({ i: s.i, text: s.target?.text ?? '' })),
          manual: [],
          refused: null,
          chainStatus: null,
        });
      default:
        return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { code: 'NOT_FOUND', message: 'not found' });
}
