/**
 * Голосовое управление «Админкой» — сторона iframe `wa.` (Э6-бис (б), ТЗ
 * §5-бис.2–6 «Админка», §5-бис.13, §5-бис.15, §5-бис.17) — ленивый
 * ES-модуль `dist/v1/admin-vc.js` (бюджет — scripts/size-budget.mjs;
 * admin-chat.js не растёт: чанк берётся только когда режим включён или
 * открыта ссылка мастера).
 *
 *  - Контроллер плана — ТОТ ЖЕ, что у «Сайта» (`chat/ui-plan.ts`): снимок,
 *    карточка, отчёты шагов по очереди, `dispatched` → `ui-ack`, стоп,
 *    продолжение после перехода, «Вернуть / Оставить». Здесь — только
 *    адаптер: маршруты `/assist-admin/v1/*` с сессией сотрудника, ответы
 *    «Админки» (`api` → вопрос в чат: изменение через API — карточка Э8 с
 *    «Да»; `memo` — текст мемо; следующий отрезок мемо на странице).
 *  - План — только из речи (микрофон в этом iframe) или набора в поле этого
 *    iframe; страница админки команд не даёт.
 *  - Согласие «натискати за вас» — на СЕССИЮ сотрудника (Р-Э6б-12):
 *    sessionStorage `wa.` с версией текста и сессией в ключе.
 *  - Карточка «Да» — шаги с пометками и ПЕРЕЧЕНЬ ПОЛЕЙ со значениями
 *    (§5-бис.5 «для форм изменения данных»).
 *  - Строки таблиц: в снимок — только строка с номером ≥ 3 цифр, который
 *    сотрудник назвал (`rows` в `ui-snap`, фильтр — admin-act.js).
 *  - Мастер проверки (ссылка `?v4c_voicetest=` из кабинета): обмен на
 *    тестовую сессию, регистратор на странице (`vt-arm`), окружение и
 *    разметка (check.js), разбор сервера (команды, запреты), сухой прогон,
 *    прогон с нажатием, отчёт — вердикт считает сервер.
 *
 * Ванильный TS без HTML-приёмников (CSP iframe: Trusted Types 'none').
 */
import { ADMIN_SESSION_HEADER } from '../shared/brand';
import { envelope, parseParentMessage } from '../shared/protocol';
import type { FrameMessage, ParentMessage } from '../shared/protocol';
import type { VoiceControlPublic } from '../shared/config';
import type { CreateVoice, Recording, VoiceEngine } from '../shared/voice-api';
import {
  looksLikeCommand,
  replyKind,
  undoPhrase,
  type UiStep,
} from '../shared/ui-plan';
import {
  MARK_SYMBOL,
  UiPlanController,
  uiPlanOff,
  type UiPlanUi,
} from '../chat/ui-plan';
import type { Dict } from '../chat/i18n';
import { VC_TEXTS, type VcTexts } from './i18n';

export type VcLang = 'uk' | 'ru' | 'en';

/** Конфиг режима для сотрудника (`GET /assist-admin/v1/voice-control`). */
export interface VcConfig {
  mode: 'on' | 'degraded' | null;
  state: string;
  denySelectors: string[];
  allowSelectors: string[];
  maxSteps: number;
  voice: boolean;
  consentVersion: string;
}

export interface VcHost {
  lang(): VcLang;
  pk(): string;
  session(): string | null;
  /** Строка в ленте чата (локально; ход диалога сервер пишет сам). */
  feed(role: 'employee' | 'assistant', text: string): void;
  /** Вопрос в чат сотрудника (Э8: изменение через API — карточка «Да»). */
  ask(text: string): void;
  /** Перечитать состояние чата (карточка предложения мемо). */
  refresh(): void;
  /** Сообщение странице админки (admin.js → admin-act.js). */
  post(raw: Record<string, unknown>): void;
  /** Место для карточек и мастера (над полем ввода). */
  box: HTMLElement;
  form: HTMLFormElement;
  send: HTMLElement;
  /** Ссылка мастера из `init` (одноразовая). */
  vt: string | null;
  cfg: VcConfig | null;
}

export interface VcApi {
  /** Ответ страницы (`ui-*`, `vt-*`). */
  page(raw: Record<string, unknown>): void;
  /** Набранный текст: `true` — забрал голосовое управление. */
  typed(text: string): Promise<boolean>;
  reset(): void;
}

export const ADMIN_VOICE_TEST_HEADER = 'X-Assist-Admin-Voice-Test';
const VT_PATH = '/assist-admin/v1/voice-test';
const LIMITS = { maxRecordMs: 12_000, minSpeechMs: 250, endSilenceMs: 1_200 };
const MEMO_REF = /(?:^|[\s(«"])(?:АМ|AM|АM|AМ)[-‐–\s]?\d{1,4}\b/iu;
const ROW_NUM = /(?:^|[^0-9])([0-9]{3,12})(?![0-9])/g;

interface Vt {
  testId: string;
  testHost: boolean;
  host: string;
  env: Record<string, unknown> | null;
  markup: Record<string, unknown> | null;
  suspicious: Array<Record<string, unknown>>;
  reviewed: Record<string, 'deny' | 'safe'>;
  commands: Array<{ text: string; safe: boolean }>;
  forbidden: { n: number; leak: number } | null;
  dry: Array<{
    planId: string;
    command: string;
    steps: string[];
    ok: number | null;
  }>;
  submits: number;
  mic: string;
  result: { result: 'pass' | 'partial' | 'fail'; attempts: number } | null;
}

const fmt = (s: string, v: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? ''));

const rand = () =>
  (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).slice(
    0,
    24
  );

/** Номера ≥ 3 цифр, названные в команде (строки таблиц для снимка). */
export function rowsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ROW_NUM))
    if (out.length < 5 && out.indexOf(m[1]) < 0) out.push(m[1]);
  return out;
}

/** Текст — для голосового управления, а не вопрос в чат. */
export function vcWants(text: string): boolean {
  return looksLikeCommand(text) || undoPhrase(text) || MEMO_REF.test(text);
}

export function start(h: VcHost): VcApi {
  const t = (): VcTexts => VC_TEXTS[h.lang()] || VC_TEXTS.uk;
  let cfg = h.cfg;
  let ui: UiPlanUi = uiPlanOff();
  let rows: string[] = [];
  let fields: Array<{ label: string; value: string }> = [];
  /** Команда, которую сейчас строит план (для ответов `api`/`memo`). */
  let cmdText = '';
  /** Ответ `api`/`memo` уже обработан здесь (не вопрос в чат по `false`). */
  let handled = false;
  let memoNext: number | null = null;
  let memoRun: string | null = null;
  let pageUrl: string | null = null;
  let vt: Vt | null = null;
  const waits = new Map<string, (d: unknown) => void>();

  const key = (n: string) => `v4c-avc:${h.pk()}:${n}`;
  const store = (n: string, v?: string | null): string | null => {
    try {
      if (v === undefined) return sessionStorage.getItem(key(n));
      if (v === null) sessionStorage.removeItem(key(n));
      else sessionStorage.setItem(key(n), v);
    } catch {
      /* только память */
    }
    return null;
  };

  // ── API «Админки» ──────────────────────────────────────────────────────

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    raw?: Blob
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': raw ? raw.type || 'audio/webm' : 'application/json',
    };
    const s = h.session();
    if (s) headers[ADMIN_SESSION_HEADER] = s;
    if (vt && !vt.result) headers[ADMIN_VOICE_TEST_HEADER] = vt.testId;
    const r = await fetch(path, {
      method,
      headers,
      credentials: 'omit',
      body: raw ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    let j: Record<string, unknown> | null = null;
    try {
      j = (await r.json()) as Record<string, unknown>;
    } catch {
      j = null;
    }
    if (!r.ok) {
      const e = (j && (j.error as Record<string, unknown>)) || j || {};
      const code = typeof e.code === 'string' ? e.code : String(r.status);
      throw { code: code === 'ADMIN_VC_EXPIRED' ? 'PLAN_EXPIRED' : code };
    }
    return j && 'data' in j ? j.data : j;
  }

  /** Ответ плана «Админки» → форма контроллера «Сайта» (+ побочные строки). */
  function adapt(v: unknown): unknown {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const o = v as Record<string, unknown>;
    if (!('kind' in o) && !('steps' in o)) return v;
    const memo = o.memo as Record<string, unknown> | null | undefined;
    if (Array.isArray(o.fields))
      fields = (o.fields as Array<Record<string, unknown>>)
        .slice(0, 20)
        .map((f) => ({
          label: String(f.label ?? '').slice(0, 80),
          value: String(f.value ?? '').slice(0, 200),
        }));
    if (o.apiMissing === true) h.feed('assistant', t().apiMissing);
    if (memo) {
      const text = typeof memo.text === 'string' ? memo.text : null;
      if (o.kind === 'memo') {
        // Мемо без шагов на странице: его текст (отказ, предложение «Да»).
        handled = true;
        h.feed('employee', cmdText);
        if (text) h.feed('assistant', text);
      } else if (text) h.feed('assistant', text);
      if (memo.proposalId) h.refresh();
      if (memo.nextUi === true && typeof memo.number === 'number')
        memoNext = memo.number;
    }
    const out: Record<string, unknown> = {
      ...o,
      memo: memo ? { name: memo.name || '', goal: '' } : null,
    };
    if (o.kind === 'api' && cmdText && !handled) {
      // Изменение с операцией API — не кликами: та же команда в чат, там
      // карточка Э8 «было → станет» с «Да» (Р-Э6б-5). И после согласия.
      handled = true;
      const q = cmdText;
      setTimeout(() => h.ask(q), 0);
    }
    if (o.kind === 'api' || o.kind === 'memo') out.kind = 'not_command';
    return out;
  }

  async function api(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const p = path.replace('/widget/v1/', '/assist-admin/v1/');
    let b = body;
    if (method === 'POST' && p === '/assist-admin/v1/ui-plan') {
      const o = { ...(body as Record<string, unknown>) };
      delete o.conversationId;
      delete o.release;
      if (memoRun) {
        o.memoRunId = memoRun;
        memoRun = null;
      }
      if (vt && !vt.result) o.testId = vt.testId;
      b = o;
    }
    const r = await call(method, p, b);
    if (p === '/assist-admin/v1/ui-plan/active') {
      const a = (r || {}) as { plan?: unknown; memoRunId?: unknown };
      memoRun = typeof a.memoRunId === 'string' ? a.memoRunId : null;
      return { plan: a.plan ? adapt(a.plan) : null };
    }
    return adapt(r);
  }

  // ── контроллер плана «Сайта» с адаптером ───────────────────────────────

  const ctl = new UiPlanController({
    ui: () => ui,
    setUi(p) {
      ui = { ...ui, ...p };
      render();
      if (memoNext !== null && (ui.phase === 'done' || ui.phase === 'idle'))
        void memoContinue();
    },
    t: () => t() as unknown as Dict,
    lang: () => h.lang(),
    cfg: () =>
      cfg && cfg.mode
        ? ({
            denySelectors: cfg.denySelectors,
            allowSelectors: cfg.allowSelectors,
            memos: true,
          } as unknown as VoiceControlPublic)
        : null,
    api,
    toParent(m: FrameMessage) {
      const raw = m as unknown as Record<string, unknown>;
      h.post(raw.type === 'ui-snap' ? { ...raw, rows } : raw);
    },
    conversationId: () => null,
    setConversation: () => undefined,
    feed: (role, text) =>
      h.feed(role === 'visitor' ? 'employee' : 'assistant', text),
    storage(kind, name, value) {
      // Согласие — на сессию сотрудника и редакцию текста (Р-Э6б-12).
      const n =
        kind === 'local'
          ? `${name}:${cfg ? cfg.consentVersion : ''}:${(h.session() || '').slice(-16)}`
          : name;
      return store(n, value);
    },
    pageUrl: () => pageUrl,
    listen,
    random: rand,
  });

  /** Следующий отрезок мемо на странице (после плана или перехода). */
  async function memoContinue() {
    const n = memoNext;
    memoNext = null;
    if (n === null) return;
    if (!memoRun) {
      try {
        await api('GET', '/assist-admin/v1/ui-plan/active');
      } catch {
        return;
      }
    }
    if (memoRun) void ctl.command(`АМ-${n}`, 'typed', null);
  }

  // ── голос ──────────────────────────────────────────────────────────────

  let engine: VoiceEngine | null = null;
  let rec: Recording | null = null;
  let micUsed = false;
  let micBtn: HTMLButtonElement | null = null;

  function setupMic() {
    if (!cfg || !cfg.voice || micBtn) return;
    import(/* @vite-ignore */ `${location.origin}/v1/voice.js`)
      .then((x: { createVoice: CreateVoice }) => {
        const e = x.createVoice();
        if (!e.canRecord()) return;
        engine = e;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wa-mic';
        b.textContent = '🎤';
        b.setAttribute('aria-label', t().mic);
        b.addEventListener('click', () => {
          if (rec) return rec.stop();
          micUsed = true;
          record();
        });
        h.form.insertBefore(b, h.send);
        micBtn = b;
      })
      .catch(() => undefined);
  }

  function record() {
    if (!engine || rec) return;
    if (micBtn) {
      micBtn.className = 'wa-mic on';
      micBtn.setAttribute('aria-label', t().micStop);
    }
    rec = engine.record(
      { ...LIMITS, onSpeech: () => ctl.speech(true) },
      () => undefined,
      (end) => {
        rec = null;
        if (micBtn) {
          micBtn.className = 'wa-mic';
          micBtn.setAttribute('aria-label', t().mic);
        }
        if (end.reason === 'error') {
          if (vt) vt.mic = end.code === 'denied' ? 'denied_user' : 'no_device';
          h.feed('assistant', t().micDenied);
          return;
        }
        if (end.reason !== 'ok' && end.reason !== 'max') {
          ctl.speech(false);
          return;
        }
        void heard(end.blob);
      }
    );
  }

  /** Во время плана, начатого голосом, — слушать «стоп» / «так». */
  function listen(on: boolean) {
    if (on && micUsed && !rec) record();
    else if (!on && rec) {
      rec.cancel();
      rec = null;
    }
  }

  async function heard(blob: Blob) {
    type Heard = { text?: unknown; voiceTicket?: unknown };
    let r: Heard = {};
    try {
      r = ((await call('POST', '/assist-admin/v1/voice', undefined, blob)) ||
        {}) as Heard;
    } catch {
      r = {};
    }
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    const ticket = typeof r.voiceTicket === 'string' ? r.voiceTicket : null;
    if (vt && text) vt.mic = 'ok';
    if (!text) return ctl.speech(false);
    if (ctl.active()) {
      prep(text);
      if (await ctl.planSpeech(text, ticket)) return;
    } else if (vcWants(text) && (await take(text, 'voice', ticket))) return;
    h.ask(text);
  }

  /** Команда пошла в план: номера строк для снимка, текст для `api`/`memo`. */
  function prep(text: string) {
    rows = rowsInText(text);
    cmdText = text;
    handled = false;
  }

  async function take(
    text: string,
    source: 'voice' | 'typed',
    ticket: string | null
  ): Promise<boolean> {
    prep(text);
    const ok = await ctl.command(text, source, ticket);
    return ok || handled;
  }

  // ── карточки ───────────────────────────────────────────────────────────

  function button(text: string, cls: string, on: () => void) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', on);
    return b;
  }

  function div(cls: string, text?: string) {
    const d = document.createElement('div');
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  const planBox = div('wa-vc-p');
  const vtBox = div('wa-vt');
  h.box.append(vtBox, planBox);

  function stepLine(s: { kind: string; text: string; value: string | null }) {
    const d = t().vcStep as Record<string, string>;
    return fmt(d[s.kind] || '{t}', { t: s.text, v: s.value || '' });
  }

  function render() {
    planBox.replaceChildren();
    const T = t();
    const row = div('wa-card-a');
    if (ui.phase === 'consent') {
      planBox.append(div('wa-vc-t', T.consent));
      row.append(
        button(T.consentYes, 'wa-yes', () => ctl.consent(true)),
        button(T.no, 'wa-no', () => ctl.consent(false))
      );
    } else if (ui.phase === 'thinking') {
      planBox.append(div('wa-vc-t', T.thinking));
    } else if (ui.phase === 'confirm') {
      const card = div('wa-card wa-write');
      card.append(div('wa-card-t', ui.pnrCard ? T.pnrCard : T.confirm));
      const ul = document.createElement('ul');
      ul.className = 'wa-card-f';
      for (const s of ui.confirmSteps) {
        const li = document.createElement('li');
        const sym = s.mark ? MARK_SYMBOL[s.mark] : '';
        li.textContent = `${sym ? sym + ' ' : ''}${stepLine(s)}`;
        ul.append(li);
      }
      card.append(ul);
      if (fields.length && !ui.pnrCard) {
        card.append(div('wa-card-m', T.fields));
        const fl = document.createElement('ul');
        fl.className = 'wa-card-f';
        for (const f of fields) {
          const li = document.createElement('li');
          const b = document.createElement('b');
          b.textContent = `${f.label}: `;
          li.append(b, document.createTextNode(f.value));
          fl.append(li);
        }
        card.append(fl);
      }
      row.append(
        button(T.yes, 'wa-yes', () => void ctl.confirm(true)),
        button(T.no, 'wa-no', () => void ctl.confirm(false))
      );
      card.append(row);
      planBox.append(card);
      return;
    } else if (ui.phase === 'running') {
      planBox.append(div('wa-vc-t', T.running));
      row.append(button(T.stop, 'wa-no', () => ctl.stop('button')));
    } else if (ui.phase === 'offer') {
      planBox.append(div('wa-vc-t', T.offer));
      row.append(
        button(T.offerUndo, 'wa-yes', () => void ctl.offerAnswer(true)),
        button(T.offerKeep, 'wa-no', () => void ctl.offerAnswer(false))
      );
    }
    if (row.childNodes.length) planBox.append(row);
  }

  // ── мастер проверки ────────────────────────────────────────────────────

  const saveVt = () => store('vt', vt ? JSON.stringify(vt) : null);

  function ask(type: string, extra: Record<string, unknown> = {}) {
    const rid =
      rand()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 20) || 'r0000000';
    return new Promise<unknown>((resolve) => {
      waits.set(rid, resolve);
      h.post({ type, rid, ...extra });
      setTimeout(() => {
        if (waits.delete(rid)) resolve(null);
      }, 6000);
    });
  }

  async function vtStart() {
    try {
      vt = JSON.parse(store('vt') || 'null') as Vt | null;
    } catch {
      vt = null;
    }
    if (vt && vt.result) vt = null;
    if (h.vt) {
      try {
        const r = (await call('POST', `${VT_PATH}/session`, {
          token: h.vt,
        })) as { testId: string; testHost: boolean; host: string };
        vt = {
          testId: r.testId,
          testHost: r.testHost === true,
          host: String(r.host || ''),
          env: null,
          markup: null,
          suspicious: [],
          reviewed: {},
          commands: [],
          forbidden: null,
          dry: [],
          submits: 0,
          mic: 'skipped',
          result: null,
        };
        saveVt();
      } catch {
        h.feed('assistant', t().vtExpired);
      }
      h.vt = null;
    }
    if (!vt) return;
    h.post({ type: 'vt-arm', work: !vt.testHost });
    try {
      cfg = (await call('GET', '/assist-admin/v1/voice-control')) as VcConfig;
    } catch {
      /* конфиг прежний */
    }
    setupMic();
    vtRender();
  }

  async function vtCheck() {
    if (!vt) return;
    const deny = cfg ? cfg.denySelectors : [];
    const allow = cfg ? cfg.allowSelectors : [];
    const env = ((await ask('vt-env')) || {}) as Record<string, unknown>;
    const fp = (
      document as Document & {
        featurePolicy?: { allowsFeature(f: string): boolean };
      }
    ).featurePolicy;
    env.micPolicy = fp
      ? fp.allowsFeature('microphone')
        ? 'allowed'
        : 'denied'
      : 'unknown';
    const markup = ((await ask('vt-markup', { deny, allow })) || {}) as Record<
      string,
      unknown
    >;
    rows = [];
    const snap = await ctl.snap();
    store('vtsnap', snap ? JSON.stringify(snap) : null);
    let a: Record<string, unknown> = {};
    try {
      a = (await call('POST', `${VT_PATH}/${vt.testId}/analyze`, {
        snapshot: snap,
        lang: h.lang(),
      })) as Record<string, unknown>;
    } catch {
      a = {};
    }
    const forbidden = Array.isArray(a.forbidden)
      ? (a.forbidden as Array<{ blocked?: boolean }>)
      : [];
    vt.env = env;
    vt.markup = markup;
    vt.suspicious = (
      Array.isArray(markup.suspicious) ? markup.suspicious : []
    ) as Array<Record<string, unknown>>;
    vt.commands = (Array.isArray(a.commands) ? a.commands : [])
      .slice(0, 5)
      .map((c: { text?: unknown; safe?: unknown }) => ({
        text: String(c.text || '').slice(0, 120),
        safe: c.safe === true,
      }))
      .filter((c) => c.text);
    vt.forbidden = {
      n: forbidden.length,
      leak: forbidden.filter((f) => !f.blocked).length,
    };
    saveVt();
    vtRender();
  }

  async function vtDry(command: string) {
    if (!vt || vt.dry.length >= 5) return;
    rows = rowsInText(command);
    const v = (await ctl.dry(command)) as {
      planId: string | null;
      steps: UiStep[];
    } | null;
    if (!v || !v.planId || !vt) return;
    vt.dry.push({
      planId: v.planId,
      command,
      steps: v.steps
        .filter((s) => s.target)
        .map((s) => (s.target ? s.target.text : '')),
      ok: null,
    });
    saveVt();
    vtRender();
  }

  async function vtReport() {
    if (!vt) return;
    let snap: unknown = null;
    try {
      snap = JSON.parse(store('vtsnap') || 'null');
    } catch {
      snap = null;
    }
    try {
      const r = (await call('POST', `${VT_PATH}/${vt.testId}/report`, {
        lang: h.lang(),
        snapshot: snap,
        env: vt.env || {},
        mic: vt.mic,
        markup: vt.markup || {},
        suspicious: vt.suspicious,
        reviewed: vt.reviewed,
        submitsBlocked: vt.submits,
        dry: vt.dry.map((d) => ({ planId: d.planId, ok: d.ok ?? 0 })),
      })) as {
        result: 'pass' | 'partial' | 'fail';
        report?: { attempts?: number };
      };
      vt.result = {
        result: r.result,
        attempts: (r.report && r.report.attempts) || 0,
      };
    } catch {
      h.feed('assistant', t().vtExpired);
      return;
    }
    store('vtsnap', null);
    store('vt', null);
    vtRender();
  }

  function vtRender() {
    vtBox.replaceChildren();
    if (!vt) return;
    const T = t();
    const v = vt;
    vtBox.append(
      div('wa-card-t', T.vtTitle),
      div('wa-vc-t', v.testHost ? T.vtTest : T.vtWork)
    );
    if (v.result) {
      vtBox.append(
        div('wa-vc-t', T.vtResult[v.result.result]),
        div('wa-vc-t', fmt(T.vtAttempts, { n: v.result.attempts }))
      );
      return;
    }
    const row = (...b: HTMLElement[]) => {
      const r = div('wa-card-a');
      r.append(...b);
      vtBox.append(r);
    };
    row(button(T.vtCheck, 'wa-edit', () => void vtCheck()));
    if (v.env)
      vtBox.append(
        div(
          'wa-vc-t',
          fmt(T.vtEnv, {
            csp: Number(v.env.csp) || 0,
            tt: Number(v.env.tt) || 0,
            chunks: v.env.chunks === true ? '✓' : '✗',
          })
        )
      );
    if (v.markup)
      vtBox.append(
        div(
          'wa-vc-t',
          fmt(T.vtMarkup, {
            total: Number(v.markup.total) || 0,
            withId: Number(v.markup.withId) || 0,
          })
        )
      );
    if (v.forbidden)
      vtBox.append(div('wa-vc-t', fmt(T.vtForbidden, v.forbidden)));
    if (v.suspicious.length) vtBox.append(div('wa-vc-t', T.vtSuspicious));
    for (const s of v.suspicious.slice(0, 10)) {
      const k = String(s.key || '');
      const mark = (x: 'deny' | 'safe') => () => {
        v.reviewed[k] = x;
        saveVt();
        vtRender();
      };
      const got = v.reviewed[k];
      row(
        div(
          'wa-vc-t',
          `${String(s.label || s.selector || k)}${got ? ' — ' + (got === 'deny' ? T.vtDeny : T.vtSafe) : ''}`
        ),
        button(T.vtDeny, 'wa-no', mark('deny')),
        button(T.vtSafe, 'wa-edit', mark('safe'))
      );
    }
    for (const c of v.commands) {
      const d = v.dry.find((x) => x.command === c.text);
      const btns: HTMLElement[] = [div('wa-vc-t', c.text)];
      if (!d) btns.push(button(T.vtDry, 'wa-edit', () => void vtDry(c.text)));
      else if (d.ok === null)
        btns.push(
          div('wa-vc-t', d.steps.join(' → ')),
          button(T.vtDryOk, 'wa-yes', () => {
            d.ok = d.steps.length;
            saveVt();
            vtRender();
          }),
          button(T.vtDryBad, 'wa-no', () => {
            d.ok = 0;
            saveVt();
            vtRender();
          })
        );
      if (c.safe)
        btns.push(
          button(T.vtSafeRun, 'wa-yes', () => void take(c.text, 'typed', null))
        );
      row(...btns);
    }
    row(button(T.vtReport, 'wa-yes', () => void vtReport()));
  }

  // ── вход ───────────────────────────────────────────────────────────────

  setupMic();
  const ready = (async () => {
    await vtStart();
    // Продолжение после перехода: план этой вкладки или отрезок мемо.
    if (store('plan') || cfg) {
      const snap = store('plan') ? await ctl.snap() : null;
      if (snap && typeof snap === 'object')
        pageUrl = String((snap as { url?: unknown }).url || '') || null;
      await ctl.resume();
      // Отрезок мемо на этой странице ждёт (переход был шагом мемо).
      if (memoRun && ui.phase === 'idle') void ctl.command('АМ', 'typed', null);
    }
  })();

  return {
    page(raw) {
      const type = raw.type;
      if (type === 'ui-attempt' || type === 'vt-submit') {
        if (!vt || vt.result) return;
        const submit = type === 'vt-submit';
        if (submit) {
          vt.submits++;
          saveVt();
        }
        void call('POST', `${VT_PATH}/${vt.testId}/attempt`, {
          kind: submit ? 'submit' : 'never',
          n: 1,
          text: typeof raw.text === 'string' ? raw.text.slice(0, 80) : null,
        }).catch(() => undefined);
        return;
      }
      const m = parseParentMessage(
        envelope(raw as unknown as { type: string })
      ) as ParentMessage | null;
      if (!m) return;
      if (m.type === 'vt-result') {
        const w = waits.get(m.rid);
        if (w) {
          waits.delete(m.rid);
          w(m.data);
        }
        return;
      }
      if (
        m.type === 'ui-snapshot' ||
        m.type === 'ui-step' ||
        m.type === 'ui-stopped' ||
        m.type === 'ui-need' ||
        m.type === 'ui-undone'
      )
        ctl.onParent(m);
    },
    async typed(text) {
      await ready;
      if (!cfg || !cfg.mode) return false;
      // Набор во время плана: «так/ні/стоп» — ответ карточке или стоп
      // (жест в этом iframe, как кнопка); другое — новая команда.
      const r = replyKind(text);
      if (ui.phase === 'confirm' && (r === 'yes' || r === 'no')) {
        await ctl.confirm(r === 'yes');
        return true;
      }
      if (ui.phase === 'offer' && (r === 'yes' || r === 'no')) {
        await ctl.offerAnswer(r === 'yes');
        return true;
      }
      if (ctl.active() && (r === 'stop' || r === 'no')) {
        ctl.stop('button');
        return true;
      }
      return vcWants(text) ? take(text, 'typed', null) : false;
    },
    reset() {
      if (ctl.active()) ctl.stop('close');
      listen(false);
      vt = null;
      vtRender();
      ui = uiPlanOff();
      render();
    },
  };
}
