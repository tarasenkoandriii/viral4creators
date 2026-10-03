/**
 * Мастер проверки голосового управления Т-2 — сторона iframe (Э6-бис (г),
 * ТЗ §5-бис.13; решение владельца 03.10.2026 п.1). Узкий стык с
 * ChatController (тест без DOM — scripts/voice-test.test.ts).
 *
 * Запуск — одноразовая ссылка кабинета `?v4c_voicetest=` (загрузчик убирает
 * её из адреса и отдаёт iframe в init): обмен на тестовую сессию (30 мин,
 * sessionStorage iframe — переживает переходы MPA во время прогона), затем
 * семь шагов — каждый с итогом «готово / проблема»:
 *  1. окружение (чанк check.js: CSP, Trusted Types, чанки; политика
 *     микрофона — здесь, `document.featurePolicy` iframe);
 *  2. микрофон: разрешение и «перевірка зв'язку» (обычная запись голоса);
 *  3. разметка: снимок страницы → сервер (команды, запреты, список 1) и
 *     check.js (без имени, закрытые shadow, внешние iframe, список 2 —
 *     владелец отмечает каждый пункт «запретить/безопасно»);
 *  4. сухой прогон: план строит сервер (`dryRun`), цели ТОЛЬКО подсвечиваются
 *     — владелец отмечает каждый шаг «вірно/не те»;
 *  5. с нажатием на безопасном: обычный план тестовой сессии (истина — в
 *     базе: сервер сам смотрит планы сессии);
 *  6. запреты без звука — результат сервера по снимку;
 *  7. отчёт: вердикт считает сервер; здесь — показать.
 */
import type { VoiceControlPublic } from '../shared/config';
import type { FrameMessage } from '../shared/protocol';
import type { VtDict } from './i18n-vt';
import type { PlanView } from './ui-plan';

export type VtMicStatus =
  | 'ok'
  | 'denied_policy'
  | 'denied_user'
  | 'no_device'
  | 'ios_gesture'
  | 'skipped';
export type VtMicPolicy = 'allowed' | 'denied' | 'unknown';
export type VtResult = 'pass' | 'partial' | 'fail';

export interface VtEnv {
  widget: boolean;
  chunks: boolean;
  csp: number;
  tt: number;
  micPolicy: VtMicPolicy;
}

export interface VtMarkup {
  total: number;
  withId: number;
  unnamed: Array<{ key: string; tag: string; selector: string }>;
  closedShadow: number;
  extIframes: number;
  duplicates: Array<{ name: string; count: number }>;
  denied: number;
}

export interface VtSuspicious {
  key: string;
  why: string;
  tag: string;
  label: string;
  selector: string;
}

export interface VtForbidden {
  kind: string;
  command: string;
  candidates: number;
  blocked: boolean;
  reasons: string[];
}

export interface VtUi {
  active: boolean;
  testId: string | null;
  /** 0 — старт/обмен; 1…7 — шаги мастера. */
  step: number;
  busy: boolean;
  error: 'expired' | 'failed' | null;
  env: VtEnv | null;
  mic: VtMicStatus | null;
  heard: string | null;
  markup: VtMarkup | null;
  never: Array<{ text: string; reason: string }>;
  suspicious: VtSuspicious[];
  reviewed: Record<string, 'deny' | 'safe'>;
  marked: string[];
  commands: Array<{ text: string; safe: boolean }>;
  dry: Array<{
    planId: string;
    command: string;
    steps: string[];
    ok: Array<boolean | null>;
  }>;
  safe: Array<{
    command: string;
    state: 'idle' | 'running' | 'done' | 'failed';
  }>;
  forbidden: VtForbidden[];
  result: {
    result: VtResult;
    validUntil: string;
    items: Array<{ step: number; level: string; code: string }>;
    fragment: string;
  } | null;
}

export function vtOff(): VtUi {
  return {
    active: false,
    testId: null,
    step: 0,
    busy: false,
    error: null,
    env: null,
    mic: null,
    heard: null,
    markup: null,
    never: [],
    suspicious: [],
    reviewed: {},
    marked: [],
    commands: [],
    dry: [],
    safe: [],
    forbidden: [],
    result: null,
  };
}

export interface VtHost {
  ui(): VtUi;
  setUi(p: Partial<VtUi>): void;
  t(): VtDict;
  lang(): 'uk' | 'ru' | 'en';
  api(method: 'POST', path: string, body?: unknown): Promise<unknown>;
  toParent(m: FrameMessage): void;
  storage(name: string, value?: string | null): string | null;
  /** Сессия мастера для заголовка запросов (null — снять). */
  setSession(s: string | null): void;
  /** Режим для тестовой сессии (план iframe — как при `on`). */
  setVoiceControl(cfg: VoiceControlPublic | null): void;
  random(): string;
  now(): number;
  /** Политика микрофона в iframe (Permissions-Policy сайта + `allow`). */
  micPolicy(): VtMicPolicy;
  /** Запрос микрофона (разрешение браузера) — диагноз. */
  micProbe(): Promise<VtMicStatus>;
  /** «Скажите „перевірка зв'язку“» — обычная запись голоса чата. */
  listen(): void;
  plans: {
    snap(): Promise<unknown>;
    dry(text: string): Promise<PlanView | null>;
    command(text: string): Promise<boolean>;
  };
}

const RESULT_TIMEOUT_MS = 5000;
const OBJ = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const int = (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, 1e5) : 0;
const str = (v: unknown, max: number) =>
  typeof v === 'string' ? v.slice(0, max) : '';

/** Строгий разбор разметки от check.js (страница — недоверенная). */
export function parseMarkup(raw: unknown): {
  markup: VtMarkup;
  suspicious: VtSuspicious[];
} {
  const o = OBJ(raw);
  const key = (v: unknown) =>
    typeof v === 'string' && /^[us][0-9]{1,4}$/.test(v) ? v : null;
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 50) : []);
  const unnamed = list(o.unnamed)
    .map(OBJ)
    .filter((x) => key(x.key))
    .map((x) => ({
      key: x.key as string,
      tag: str(x.tag, 30),
      selector: str(x.selector, 200),
    }));
  const suspicious = list(o.suspicious)
    .map(OBJ)
    .filter(
      (x) =>
        key(x.key) &&
        ['icon_trash', 'class_danger', 'post_form_textless'].indexOf(
          String(x.why)
        ) >= 0
    )
    .map((x) => ({
      key: x.key as string,
      why: x.why as string,
      tag: str(x.tag, 30),
      label: str(x.label, 80),
      selector: str(x.selector, 200),
    }));
  return {
    markup: {
      total: int(o.total),
      withId: int(o.withId),
      unnamed,
      closedShadow: int(o.closedShadow),
      extIframes: int(o.extIframes),
      duplicates: list(o.duplicates)
        .map(OBJ)
        .map((d) => ({ name: str(d.name, 80), count: int(d.count) }))
        .slice(0, 20),
      denied: int(o.denied),
    },
    suspicious,
  };
}

/** Сколько шагов отмечено «верно» по плану сухого прогона. */
export function dryOk(d: VtUi['dry'][number]): number {
  return d.ok.filter((x) => x === true).length;
}

/** Состояние, которое переживает переход страницы (sessionStorage iframe). */
function persisted(u: VtUi): Partial<VtUi> {
  const { busy: _b, error: _e, marked: _m, ...rest } = u;
  return rest;
}

export class VoiceTestController {
  private wait = new Map<string, (data: unknown) => void>();

  constructor(private readonly host: VtHost) {}

  active(): boolean {
    return this.host.ui().active;
  }

  private save() {
    this.host.storage('vt', JSON.stringify(persisted(this.host.ui())));
  }

  private set(p: Partial<VtUi>) {
    this.host.setUi(p);
    this.save();
  }

  /** Ссылка мастера → тестовая сессия (одноразово, как предпросмотр). */
  async start(token: string): Promise<boolean> {
    this.host.setUi({ ...vtOff(), active: true, busy: true });
    let r: Record<string, unknown>;
    try {
      r = OBJ(
        await this.host.api('POST', '/widget/v1/voice-test/session', { token })
      );
    } catch {
      this.host.setUi({ busy: false, error: 'expired' });
      return false;
    }
    const session = str(r.session, 200);
    const testId = str(r.testId, 64);
    const exp = Date.parse(str(r.expiresAt, 40));
    const vc = OBJ(r.voiceControl);
    if (!session || !testId || isNaN(exp)) {
      this.host.setUi({ busy: false, error: 'failed' });
      return false;
    }
    const cfg: VoiceControlPublic = {
      mode: 'on',
      denySelectors: Array.isArray(vc.denySelectors)
        ? (vc.denySelectors as unknown[])
            .filter((x): x is string => typeof x === 'string')
            .slice(0, 30)
        : [],
      allowSelectors: Array.isArray(vc.allowSelectors)
        ? (vc.allowSelectors as unknown[])
            .filter((x): x is string => typeof x === 'string')
            .slice(0, 30)
        : [],
      maxSteps: typeof vc.maxSteps === 'number' ? vc.maxSteps : 6,
    };
    this.host.storage('vtsess', JSON.stringify({ s: session, e: exp, cfg }));
    this.host.setSession(session);
    this.host.setVoiceControl(cfg);
    this.set({ ...vtOff(), active: true, testId, step: 1 });
    await this.env();
    return true;
  }

  /** Новая страница (MPA) во время мастера — продолжить с того же шага. */
  resume(): boolean {
    let sess: { s?: unknown; e?: unknown; cfg?: unknown } | null = null;
    try {
      sess = JSON.parse(this.host.storage('vtsess') || 'null');
    } catch {
      sess = null;
    }
    if (!sess || typeof sess.s !== 'string' || typeof sess.e !== 'number')
      return false;
    if (sess.e <= this.host.now()) {
      this.host.storage('vtsess', null);
      this.host.storage('vt', null);
      return false;
    }
    let saved: Partial<VtUi> = {};
    try {
      saved = OBJ(
        JSON.parse(this.host.storage('vt') || 'null')
      ) as Partial<VtUi>;
    } catch {
      saved = {};
    }
    this.host.setSession(sess.s);
    this.host.setVoiceControl(OBJ(sess.cfg) as unknown as VoiceControlPublic);
    this.host.setUi({
      ...vtOff(),
      ...saved,
      active: true,
      busy: false,
      error: null,
    });
    return true;
  }

  /** Ответ check.js (`vt-result` с ожидаемым rid; чужие — мимо). */
  onResult(rid: string, data: unknown) {
    const fn = this.wait.get(rid);
    if (!fn) return;
    this.wait.delete(rid);
    fn(data);
  }

  private ask(m: (rid: string) => FrameMessage): Promise<unknown> {
    const rid = this.host.random();
    return new Promise((resolve) => {
      this.wait.set(rid, resolve);
      this.host.toParent(m(rid));
      setTimeout(() => {
        if (this.wait.delete(rid)) resolve(null);
      }, RESULT_TIMEOUT_MS);
    });
  }

  // ── 1. окружение ────────────────────────────────────────────────────────

  async env() {
    this.host.setUi({ busy: true });
    const r = await this.ask((rid) => ({ type: 'vt-env', rid }));
    const o = OBJ(r);
    this.set({
      busy: false,
      env: {
        // Чанк не ответил — загрузчик не загрузил check.js (CSP сайта).
        widget: r !== null && o.widget === true,
        chunks: o.chunks === true,
        csp: int(o.csp),
        tt: int(o.tt),
        micPolicy: this.host.micPolicy(),
      },
    });
  }

  // ── 2. микрофон ─────────────────────────────────────────────────────────

  async mic() {
    this.host.setUi({ busy: true });
    const policy = this.host.micPolicy();
    let st: VtMicStatus;
    if (policy === 'denied') st = 'denied_policy';
    else st = await this.host.micProbe();
    this.set({ busy: false, mic: st });
    if (st === 'ok') this.host.listen();
  }

  /** Распознанная фраза в шаге «микрофон» (не уходит в чат как вопрос). */
  heard(text: string): boolean {
    const u = this.host.ui();
    if (!u.active || u.step !== 2) return false;
    this.set({ heard: text.slice(0, 120) });
    return true;
  }

  // ── 3. разметка ─────────────────────────────────────────────────────────

  async markup(cfg: VoiceControlPublic | null) {
    const u = this.host.ui();
    if (!u.testId) return;
    this.host.setUi({ busy: true, error: null });
    const snap = await this.host.plans.snap();
    if (!snap) return this.host.setUi({ busy: false, error: 'failed' });
    this.host.storage('vtsnap', JSON.stringify(snap));
    let a: Record<string, unknown> = {};
    try {
      a = OBJ(
        await this.host.api(
          'POST',
          `/widget/v1/voice-test/${u.testId}/analyze`,
          {
            snapshot: snap,
            lang: this.host.lang(),
          }
        )
      );
    } catch {
      return this.host.setUi({ busy: false, error: 'failed' });
    }
    const m = parseMarkup(
      await this.ask((rid) => ({
        type: 'vt-markup',
        rid,
        deny: cfg ? cfg.denySelectors : [],
        allow: cfg ? cfg.allowSelectors : [],
      }))
    );
    const never = (Array.isArray(a.never) ? a.never : [])
      .map(OBJ)
      .map((n) => ({ text: str(n.text, 80), reason: str(n.reason, 30) }))
      .slice(0, 50);
    // Список 2 — только то, что стоп-лист НЕ распознал (распознанное — в списке 1).
    const known = new Set(never.map((n) => n.text.toLowerCase()));
    const suspicious = m.suspicious.filter(
      (s) => !s.label || !known.has(s.label.toLowerCase())
    );
    const commands = (Array.isArray(a.commands) ? a.commands : [])
      .map(OBJ)
      .map((c) => ({ text: str(c.text, 120), safe: c.safe === true }))
      .filter((c) => c.text)
      .slice(0, 5);
    const forbidden = (Array.isArray(a.forbidden) ? a.forbidden : [])
      .map(OBJ)
      .map((f) => ({
        kind: str(f.kind, 20),
        command: str(f.command, 120),
        candidates: int(f.candidates),
        blocked: f.blocked === true,
        reasons: (Array.isArray(f.reasons) ? f.reasons : [])
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 10),
      }));
    this.set({
      busy: false,
      markup: m.markup,
      suspicious,
      reviewed: {},
      never,
      commands,
      forbidden,
      dry: [],
      safe: commands
        .filter((c) => c.safe)
        .slice(0, 3)
        .map((c) => ({ command: c.text, state: 'idle' as const })),
    });
  }

  review(key: string, decision: 'deny' | 'safe') {
    const u = this.host.ui();
    if (!u.suspicious.some((s) => s.key === key)) return;
    this.set({ reviewed: { ...u.reviewed, [key]: decision } });
  }

  /** Обвести пункты списка на странице (повторно — снять). */
  mark(keys: string[]) {
    const u = this.host.ui();
    const same =
      u.marked.length === keys.length &&
      keys.every((k) => u.marked.indexOf(k) >= 0);
    const next = same ? [] : keys;
    this.host.setUi({ marked: next });
    this.host.toParent({ type: 'vt-mark', keys: next });
  }

  // ── 4. сухой прогон ─────────────────────────────────────────────────────

  async dryRun(command: string) {
    const u = this.host.ui();
    if (u.dry.length >= 5 || u.dry.some((d) => d.command === command)) return;
    this.host.setUi({ busy: true, error: null });
    const v = await this.host.plans.dry(command);
    if (!v || !v.planId)
      return this.host.setUi({ busy: false, error: 'failed' });
    const steps = v.steps
      .filter((s) => s.target)
      .map((s) => (s.target ? s.target.text : ''));
    this.set({
      busy: false,
      dry: [
        ...this.host.ui().dry,
        { planId: v.planId, command, steps, ok: steps.map(() => null) },
      ],
    });
  }

  markDry(i: number, j: number, ok: boolean) {
    const dry = this.host
      .ui()
      .dry.map((d, k) =>
        k === i ? { ...d, ok: d.ok.map((x, n) => (n === j ? ok : x)) } : d
      );
    this.set({ dry });
  }

  // ── 5. с нажатием ───────────────────────────────────────────────────────

  async safeRun(i: number) {
    const u = this.host.ui();
    const s = u.safe[i];
    if (!s || s.state === 'running') return;
    this.set({
      safe: u.safe.map((x, k) => (k === i ? { ...x, state: 'running' } : x)),
    });
    const ok = await this.host.plans.command(s.command);
    if (!ok) this.planDone('failed');
  }

  /** Итог плана (фаза контроллера плана) — для идущей безопасной команды. */
  planDone(phase: 'done' | 'failed' | 'stopped') {
    const u = this.host.ui();
    if (!u.active) return;
    const i = u.safe.findIndex((x) => x.state === 'running');
    if (i < 0) return;
    this.set({
      safe: u.safe.map((x, k) =>
        k === i ? { ...x, state: phase === 'done' ? 'done' : 'failed' } : x
      ),
    });
  }

  // ── навигация по шагам ──────────────────────────────────────────────────

  go(step: number) {
    if (step < 1 || step > 7) return;
    if (this.host.ui().marked.length) this.mark([]);
    this.set({ step });
  }

  // ── 7. отчёт ────────────────────────────────────────────────────────────

  async report(env: VtEnv | null, mic: VtMicStatus | null) {
    const u = this.host.ui();
    if (!u.testId) return;
    this.host.setUi({ busy: true, error: null });
    let snap: unknown = null;
    try {
      snap = JSON.parse(this.host.storage('vtsnap') || 'null');
    } catch {
      snap = null;
    }
    let r: Record<string, unknown>;
    try {
      r = OBJ(
        await this.host.api(
          'POST',
          `/widget/v1/voice-test/${u.testId}/report`,
          {
            lang: this.host.lang(),
            snapshot: snap,
            env: env ?? {},
            mic: mic ?? 'skipped',
            markup: u.markup ?? {},
            suspicious: u.suspicious,
            reviewed: u.reviewed,
            dry: u.dry.map((d) => ({ planId: d.planId, ok: dryOk(d) })),
          }
        )
      );
    } catch (e) {
      const code = (e as { code?: string }).code;
      return this.host.setUi({
        busy: false,
        error: code === 'VOICE_TEST_INVALID' ? 'expired' : 'failed',
      });
    }
    const rep = OBJ(r.report);
    const result = (['pass', 'partial', 'fail'] as const).find(
      (x) => x === r.result
    );
    if (!result) return this.host.setUi({ busy: false, error: 'failed' });
    this.set({
      busy: false,
      step: 7,
      result: {
        result,
        validUntil: str(r.validUntil, 40),
        items: (Array.isArray(rep.items) ? rep.items : [])
          .map(OBJ)
          .map((x) => ({
            step: int(x.step),
            level: str(x.level, 10),
            code: str(x.code, 40),
          })),
        fragment: str(rep.fragment, 6000),
      },
    });
    // Сессия закрыта сдачей отчёта: дальше — обычный посетитель.
    this.host.storage('vtsess', null);
    this.host.storage('vtsnap', null);
    this.host.setSession(null);
    this.host.setVoiceControl(null);
  }

  close() {
    if (this.host.ui().marked.length) this.mark([]);
    this.host.storage('vt', null);
    this.host.setUi(vtOff());
  }
}
