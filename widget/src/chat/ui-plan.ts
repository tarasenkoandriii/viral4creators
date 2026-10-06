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
 *  - (д) Цепочки (§5-бис.15; Р-63…Р-65): строка плана — шаги с пометками
 *    ↺ вернётся / ⇄ можно отменить / ⚠ после этого отменить нельзя / ✋
 *    нажмёте сами; точка невозврата после перехода или 60 с — отдельная
 *    карточка «после этого отменить нельзя»; при сбое и стопе — перечень
 *    сделанного и «Вернуть / Оставить» (без ответа 60 с — «оставлено»);
 *    «отмени последнее» — та же вкладка (sessionStorage), прямой путь без
 *    модели. Поля возвращает загрузчик из памяти страницы (`ui-undo`),
 *    сюда приходят только итоги по номерам. Слов «откатил/отменил» нет.
 *  - (е) Мемо (§5-бис.17): карточка — имя и цель мемо, «повторить ещё
 *    раз?» для того же мемо в 60 с, «Готово: <цель>» только при
 *    `goalStatus = reached`; «що ти вмієш» — до 5 имён (без номеров).
 */
import type { VoiceControlPublic } from '../shared/config';
import { goalCheckOf, type UiGoalCheck } from '../shared/goal-check';
import type { FrameMessage, ParentMessage } from '../shared/protocol';
import {
  looksLikeCommand,
  parseSteps,
  replyKind,
  skillsPhrase,
  undoPhrase,
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
  | 'failed'
  /** (д) «Вернуть как было? [Вернуть] [Оставить]» после сбоя/стопа. */
  | 'offer';

/** (д) Пометка шага (§5-бис.15 п.5) — класс обратимости или «нажмёте сами». */
export type UiMark = 'none' | 'nav' | 'local' | 'comp' | 'irrev' | 'manual';
export const MARK_SYMBOL: Record<UiMark, string> = {
  none: '',
  nav: '',
  local: '↺',
  comp: '⇄',
  irrev: '⚠',
  manual: '✋',
};

/**
 * (д) Решения владельца в iframe (повтор `CHAIN_DECISIONS` сервера, сверка —
 * scripts/ui-plan.test.ts): «Вернуть/Оставить» без ответа 60 с — «оставлено».
 */
export const OFFER_TIMEOUT_MS = 60_000;
/** Ответ загрузчика о возврате полей — не дольше (чанк undo.js не загрузился). */
const UNDO_TIMEOUT_MS = 5_000;
/**
 * (Э6-тер (и)) Ответ загрузчика о компенсации: подсветка 0,6 с + проверка
 * результата до ~4,3 с + загрузка чанков. Нет ответа — `unknown`
 * («проверьте сами»): действие могло произойти — повтора нет.
 */
const COMP_TIMEOUT_MS = 12_000;
/** (Э6-тер (к)) Проверка цели: чанк ждёт счётчик до 4 с + загрузка чанка. */
const GOAL_TIMEOUT_MS = 6_000;

export interface UiPlanUi {
  phase: UiPlanPhase;
  planId: string | null;
  /** Шаги «с подтверждением» — что покажет карточка (видимый текст и значение). */
  confirmSteps: Array<{
    kind: string;
    text: string;
    value: string | null;
    mark?: UiMark;
  }>;
  /** (д) Карточка прямо перед точкой невозврата: «после этого отменить нельзя». */
  pnrCard?: boolean;
  /** (е) План мемо: имя и цель (номера посетителю не показываются). */
  memo?: { name: string; goal: string } | null;
  /** (е) «Повторить ещё раз?» — то же мемо и слоты в 60 с. */
  repeat?: boolean;
  /** (д) «Вернуть / Оставить»: что вернётся (поля) и что убрать самим. */
  offer?: { fields: string[]; manual: string[] } | null;
  /** «Да» отправлено, ответа ещё нет — кнопки карточки недоступны. */
  busy?: boolean;
}

export function uiPlanOff(): UiPlanUi {
  return {
    phase: 'idle',
    planId: null,
    confirmSteps: [],
    pnrCard: false,
    memo: null,
    repeat: false,
    offer: null,
    busy: false,
  };
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
  /** (д) Пометки по шагам; ТН; карточка второго «Да». */
  marks: UiMark[];
  pnr: number | null;
  pnrConfirm: boolean;
  /** (е) Мемо: имя и цель; карточка «повторить?»; итог цели. */
  memo: { name: string; goal: string } | null;
  repeat: boolean;
  goalStatus: string | null;
  /** (д) Что осталось на сайте после плана. */
  chainStatus: string | null;
  /**
   * (Э6-тер (к)) Проверки цели мемо «счётчик ±N»/«поле = слот» по номеру
   * шага: после `done` такого шага — проверка чанком undo.js, затем отчёт.
   */
  goals: Array<UiGoalCheck | null>;
}

const MARKS: readonly string[] = [
  'none',
  'nav',
  'local',
  'comp',
  'irrev',
  'manual',
];

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
  const memo =
    o.memo && typeof o.memo === 'object' && !Array.isArray(o.memo)
      ? (o.memo as Record<string, unknown>)
      : null;
  const short = (x: unknown, max: number) =>
    typeof x === 'string' ? x.slice(0, max) : '';
  const word = (x: unknown) =>
    typeof x === 'string' && /^[a-z_]{1,24}$/.test(x) ? x : null;
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
    marks: steps.map((_s, i) => {
      const m = Array.isArray(o.marks) ? o.marks[i] : null;
      return (MARKS.indexOf(m as string) >= 0 ? m : 'irrev') as UiMark;
    }),
    pnr:
      typeof o.pnr === 'number' &&
      Number.isInteger(o.pnr) &&
      o.pnr >= 0 &&
      o.pnr < steps.length
        ? o.pnr
        : null,
    pnrConfirm: o.pnrConfirm === true,
    memo: memo
      ? { name: short(memo.name, 60), goal: short(memo.goal, 160) }
      : null,
    repeat: o.repeat === true,
    goalStatus: word(o.goalStatus),
    chainStatus: word(o.chainStatus),
    goals: steps.map((_s, i) =>
      goalCheckOf(Array.isArray(o.steps) ? o.steps[i] : null, i)
    ),
  };
}

/** (д) Ответ маршрута возврата (`/undo`, `/undo-report`). */
interface UndoView {
  fields: Array<{ i: number; text: string }>;
  manual: Array<{ i: number; text: string }>;
  /** (Э6-тер (и)) Следующая компенсация (одна за раз). */
  comp: CompView | null;
  chainStatus: string | null;
  refused: string | null;
}

/**
 * (Э6-тер (и)) Компенсация от сервера: обратная цель по разметке, страница
 * отмены, строка и варианты товара, исключения стоп-листа для ЭТОЙ
 * разметки; `dispatched` — отметка «начат» записана, можно нажимать.
 */
export interface CompView {
  i: number;
  text: string;
  row: string | null;
  assistId: string;
  at: string | null;
  variant: string[];
  allow: Array<'remove' | 'unsubscribe'>;
  dispatched: boolean;
}

const ASSIST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const COMP_AT =
  /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@][A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$|^\/$/;

export function parseCompView(v: unknown): CompView | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const i = o.i;
  if (
    typeof i !== 'number' ||
    !Number.isInteger(i) ||
    i < 0 ||
    i > 20 ||
    typeof o.assistId !== 'string' ||
    !ASSIST_ID.test(o.assistId) ||
    (o.at !== null &&
      (typeof o.at !== 'string' || o.at.length > 200 || !COMP_AT.test(o.at))) ||
    (o.row !== null && (typeof o.row !== 'string' || o.row.length > 80))
  )
    return null;
  return {
    i,
    text: typeof o.text === 'string' ? o.text.slice(0, 81) : '',
    row: o.row as string | null,
    assistId: o.assistId,
    at: o.at as string | null,
    variant: (Array.isArray(o.variant) ? o.variant : [])
      .filter((x): x is string => typeof x === 'string' && x.length <= 40)
      .slice(0, 2),
    allow: (Array.isArray(o.allow) ? o.allow : []).filter(
      (x): x is 'remove' | 'unsubscribe' =>
        x === 'remove' || x === 'unsubscribe'
    ),
    dispatched: o.dispatched === true,
  };
}

function parseUndoView(v: unknown): UndoView | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const list = (x: unknown) =>
    (Array.isArray(x) ? x : [])
      .filter(
        (y): y is Record<string, unknown> =>
          !!y && typeof y === 'object' && typeof y.i === 'number'
      )
      .slice(0, 3)
      .map((y) => ({
        i: y.i as number,
        text: typeof y.text === 'string' ? y.text.slice(0, 81) : '',
      }));
  return {
    fields: list(o.fields),
    manual: list(o.manual),
    comp: parseCompView(o.comp),
    chainStatus:
      typeof o.chainStatus === 'string' && /^[a-z_]{1,24}$/.test(o.chainStatus)
        ? o.chainStatus
        : null,
    refused:
      typeof o.refused === 'string' && /^[a-z_]{1,20}$/.test(o.refused)
        ? o.refused
        : null,
  };
}

/** Итог возврата у загрузчика (поле или компенсация) — по номеру шага. */
type UndoResult = 'done' | 'failed' | 'unknown' | 'gone';

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
  /** Подтверждение в пути (одно на карточку). */
  private confirming = false;
  private queue: Promise<void> = Promise.resolve();
  private building: Promise<void> = Promise.resolve();
  /** (д) «Вернуть / Оставить»: план и таймер «оставлено» (60 с). */
  private offerPlan: string | null = null;
  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  /** (Э6-тер (к)) Ждём итог проверки цели мемо от загрузчика. */
  private goalWait: {
    planId: string;
    i: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (ok: boolean) => void;
  } | null = null;
  /** (д) Ждём итог возврата полей/компенсации от загрузчика. */
  private undoWait: {
    planId: string;
    idx: number[];
    timer: ReturnType<typeof setTimeout>;
    resolve: (r: Array<{ i: number; result: UndoResult }>) => void;
  } | null = null;

  constructor(private readonly host: UiPlanHost) {}

  available(): boolean {
    return !!this.host.cfg();
  }

  /** Идёт ли план (для голоса: «стоп» и пауза, а не новый вопрос). */
  active(): boolean {
    const p = this.host.ui().phase;
    return (
      p === 'running' || p === 'confirm' || p === 'thinking' || p === 'offer'
    );
  }

  isCommand(text: string): boolean {
    return looksLikeCommand(text);
  }

  /**
   * Текст — для плана, хотя не начинается с глагола-команды: «отмени
   * последнее», «що ти вмієш», и (е) любой текст, если у сайта есть мемо
   * (сервер сам скажет «не команда» — тогда это вопрос в чат).
   */
  wants(text: string): boolean {
    const cfg = this.host.cfg();
    return (
      !!cfg &&
      (looksLikeCommand(text) ||
        undoPhrase(text) ||
        skillsPhrase(text) ||
        cfg.memos === true)
    );
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
    if (!this.available()) return false;
    // (д) «Отмени последнее / верни как было / скасуй» — последняя цепочка
    // ЭТОЙ вкладки, прямой путь без модели (единиц не тратит, Р-65).
    if (undoPhrase(text)) {
      const last = this.host.storage('session', 'last');
      if (!last) return false;
      this.host.feed('visitor', text, source === 'voice');
      this.closeOffer();
      await this.undoRun(last, 'command');
      return true;
    }
    // (е) «Що ти вмієш?» — до 5 имён мемо (В-74); пусто — обычный вопрос.
    if (skillsPhrase(text)) return this.skills(text, source);
    if (!looksLikeCommand(text) && this.host.cfg()?.memos !== true)
      return false;
    // Одна команда за раз: новая ждёт, пока прошлая построится (снимок,
    // план); идущий план новая команда останавливает.
    await this.building;
    this.closeOffer();
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
    // (д) «Отмени последнее» — последняя цепочка этой вкладки.
    this.host.storage('session', 'last', v.planId);
    if (v.status === 'proposed') {
      this.showCard(v);
      return true;
    }
    this.run(v, source === 'voice');
    return true;
  }

  /** Шаг словами: «натисну „В кошик“». */
  private stepText(s: UiStep): string {
    return fmt(this.host.t().vcStep[s.kind], {
      t: (s.target && s.target.text) || '',
      v: s.value || '',
    });
  }

  /**
   * «Открою „Доставка“, выберу „Нова Пошта“» + чего не сделаю и почему.
   * (д) Цепочка (> 1 шага с эффектом или точка невозврата) — номерами с
   * пометками ↺/⇄/⚠/✋ (§5-бис.15 п.5); (е) мемо — имя и цель впереди.
   */
  summary(v: PlanView): string {
    const t = this.host.t();
    const marks = v.marks || [];
    const chain =
      v.pnr !== null ||
      marks.filter((m) => m === 'local' || m === 'comp' || m === 'irrev')
        .length > 1;
    const shown = v.steps
      .map((s, i) => ({ s, m: marks[i] || 'irrev' }))
      .filter(
        ({ s }) =>
          s.kind !== 'say' &&
          s.kind !== 'wait' &&
          (chain || (s.risk !== 'manual' && s.risk !== 'never'))
      );
    const parts = shown.map(({ s, m }, n) => {
      const txt = this.stepText(s);
      if (!chain) return txt;
      const sym = MARK_SYMBOL[m];
      return `${n + 1}${sym ? ' ' + sym : ''} ${txt}${m === 'irrev' ? ' ' + t.vcPnrTail : ''}`;
    });
    const says = v.steps
      .filter((s) => s.kind === 'say' && s.say)
      .map((s) => s.say as string);
    const why = v.notes.map((n) =>
      fmt(t.vcWhy[n.code as keyof Dict['vcWhy']] || t.vcWhy.no_target, {
        t: n.target || '',
      })
    );
    const out: string[] = [];
    if (v.memo && v.memo.name)
      out.push(
        v.memo.goal ? `«${v.memo.name}» — ${v.memo.goal}.` : `«${v.memo.name}».`
      );
    if (parts.length)
      out.push(fmt(t.vcPlan, { steps: parts.join(chain ? ' · ' : ', ') }));
    out.push(...says);
    if (why.length) out.push(why.join('; ') + '.');
    return out.join(' ');
  }

  private showCard(v: PlanView) {
    const marks = v.marks || [];
    // Второе «Да» прямо перед точкой невозврата — только этот шаг.
    const steps = v.steps
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) =>
        v.pnrConfirm ? i === v.pnr : s.risk === 'confirm' && i >= v.currentStep
      );
    this.host.setUi({
      phase: 'confirm',
      planId: v.planId,
      pnrCard: v.pnrConfirm,
      memo: v.memo,
      repeat: v.repeat,
      confirmSteps: steps.map(({ s, i }) => ({
        kind: s.kind,
        text: (s.target && s.target.text) || '',
        value: s.value,
        mark: marks[i] || 'irrev',
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
    // Аудит 06.10: двойной клик «Да» (или «да» голосом + кнопка) — второй
    // confirm, пока первый в пути, дал бы второй `ui-run` того же плана.
    if (!v || !v.planId || this.confirming) return;
    this.confirming = true;
    this.host.setUi({ busy: true });
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
    } finally {
      this.confirming = false;
      this.host.setUi({ busy: false });
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
      {
        type:
          | 'ui-snapshot'
          | 'ui-step'
          | 'ui-stopped'
          | 'ui-need'
          | 'ui-undone'
          | 'ui-goal';
      }
    >
  ) {
    if (m.type === 'ui-undone') {
      const w = this.undoWait;
      // Только ожидаемым шагам своего плана; чужие — мимо.
      if (
        w &&
        w.planId === m.planId &&
        m.results.every((r) => w.idx.indexOf(r.i) >= 0)
      ) {
        clearTimeout(w.timer);
        this.undoWait = null;
        w.resolve(m.results);
      }
      return;
    }
    if (m.type === 'ui-goal') {
      const w = this.goalWait;
      // Только ожидаемому шагу своего плана; чужие — мимо.
      if (w && w.planId === m.planId && w.i === m.i) {
        clearTimeout(w.timer);
        this.goalWait = null;
        w.resolve(m.ok);
      }
      return;
    }
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
        this.post('stop', { by: m.by }).then((r) =>
          this.traces(r ? { ...v, ...r, marks: v.marks, memo: v.memo } : v)
        )
      );
      return this.finish('stopped');
    }
    if (m.type === 'ui-need') {
      // После отчётов предыдущих шагов (очередь) — цели «после перехода».
      this.queue = this.queue.then(() => this.continueAfter(m.index));
      return;
    }
    // Э6-тер (к): шаг цели мемо со счётчиком/полем — «готово» только после
    // проверки страницы чанком undo.js (нет ответа — «не дошёл»).
    const g = m.result === 'done' ? v.goals[m.index] : null;
    this.queue = this.queue.then(async () => {
      const ok = g ? await this.goalCheck(m.planId, g) : true;
      return this.report(
        m.index,
        ok ? m.result : 'failed',
        ok ? m.reason : 'expect',
        m.url,
        m.ms
      );
    });
  }

  /** Проверка цели мемо на странице (ленивый чанк undo.js): да/нет. */
  private goalCheck(planId: string, g: UiGoalCheck): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.goalWait) {
        clearTimeout(this.goalWait.timer);
        this.goalWait.resolve(false);
      }
      const timer = setTimeout(() => {
        if (this.goalWait && this.goalWait.timer === timer) {
          this.goalWait = null;
          resolve(false);
        }
      }, GOAL_TIMEOUT_MS);
      this.goalWait = { planId, i: g.i, timer, resolve };
      this.host.toParent({ type: 'ui-undo', planId, idx: [], goal: g });
    });
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
      goalStatus: r.goalStatus,
      chainStatus: r.chainStatus,
      pnrConfirm: r.pnrConfirm,
    };
    if (result === 'dispatched' && r.status === 'proposed') {
      // (д) Р-60: точка невозврата после перехода/60 с — исполнитель
      // останавливается ДО клика, отдельное «Да» «после этого отменить нельзя».
      this.host.toParent({ type: 'ui-stop', planId: v.planId });
      this.host.listen(false);
      return this.showCard(this.plan);
    }
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
      this.finish('failed');
      return this.traces(this.plan);
    }
    const goal = this.plan.memo && this.plan.memo.goal;
    if (result === 'manual' || result === 'failed' || result === 'skipped') {
      const why =
        step && (step.risk === 'manual' || step.risk === 'never') && step.reason
          ? fmt(this.host.t().vcWhy[step.reason as keyof Dict['vcWhy']] || '', {
              t: text,
            })
          : '';
      const goalStep = step && step.kind === 'wait' && !!goal;
      this.host.feed(
        'assistant',
        goalStep
          ? fmt(this.host.t().vcMemoNotReached, { g: goal || '' })
          : why
            ? why + '.'
            : fmt(this.host.t().vcSelf, { t: text })
      );
      this.finish(result === 'manual' ? 'done' : 'failed');
      return this.traces(this.plan);
    }
    if (r.status === 'done') {
      this.host.feed(
        'assistant',
        r.goalStatus === 'reached' && goal
          ? fmt(this.host.t().vcMemoDone, { g: goal })
          : goal && r.goalStatus === 'unknown'
            ? // Проверить цель было нечем — без слова «готово».
              fmt(this.host.t().vcMemoUnknown, { g: goal })
            : this.host.t().vcDone
      );
      this.finish('done');
    }
  }

  // ── (д) что уже сделано и «Вернуть / Оставить» ─────────────────────────

  /**
   * После сбоя/стопа: перечень сделанного с пометками (§5-бис.15 п.10) и,
   * если есть что вернуть (поля, корзина), — «Вернуть как было?» (В-66).
   * Сбой на точке невозврата после клика — «не знаю, отправилось ли».
   */
  private traces(v: PlanView | null) {
    if (!v || !v.planId) return;
    const t = this.host.t();
    const marks = v.marks || [];
    const done = v.steps
      .map((s, i) => ({ s, i, m: marks[i] || 'irrev' }))
      .filter(
        ({ s, m }) =>
          s.state === 'done' && (m === 'local' || m === 'comp' || m === 'irrev')
      );
    const pnrUnknown =
      v.pnr !== null &&
      (v.steps[v.pnr].state === 'dispatched' ||
        v.steps[v.pnr].state === 'skipped' ||
        (v.steps[v.pnr].state === 'failed' && v.chainStatus === 'unknown'));
    if (pnrUnknown) this.host.feed('assistant', t.vcUnknownPnr);
    if (!done.length) return;
    this.host.feed(
      'assistant',
      fmt(t.vcDoneList, {
        list: done
          .map(({ s, m }) => `${MARK_SYMBOL[m]} ${this.stepText(s)}`.trim())
          .join(', '),
      })
    );
    // После выполненной ТН (форма отправлена) возвращать нечего (п.4 п.4).
    if (done.some(({ m }) => m === 'irrev')) return;
    const fields = done
      .filter(
        ({ s }) =>
          s.kind === 'fill' || s.kind === 'select' || s.kind === 'check'
      )
      .map(({ s }) => (s.target && s.target.text) || '');
    const manual = done
      .filter(({ m, s }) => m === 'comp' && s.kind === 'click')
      .map(({ s }) => (s.target && s.target.text) || '');
    if (!fields.length && !manual.length) return;
    this.offerPlan = v.planId;
    this.host.setUi({ phase: 'offer', offer: { fields, manual } });
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = setTimeout(() => {
      // Без ответа 60 с — «оставлено» (В-66).
      if (this.host.ui().phase === 'offer') void this.offerAnswer(false);
    }, OFFER_TIMEOUT_MS);
  }

  private closeOffer() {
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = null;
    if (this.host.ui().phase === 'offer')
      this.host.setUi({ phase: 'idle', offer: null });
    this.offerPlan = null;
  }

  /** «Вернуть» / «Оставить» (кнопкой или голосом «так/ні»). */
  async offerAnswer(yes: boolean) {
    const planId = this.offerPlan;
    if (!planId || this.host.ui().phase !== 'offer') return;
    this.closeOffer();
    if (!yes) {
      try {
        await this.host.api('POST', `/widget/v1/ui-plan/${planId}/undo`, {
          by: 'offer',
          decision: 'keep',
        });
      } catch {
        /* «оставлено» и так — статус цепочки уже kept */
      }
      this.host.feed('assistant', this.host.t().vcKept);
      return;
    }
    await this.undoRun(planId, 'offer');
  }

  /**
   * Возврат: сервер говорит, ЧТО можно вернуть — по одной работе в
   * обратном порядке: пачка полей (загрузчик возвращает их из памяти
   * страницы и присылает итог `ui-undone`) или (Э6-тер (и)) одна
   * компенсация объявленной пары. Без пары — «уберите сами».
   */
  private async undoRun(planId: string, by: 'offer' | 'command') {
    const t = this.host.t();
    let u: UndoView | null = null;
    try {
      u = parseUndoView(
        await this.host.api('POST', `/widget/v1/ui-plan/${planId}/undo`, {
          by,
        })
      );
    } catch {
      u = null;
    }
    if (!u) {
      this.host.feed('assistant', t.vcUndoNothing);
      return;
    }
    const refused: Record<string, string> = {
      after_pnr: t.vcAfterPnr,
      expired: t.vcUndoExpired,
      nothing: t.vcUndoNothing,
      unknown: t.vcUndoUnknown,
      degraded: t.vcUndoSelf,
    };
    if (u.refused) {
      this.host.feed('assistant', refused[u.refused] || t.vcUndoNothing);
      return;
    }
    if (u.manual.length)
      this.host.feed(
        'assistant',
        fmt(t.vcManualUndo, { t: u.manual.map((x) => x.text).join('», «') })
      );
    // Дальше — по ответам загрузчика (кнопка/голос не ждут исполнения).
    void this.undoLoop(planId, u, false);
  }

  /** (Э6-тер (и)) Отчёт возврата: итог, «начат» компенсации, «что дальше». */
  private async undoReport(
    planId: string,
    body: Record<string, unknown>
  ): Promise<UndoView | null> {
    try {
      return parseUndoView(
        await this.host.api(
          'POST',
          `/widget/v1/ui-plan/${planId}/undo-report`,
          body
        )
      );
    } catch {
      return null;
    }
  }

  /**
   * Работа возврата по очереди сервера: поля — разом; компенсация — переход
   * на страницу отмены (если она другая), отметка `dispatched` на сервере,
   * затем загрузчик (`comp.js`) и итог. `nav` — мы на странице отмены после
   * перехода (загрузчик снимет флаг «план идёт»).
   */
  private async undoLoop(planId: string, first: UndoView, nav: boolean) {
    const t = this.host.t();
    let u: UndoView | null = first;
    for (let guard = 0; u && guard < 8; guard++) {
      const c: CompView | null = u.comp;
      if (c) {
        const name = c.row || c.text;
        if (!c.dispatched && c.at) {
          const here = pathOfUrl(this.host.pageUrl());
          if (here === null || !samePath(here, c.at)) {
            const key = `${planId}:${c.i}`;
            // Уже переходили, а страница всё не та (редирект) — не ходим по кругу.
            if (this.host.storage('session', 'compgo') !== key) {
              this.host.storage('session', 'comp', planId);
              this.host.storage('session', 'compgo', key);
              this.host.feed('assistant', fmt(t.vcCompGo, { t: name }));
              this.host.toParent(compMessage(planId, { go: c.at }));
              return;
            }
            u = await this.undoReport(planId, { dispatch: c.i });
            u =
              u && u.comp && u.comp.dispatched
                ? await this.undoReport(planId, {
                    results: [{ i: c.i, result: 'gone' }],
                  })
                : null;
            this.host.feed('assistant', fmt(t.vcCompFailed, { t: name }));
            continue;
          }
        }
        if (!c.dispatched) {
          // Отметка «начат» ДО действия (один раз): нет записи — нет клика.
          const d = await this.undoReport(planId, { dispatch: c.i });
          if (!d || !d.comp || !d.comp.dispatched || d.comp.i !== c.i) {
            this.host.feed('assistant', t.vcUndoUnknown);
            break;
          }
        }
        const cfg = this.host.cfg();
        const result = (
          await this.waitUndone(
            planId,
            [c.i],
            compMessage(planId, {
              i: c.i,
              id: c.assistId,
              row: c.row,
              variant: c.variant,
              allow: c.allow,
              deny: cfg ? cfg.denySelectors : [],
              zones: cfg ? cfg.allowSelectors : [],
              nav: nav ? 1 : 0,
            }),
            COMP_TIMEOUT_MS,
            'unknown'
          )
        )[0].result;
        this.host.feed(
          'assistant',
          fmt(
            result === 'done'
              ? t.vcCompDone
              : result === 'unknown'
                ? t.vcCompUnknown
                : t.vcCompFailed,
            { t: name }
          )
        );
        u = await this.undoReport(planId, { results: [{ i: c.i, result }] });
        continue;
      }
      if (!u.fields.length) break;
      const fields = u.fields;
      const results = await this.waitUndone(
        planId,
        fields.map((f) => f.i),
        { type: 'ui-undo', planId, idx: fields.map((f) => f.i) },
        UNDO_TIMEOUT_MS,
        'gone'
      );
      this.fieldLines(fields, results);
      u = await this.undoReport(planId, { results });
    }
    this.host.storage('session', 'comp', null);
    this.host.storage('session', 'compgo', null);
  }

  /** Команда загрузчику и ожидание `ui-undone` по этим шагам (иначе — `miss`). */
  private waitUndone(
    planId: string,
    idx: number[],
    msg: FrameMessage,
    ms: number,
    miss: UndoResult
  ): Promise<Array<{ i: number; result: UndoResult }>> {
    return new Promise((resolve) => {
      if (this.undoWait) {
        clearTimeout(this.undoWait.timer);
        this.undoWait.resolve(
          this.undoWait.idx.map((i) => ({ i, result: miss }))
        );
      }
      const timer = setTimeout(() => {
        // Загрузчик не ответил (чанк не загрузился/страница сменилась).
        const w = this.undoWait;
        if (!w || w.timer !== timer) return;
        this.undoWait = null;
        resolve(idx.map((i) => ({ i, result: miss })));
      }, ms);
      this.undoWait = { planId, idx, timer, resolve };
      this.host.toParent(msg);
    });
  }

  /** Тексты итога возврата полей (без слов «откатил/отменил»). */
  private fieldLines(
    fields: Array<{ i: number; text: string }>,
    results: Array<{ i: number; result: UndoResult }>
  ) {
    const t = this.host.t();
    const text = (i: number) =>
      (fields.find((f) => f.i === i) || { text: '' }).text;
    const lines: string[] = [];
    if (results.some((r) => r.result === 'gone')) lines.push(t.vcFieldsGone);
    for (const r of results) {
      if (r.result === 'done') lines.push(fmt(t.vcFieldBack, { t: text(r.i) }));
      else if (r.result === 'unknown')
        lines.push(fmt(t.vcFieldUnknown, { t: text(r.i) }));
      else if (r.result === 'failed')
        lines.push(fmt(t.vcSelf, { t: text(r.i) }));
    }
    if (lines.length) this.host.feed('assistant', lines.join(' '));
  }

  /**
   * (Э6-тер (и)) На странице отмены после перехода: та же вкладка
   * (sessionStorage iframe) — компенсация продолжается (`next`), сервер
   * помнит, что уже сделано; окно — как у отчёта (10 мин + 60 с).
   */
  async undoResume(): Promise<boolean> {
    const planId = this.host.storage('session', 'comp');
    if (!planId || !/^[A-Za-z0-9_-]{1,64}$/.test(planId)) return false;
    const u = await this.undoReport(planId, { next: true });
    if (!u) {
      this.host.storage('session', 'comp', null);
      this.host.storage('session', 'compgo', null);
      this.host.feed('assistant', this.host.t().vcUndoUnknown);
      return true;
    }
    void this.undoLoop(planId, u, true);
    return true;
  }

  /**
   * (е) «Я умею» (Р-72): до 5 имён мемо с успехом цели ≥ 80% — без номеров
   * и фраз; сбой — пусто. Э6-тер: и подсказка под микрофоном.
   */
  async skillNames(): Promise<string[]> {
    try {
      const r = (await this.host.api(
        'GET',
        `/widget/v1/ui-plan/skills?lang=${this.host.lang()}`
      )) as { names?: unknown } | null;
      return Array.isArray(r && r.names)
        ? (r!.names as unknown[])
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.slice(0, 60))
            .slice(0, 5)
        : [];
    } catch {
      return [];
    }
  }

  /** (е) «Що ти вмієш?» — до 5 имён мемо; пусто — обычный вопрос в чат. */
  private async skills(
    text: string,
    source: 'voice' | 'typed'
  ): Promise<boolean> {
    const names = await this.skillNames();
    if (!names.length) return false;
    this.host.feed('visitor', text, source === 'voice');
    this.host.feed(
      'assistant',
      fmt(this.host.t().vcSkills, {
        list: names.map((n) => `«${n}»`).join(', '),
      })
    );
    return true;
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
    const running = p === 'running';
    this.queue = this.queue.then(() =>
      this.post('stop', { by }).then((r) => {
        // (д) Стоп посреди цепочки — перечень сделанного и «Вернуть?».
        if (running)
          this.traces(r ? { ...v, ...r, marks: v.marks, memo: v.memo } : v);
      })
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
    if (phase === 'offer') {
      // «Вернуть как было?» — «так»/«ні» по тому же закрытому списку.
      const r = replyKind(text);
      if (r === 'yes' || r === 'no' || r === 'stop') {
        await this.offerAnswer(r === 'yes');
        return true;
      }
      this.closeOffer();
      return false;
    }
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
    this.host.setUi({
      phase,
      confirmSteps: [],
      pnrCard: false,
      repeat: false,
    });
  }

  // ── продолжение после перехода (§4-бис.5) ──────────────────────────────

  /**
   * На новой странице: живой план ЭТОЙ вкладки (флаг в sessionStorage
   * iframe). Шаг `dispatched` не повторяется — только сверка адреса; шаги
   * «после перехода» получают цели из нового снимка на сервере.
   */
  async resume() {
    if (!this.available()) return;
    // (Э6-тер (и)) Перешли на страницу отмены — продолжаем компенсацию.
    if (await this.undoResume()) return;
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

/**
 * (Э6-тер (и)) `ui-undo` с полем `comp` — загрузчик отдаёт команду сырой
 * (act.js → undo.js → comp.js разбирает строго): форма протокола
 * (`shared/protocol.ts`) не меняется.
 */
function compMessage(
  planId: string,
  comp: Record<string, unknown>
): FrameMessage {
  const m: Extract<FrameMessage, { type: 'ui-undo' }> & {
    comp: Record<string, unknown>;
  } = { type: 'ui-undo', planId, idx: [], comp };
  return m;
}
