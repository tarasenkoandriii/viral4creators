/**
 * Голосовое управление «Сайтом» — сторона iframe-чата (Э6-бис (а), ТЗ
 * помощника §5-бис.3–6, §4-бис.5). Узкий стык с ChatController (тест без
 * DOM — scripts/ui-plan.test.ts).
 *
 *  - План — только из речи (билет голоса) или набора в поле iframe
 *    (§5-бис.6 п.1): `V4CAssist('ask')` и `postMessage` страницы сюда не
 *    приходят никогда (контроллер чата зовёт `command` только из своих
 *    обработчиков ввода и голоса).
 *  - Первая команда-действие — «Помощник может нажимать кнопки… —
 *    разрешить?» (один раз на сайт, localStorage iframe, §5-бис.2).
 *    Решение владельца 03.10.2026 п.3: согласие хранится с ВЕРСИЕЙ текста
 *    (`VC_CONSENT_VERSION`) — сменили текст, спросим снова; отозвать — в
 *    меню виджета (подвал окна).
 *  - Снимок страницы просит у загрузчика (одноразовый `rid`; чужой ответ —
 *    мимо), план строит сервер, исполняет загрузчик; здесь — строка плана,
 *    карточка «Да/Нет» с тем, ЧТО будет нажато (видимый текст), отчёты шагов
 *    на сервер ПО ОЧЕРЕДИ, `dispatched` → `ui-ack` (действие с побочным
 *    эффектом — только после записи на сервере), стоп, продолжение после
 *    перехода — только в той вкладке, где план отдан (флаг плана —
 *    sessionStorage iframe, §4-бис.7).
 *  - После перезагрузки шаг `dispatched` НЕ повторяется никогда (аудит
 *    Э6-бис): навигационный — сверка адреса (адрес страницы уходит на
 *    сервер — без него `done` не примут), остальные («В кошик», поле) —
 *    могли уже выполниться: «проверьте сами», шаг `skipped/interrupted`,
 *    план стоп.
 */
import type { VoiceControlPublic } from '../shared/config';
import type { FrameMessage, ParentMessage } from '../shared/protocol';
import {
  looksLikeCommand,
  parseSteps,
  replyKind,
  type UiStep,
  type UiStepResult,
} from '../shared/ui-plan';
import type { Dict } from './i18n';

/**
 * Версия текста согласия «нажимать за вас» (`vcConsent` в i18n.ts): текст
 * поменялся — версию поднять, и каждый посетитель увидит вопрос заново
 * (решение владельца 03.10.2026 п.3). Сверку «текст ↔ версия» держит
 * scripts/voice-test.test.ts (отпечаток текстов).
 */
export const VC_CONSENT_VERSION = '1';

export type UiPlanPhase =
  | 'idle'
  | 'consent'
  | 'thinking'
  | 'confirm'
  | 'running'
  | 'done'
  | 'stopped'
  | 'failed';

export interface UiPlanUi {
  phase: UiPlanPhase;
  planId: string | null;
  /** Шаги «с подтверждением» — что покажет карточка (видимый текст и значение). */
  confirmSteps: Array<{ kind: string; text: string; value: string | null }>;
}

export function uiPlanOff(): UiPlanUi {
  return { phase: 'idle', planId: null, confirmSteps: [] };
}

export interface PlanView {
  kind: 'plan' | 'not_command';
  planId: string | null;
  conversationId: string | null;
  status: string | null;
  steps: UiStep[];
  currentStep: number;
  notes: Array<{ code: string; target: string | null }>;
  needsConfirm: boolean;
  stepsHash: string | null;
}

/** Строгий разбор ответа маршрутов плана. */
export function parsePlanView(v: unknown): PlanView | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const steps = parseSteps(o.steps);
  if (!steps) return null;
  const id = (x: unknown) =>
    typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x) ? x : null;
  const notes = Array.isArray(o.notes)
    ? o.notes
        .filter(
          (n): n is Record<string, unknown> => !!n && typeof n === 'object'
        )
        .map((n) => ({
          code:
            typeof n.code === 'string' && /^[a-z_]{1,30}$/.test(n.code)
              ? n.code
              : 'no_target',
          target: typeof n.target === 'string' ? n.target.slice(0, 81) : null,
        }))
        .slice(0, 20)
    : [];
  const cur = o.currentStep;
  return {
    kind: o.kind === 'not_command' ? 'not_command' : 'plan',
    planId: id(o.planId),
    conversationId: id(o.conversationId),
    status:
      typeof o.status === 'string' && /^[a-z]{1,12}$/.test(o.status)
        ? o.status
        : null,
    steps,
    currentStep:
      typeof cur === 'number' &&
      Number.isInteger(cur) &&
      cur >= 0 &&
      cur <= steps.length
        ? cur
        : 0,
    notes,
    needsConfirm: o.needsConfirm === true,
    stepsHash:
      typeof o.stepsHash === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(o.stepsHash)
        ? o.stepsHash
        : null,
  };
}

export interface UiPlanHost {
  ui(): UiPlanUi;
  setUi(p: Partial<UiPlanUi>): void;
  t(): Dict;
  lang(): 'uk' | 'ru' | 'en';
  cfg(): VoiceControlPublic | null;
  api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
  toParent(m: FrameMessage): void;
  conversationId(): string | null;
  setConversation(id: string): void;
  /** Строка в ленте: команда посетителя и реплика помощника (только локально). */
  feed(role: 'visitor' | 'assistant', text: string, byVoice?: boolean): void;
  storage(
    kind: 'local' | 'session',
    name: string,
    value?: string | null
  ): string | null;
  /** Адрес текущей страницы (из init/route загрузчика). */
  pageUrl(): string | null;
  /** Микрофон на время плана (только если человек нажал его в этом документе). */
  listen(on: boolean): void;
  random(): string;
  /** (г) Выпуск чанков (канарейка) — уходит в план для монитора. */
  release?(): string | null;
}

const SNAP_TIMEOUT_MS = 4000;

function fmt(s: string, vars: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '');
}

export class UiPlanController {
  private snapWait: { rid: string; resolve: (s: unknown) => void } | null =
    null;
  private pendingCmd: {
    text: string;
    source: 'voice' | 'typed';
    ticket: string | null;
  } | null = null;
  private plan: PlanView | null = null;
  private queue: Promise<void> = Promise.resolve();
  private building: Promise<void> = Promise.resolve();

  constructor(private readonly host: UiPlanHost) {}

  available(): boolean {
    return !!this.host.cfg();
  }

  /** Идёт ли план (для голоса: «стоп» и пауза, а не новый вопрос). */
  active(): boolean {
    const p = this.host.ui().phase;
    return p === 'running' || p === 'confirm' || p === 'thinking';
  }

  isCommand(text: string): boolean {
    return looksLikeCommand(text);
  }

  // ── команда ─────────────────────────────────────────────────────────────

  /**
   * Речь или набор посетителя → план. `false` — это не команда (или режима
   * нет): контроллер чата отправит текст обычным вопросом.
   */
  async command(
    text: string,
    source: 'voice' | 'typed',
    ticket: string | null
  ): Promise<boolean> {
    if (!this.available() || !looksLikeCommand(text)) return false;
    // Одна команда за раз: новая ждёт, пока прошлая построится (снимок,
    // план); идущий план новая команда останавливает.
    await this.building;
    if (
      this.host.ui().phase === 'running' ||
      this.host.ui().phase === 'confirm'
    )
      this.stop('button');
    if (!this.consented()) {
      this.pendingCmd = { text, source, ticket };
      this.host.setUi({ phase: 'consent' });
      return true;
    }
    const b = this.build(text, source, ticket);
    this.building = b.then(
      () => undefined,
      () => undefined
    );
    return b;
  }

  consent(ok: boolean) {
    const p = this.pendingCmd;
    this.pendingCmd = null;
    if (!ok || !p) return this.host.setUi({ phase: 'idle' });
    this.host.storage('local', 'vcconsent', VC_CONSENT_VERSION);
    void this.build(p.text, p.source, p.ticket);
  }

  /** Согласие дано на ТЕКУЩИЙ текст (решение владельца п.3). */
  consented(): boolean {
    return this.host.storage('local', 'vcconsent') === VC_CONSENT_VERSION;
  }

  /** Отозвать согласие (меню виджета): следующая команда спросит заново. */
  revokeConsent() {
    if (this.active()) this.stop('button');
    this.host.storage('local', 'vcconsent', null);
    this.host.feed('assistant', this.host.t().vcRevoked);
    this.host.setUi({ phase: 'idle' });
  }

  /** (г) Снимок страницы для мастера проверки (тот же, что у плана). */
  snap(): Promise<unknown> {
    return this.snapshot();
  }

  /**
   * (г) Сухой прогон мастера Т-2: план строится и проверяется сервером
   * (только в тестовой сессии), цели только ПОДСВЕЧИВАЮТСЯ — шаги
   * превращаются в «подсветку» с той же целью (исполнитель ничего не
   * нажимает и ничего не шлёт на сервер: план-«призрак» с префиксом `dry`).
   */
  async dry(text: string): Promise<PlanView | null> {
    const snap = await this.snapshot();
    if (!snap) return null;
    let v: PlanView | null = null;
    try {
      v = parsePlanView(
        await this.host.api('POST', '/widget/v1/ui-plan', {
          text,
          source: 'typed',
          dryRun: true,
          lang: this.host.lang(),
          snapshot: snap,
          release: this.host.release ? this.host.release() : null,
        })
      );
    } catch {
      return null;
    }
    if (!v || v.kind !== 'plan' || !v.planId) return v;
    this.host.toParent({
      type: 'ui-run',
      planId: `dry${v.planId}`.slice(0, 64),
      steps: v.steps.map((s) => ({
        ...s,
        kind: s.target ? 'highlight' : s.kind === 'say' ? 'say' : 'wait',
        risk: 'auto',
        nav: false,
        expect: null,
        value: null,
        state: 'pending',
      })),
      from: 0,
      lang: this.host.lang(),
    });
    return v;
  }

  private snapshot(): Promise<unknown> {
    const cfg = this.host.cfg();
    const rid = this.host.random();
    return new Promise((resolve) => {
      this.snapWait = { rid, resolve };
      this.host.toParent({
        type: 'ui-snap',
        rid,
        deny: cfg ? cfg.denySelectors : [],
        allow: cfg ? cfg.allowSelectors : [],
      });
      setTimeout(() => {
        if (this.snapWait && this.snapWait.rid === rid) {
          this.snapWait = null;
          resolve(null);
        }
      }, SNAP_TIMEOUT_MS);
    });
  }

  private async build(
    text: string,
    source: 'voice' | 'typed',
    ticket: string | null
  ): Promise<boolean> {
    const t = this.host.t();
    this.host.setUi({ phase: 'thinking', planId: null, confirmSteps: [] });
    const snap = await this.snapshot();
    if (!snap) {
      this.host.feed('visitor', text, source === 'voice');
      this.host.feed('assistant', t.vcNoSnapshot);
      this.host.setUi({ phase: 'failed' });
      return true;
    }
    let v: PlanView | null;
    try {
      v = parsePlanView(
        await this.host.api('POST', '/widget/v1/ui-plan', {
          text,
          source,
          voiceTicket: ticket,
          conversationId: this.host.conversationId(),
          lang: this.host.lang(),
          snapshot: snap,
          release: this.host.release ? this.host.release() : null,
        })
      );
    } catch {
      this.host.setUi({ phase: 'idle' });
      // Режим выключили/упал — вопрос уйдёт в чат текстом.
      return false;
    }
    if (!v || v.kind === 'not_command') {
      this.host.setUi({ phase: 'idle' });
      return false;
    }
    this.host.feed('visitor', text, source === 'voice');
    if (v.conversationId) this.host.setConversation(v.conversationId);
    this.plan = v;
    const line = this.summary(v);
    if (line) this.host.feed('assistant', line);
    if (!v.planId || !v.steps.length) {
      if (!line) this.host.feed('assistant', t.vcNothing);
      this.host.setUi({ phase: 'done', planId: v.planId });
      return true;
    }
    this.host.storage('session', 'plan', v.planId);
    if (v.status === 'proposed') {
      this.showCard(v);
      return true;
    }
    this.run(v, source === 'voice');
    return true;
  }

  /** «Открою „Доставка“, выберу „Нова Пошта“» + чего не сделаю и почему. */
  summary(v: PlanView): string {
    const t = this.host.t();
    const parts = v.steps
      .filter(
        (s) => s.risk !== 'manual' && s.risk !== 'never' && s.kind !== 'say'
      )
      .map((s) =>
        fmt(t.vcStep[s.kind], {
          t: (s.target && s.target.text) || '',
          v: s.value || '',
        })
      );
    const says = v.steps
      .filter((s) => s.kind === 'say' && s.say)
      .map((s) => s.say as string);
    const why = v.notes.map((n) =>
      fmt(t.vcWhy[n.code as keyof Dict['vcWhy']] || t.vcWhy.no_target, {
        t: n.target || '',
      })
    );
    const out: string[] = [];
    if (parts.length) out.push(fmt(t.vcPlan, { steps: parts.join(', ') }));
    out.push(...says);
    if (why.length) out.push(why.join('; ') + '.');
    return out.join(' ');
  }

  private showCard(v: PlanView) {
    this.host.setUi({
      phase: 'confirm',
      planId: v.planId,
      confirmSteps: v.steps
        .filter((s) => s.risk === 'confirm')
        .map((s) => ({
          kind: s.kind,
          text: (s.target && s.target.text) || '',
          value: s.value,
        })),
    });
  }

  /** «Да»/«Нет» кнопкой (жест в iframe). */
  async confirm(ok: boolean) {
    const v = this.plan;
    if (!v || !v.planId || this.host.ui().phase !== 'confirm') return;
    if (!ok) return this.stop('button');
    await this.sendConfirm({ by: 'button', stepsHash: v.stepsHash });
  }

  /** «Да» голосом: билет на ЭТОТ текст; «нет»/«стоп» — стоп. */
  async confirmVoice(text: string, ticket: string | null) {
    const v = this.plan;
    if (!v || !v.planId) return;
    const r = replyKind(text);
    if (r === 'no' || r === 'stop') return this.stop('voice');
    if (r !== 'yes' || !ticket) return; // не «да» — карточка ждёт дальше
    await this.sendConfirm(
      { by: 'voice', stepsHash: v.stepsHash, text, voiceTicket: ticket },
      true
    );
  }

  private async sendConfirm(body: Record<string, unknown>, byVoice = false) {
    const v = this.plan;
    if (!v || !v.planId) return;
    try {
      const r = parsePlanView(
        await this.host.api(
          'POST',
          `/widget/v1/ui-plan/${v.planId}/confirm`,
          body
        )
      );
      if (!r) throw new Error('bad');
      if (r.status === 'stopped') return this.finish('stopped');
      this.plan = r;
      this.run(r, byVoice);
    } catch (e) {
      const code = (e as { code?: string }).code;
      this.host.feed(
        'assistant',
        code === 'PLAN_EXPIRED'
          ? this.host.t().vcExpired
          : this.host.t().vcFailed
      );
      this.finish('failed');
    }
  }

  // ── исполнение ──────────────────────────────────────────────────────────

  private run(v: PlanView, voice: boolean) {
    if (!v.planId) return;
    this.host.setUi({ phase: 'running', planId: v.planId, confirmSteps: [] });
    this.host.toParent({
      type: 'ui-run',
      planId: v.planId,
      steps: v.steps,
      from: v.currentStep,
      lang: this.host.lang(),
    });
    if (voice) this.host.listen(true);
  }

  /** Сообщения загрузчика о плане (снимок, шаги, стоп человеком). */
  onParent(
    m: Extract<
      ParentMessage,
      { type: 'ui-snapshot' | 'ui-step' | 'ui-stopped' | 'ui-need' }
    >
  ) {
    if (m.type === 'ui-snapshot') {
      const w = this.snapWait;
      // Только ответ на СВОЙ запрос (одноразовый rid); чужие — мимо.
      if (w && w.rid === m.rid) {
        this.snapWait = null;
        w.resolve(m.snapshot);
      }
      return;
    }
    const v = this.plan;
    if (!v || v.planId !== m.planId || this.host.ui().phase !== 'running')
      return;
    if (m.type === 'ui-stopped') {
      this.queue = this.queue.then(() =>
        this.post('stop', { by: m.by }).then(() => undefined)
      );
      return this.finish('stopped');
    }
    if (m.type === 'ui-need') {
      // После отчётов предыдущих шагов (очередь) — цели «после перехода».
      this.queue = this.queue.then(() => this.continueAfter(m.index));
      return;
    }
    this.queue = this.queue.then(() =>
      this.report(m.index, m.result, m.reason, m.url, m.ms)
    );
  }

  private async post(
    kind: 'step' | 'stop',
    body: unknown
  ): Promise<PlanView | null> {
    const v = this.plan;
    if (!v || !v.planId) return null;
    try {
      return parsePlanView(
        await this.host.api(
          'POST',
          `/widget/v1/ui-plan/${v.planId}/${kind}`,
          body
        )
      );
    } catch {
      return null;
    }
  }

  private async report(
    index: number,
    result: UiStepResult,
    reason: string | null,
    url: string | null,
    ms: number
  ) {
    const v = this.plan;
    if (!v || !v.planId) return;
    const r = await this.post('step', {
      index,
      result,
      reason,
      url,
      durationMs: ms,
    });
    if (!r) {
      // Сервер не записал шаг — дальше не идём (dispatched без записи — без клика).
      this.host.toParent({ type: 'ui-stop', planId: v.planId });
      this.host.feed('assistant', this.host.t().vcFailed);
      return this.finish('failed');
    }
    this.plan = {
      ...v,
      steps: r.steps,
      currentStep: r.currentStep,
      status: r.status,
    };
    if (result === 'dispatched') {
      this.host.toParent({ type: 'ui-ack', planId: v.planId, index });
      return;
    }
    const step = v.steps[index];
    const text = (step && step.target && step.target.text) || '';
    if (result === 'skipped' && reason === 'interrupted') {
      this.host.feed(
        'assistant',
        fmt(this.host.t().vcInterrupted, { t: text })
      );
      return this.finish('failed');
    }
    if (result === 'manual' || result === 'failed' || result === 'skipped') {
      const why =
        step && (step.risk === 'manual' || step.risk === 'never') && step.reason
          ? fmt(this.host.t().vcWhy[step.reason as keyof Dict['vcWhy']] || '', {
              t: text,
            })
          : '';
      this.host.feed(
        'assistant',
        why ? why + '.' : fmt(this.host.t().vcSelf, { t: text })
      );
      return this.finish(result === 'manual' ? 'done' : 'failed');
    }
    if (r.status === 'done') {
      this.host.feed('assistant', this.host.t().vcDone);
      this.finish('done');
    }
  }

  /** SPA: шаги «после перехода» — новый снимок, проверка сервером, продолжение. */
  private async continueAfter(index: number) {
    const v = this.plan;
    if (!v || !v.planId || this.host.ui().phase !== 'running') return;
    if (v.currentStep !== index) return;
    const snap = await this.snapshot();
    let r: PlanView | null = null;
    try {
      r = snap
        ? parsePlanView(
            await this.host.api(
              'POST',
              `/widget/v1/ui-plan/${v.planId}/resume`,
              { snapshot: snap }
            )
          )
        : null;
    } catch {
      r = null;
    }
    if (!r || r.status === 'failed' || r.status === 'stopped') {
      this.host.feed('assistant', this.host.t().vcNothing);
      return this.finish('failed');
    }
    const next = { ...v, ...r, notes: [] };
    this.plan = next;
    if (r.status === 'proposed') return this.showCard(next);
    this.run(next, false);
  }

  /** Стоп из iframe: кнопка, «стоп» голосом, закрыли окно. */
  stop(by: 'button' | 'esc' | 'voice' | 'close') {
    const v = this.plan;
    if (!v || !v.planId) return;
    const p = this.host.ui().phase;
    if (p !== 'running' && p !== 'confirm' && p !== 'thinking') return;
    this.host.toParent({ type: 'ui-stop', planId: v.planId });
    this.queue = this.queue.then(() =>
      this.post('stop', { by }).then(() => undefined)
    );
    this.host.feed('assistant', this.host.t().vcStopped);
    this.finish('stopped');
  }

  /** Детектор речи на устройстве: начало речи — пауза ДО распознавания. */
  speech(on: boolean) {
    if (this.host.ui().phase === 'running')
      this.host.toParent({ type: 'ui-pause', on });
  }

  /**
   * Распознанная фраза во время плана: «стоп» — стоп; «да» на карточке —
   * подтверждение; другое — новая команда (текущий план останавливается).
   */
  async planSpeech(text: string, ticket: string | null): Promise<boolean> {
    const phase = this.host.ui().phase;
    if (phase === 'confirm') {
      await this.confirmVoice(text, ticket);
      return true;
    }
    if (phase !== 'running') return false;
    const r = replyKind(text);
    if (r === 'stop' || r === 'no') {
      this.stop('voice');
      return true;
    }
    if (!text.trim()) {
      this.speech(false);
      return true;
    }
    this.stop('voice');
    return this.command(text, 'voice', ticket);
  }

  private finish(phase: 'done' | 'stopped' | 'failed') {
    this.host.listen(false);
    this.host.storage('session', 'plan', null);
    this.host.setUi({ phase, confirmSteps: [] });
  }

  // ── продолжение после перехода (§4-бис.5) ──────────────────────────────

  /**
   * На новой странице: живой план ЭТОЙ вкладки (флаг в sessionStorage
   * iframe). Шаг `dispatched` не повторяется — только сверка адреса; шаги
   * «после перехода» получают цели из нового снимка на сервере.
   */
  async resume() {
    if (!this.available()) return;
    const mine = this.host.storage('session', 'plan');
    let v: PlanView | null = null;
    try {
      const r = (await this.host.api('GET', '/widget/v1/ui-plan/active')) as {
        plan?: unknown;
      } | null;
      v = r && r.plan ? parsePlanView(r.plan) : null;
    } catch {
      return;
    }
    if (!v || !v.planId) return;
    if (v.planId !== mine) {
      // Другая вкладка отдала план — здесь не исполняем (§4-бис.7).
      return;
    }
    this.plan = v;
    if (v.conversationId) this.host.setConversation(v.conversationId);
    if (v.status === 'proposed') return this.showCard(v);
    this.host.setUi({ phase: 'running', planId: v.planId });
    let cur = v.currentStep;
    const step = v.steps[cur];
    const url = this.host.pageUrl();
    if (step && step.state === 'dispatched' && !step.nav) {
      // Страница перезагрузилась между действием и отчётом: «В кошик» мог
      // уже сработать — второй раз не нажимаем, человек проверит сам.
      await this.post('step', {
        index: cur,
        result: 'skipped',
        reason: 'interrupted',
        url,
      });
      this.host.feed(
        'assistant',
        fmt(this.host.t().vcInterrupted, {
          t: (step.target && step.target.text) || '',
        })
      );
      return this.finish('failed');
    }
    if (step && step.state === 'dispatched') {
      const want = step.expect && step.expect.path;
      const path = pathOfUrl(url);
      const ok = !want || (path !== null && samePath(path, want));
      // Адрес новой страницы — сервер сверяет `expect.path` сам.
      const r = await this.post('step', {
        index: cur,
        result: ok ? 'done' : 'failed',
        reason: ok ? null : 'expect',
        url,
      });
      if (!r || !ok) {
        this.host.feed(
          'assistant',
          fmt(this.host.t().vcSelf, {
            t: (step.target && step.target.text) || '',
          })
        );
        return this.finish('failed');
      }
      v = {
        ...v,
        steps: r.steps,
        currentStep: r.currentStep,
        status: r.status,
      };
      this.plan = v;
      if (r.status === 'done') {
        this.host.feed('assistant', this.host.t().vcDone);
        return this.finish('done');
      }
      cur = r.currentStep;
    }
    // Снимок новой страницы — и цели шагов «после перехода», и исполнителю.
    const snap = await this.snapshot();
    if (!snap) {
      this.host.feed('assistant', this.host.t().vcNoSnapshot);
      return this.finish('failed');
    }
    if (v.steps.slice(cur).some((s) => s.target && s.target.ref === 'after')) {
      let r: PlanView | null = null;
      try {
        r = parsePlanView(
          await this.host.api('POST', `/widget/v1/ui-plan/${v.planId}/resume`, {
            snapshot: snap,
          })
        );
      } catch {
        r = null;
      }
      if (!r || r.status === 'failed' || r.status === 'stopped') {
        this.host.feed('assistant', this.host.t().vcNothing);
        return this.finish('failed');
      }
      v = { ...v, ...r, notes: [] };
      this.plan = v;
      if (r.status === 'proposed') return this.showCard(v);
    }
    // Микрофон после перехода сам не открывается (Р-28): стоп — кнопкой/Esc/кликом.
    this.run(v, false);
  }
}

function pathOfUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function samePath(path: string, want: string): boolean {
  const n = (p: string) => p.replace(/\/+$/, '') || '/';
  return want.endsWith('*')
    ? n(path).indexOf(n(want.slice(0, -1))) === 0
    : n(path) === n(want);
}
