/**
 * Логика iframe-чата без UI (ТЗ §4-бис, §4.12, §6.2–§6.3): сессия и
 * указатель посетителя, состояние с сервера, SSE-стрим + JSON-запасной
 * путь, продолжение стрима после перезагрузки, идемпотентный
 * `clientRequestId`, вкладки (BroadcastChannel — только указатели), лид,
 * оценка, «удалить мой диалог».
 *
 * Хранение (§4-бис.2–3, контракт §3): ВСЁ — в хранилище НАШЕГО origin
 * (iframe), ключи `<prefix>:<pk>:<origin родителя>:<имя>`:
 *   localStorage   resume  — указатель (32 байта), 30 дней на сервере;
 *   sessionStorage token   — visitor-token (+ срок), draft — черновик,
 *                  scroll  — id последнего видимого сообщения,
 *                  pending — неотвеченный вопрос (повтор с тем же clientRequestId),
 *                  preview / pview — сессия предпросмотра и черновой вид.
 * В хранилище страницы заказчика iframe не пишет ничего (другой origin).
 *
 * Э3 (W): передача человеку (подтверждение «~N минут» → `POST handoff`,
 * опрос `state` раз в 3 с, пока передача waiting/active и вкладка видима;
 * `missed` → форма заявки; отмена ожидания; событие стрима `handoff`),
 * сценарии (шаги, типы ответов, финал), проактивный сигнал (префилл без
 * автоотправки, сценарий, `openedBy`), цели из загрузчика с диалогом и
 * временем клика по действию помощника, `identify` — ТОЛЬКО в памяти и
 * только в лид/передачу, склейка стрима (при несовпадении префикса —
 * текст целиком из `state`). Ответы сценария и identify не пишутся ни в
 * одно хранилище.
 */
import {
  ApiError,
  headers,
  parseChatEvent,
  parseChatJson,
  parseChunk,
  parseHandoffResponse,
  parsePreviewExchange,
  parseSession,
  parseVideoLink,
  parseState,
  request,
  streamCodeOfRest,
  unwrap,
  type Auth,
  type SiteAction,
  type StreamErrorCode,
  type VisitorHandoffView,
  type WidgetChatEvent,
  type WidgetMessageView,
  type WidgetStateView,
} from './api';
import { parseScenarios, type Scenario } from '../shared/scenarios';
import { SseParser } from './sse';
import { DICTS, type Dict } from './i18n';
import { WIDGET_CHANNEL_PREFIX, WIDGET_STORAGE_PREFIX } from '../shared/brand';
import {
  applyPreviewPatch,
  defaultPublicConfig,
  isObj,
  mergeView,
  defaultViewConfig,
  parsePublicConfig,
  type LeadField,
  type PublicConfig,
  type UiLang,
  type ViewConfig,
} from '../shared/config';
import type { FrameMessage, ParentMessage } from '../shared/protocol';
import { VoiceController, voiceOff, type VoiceUi } from './voice';
import { UiPlanController, uiPlanOff, type UiPlanUi } from './ui-plan';
import {
  vtOff,
  type VoiceTestController,
  type VtHost,
  type VtMicPolicy,
  type VtMicStatus,
  type VtUi,
} from './voice-test';
import type { VtDict } from './i18n-vt';
import { CHAT_RELEASE, CHUNK_BASE } from './api';
import type { VoiceControlPublic } from '../shared/config';
import { looksLikeCommand } from '../shared/ui-plan';

export interface UiMessage extends WidgetMessageView {
  /** Вопрос этой вкладки, ещё не перечитанный с сервера (сырой текст — только в памяти). */
  local?: boolean;
  /** Э5: вопрос задан голосом (пометка «голосом» у пузыря). */
  byVoice?: boolean;
  rated?: boolean;
}

export interface Notice {
  text: string;
  retry?: boolean;
}

export interface ChatState {
  phase: 'boot' | 'ready' | 'unavailable';
  cfg: PublicConfig;
  view: ViewConfig;
  lang: UiLang;
  t: Dict;
  dark: boolean;
  inline: boolean;
  siteFont: string | null;
  messages: UiMessage[];
  busy: boolean;
  notice: Notice | null;
  lead: 'hidden' | 'form' | 'sent';
  resumedBanner: boolean;
  confirmForget: boolean;
  prefill: { name?: string; email?: string; comment?: string };
  allowedOrigins: string[];
  draft: string;
  /** Э3: последняя передача человеку диалога. */
  handoff: VisitorHandoffView | null;
  /** Э3: «Позвать человека? Обычно отвечаем за ~N минут» — ждёт подтверждения. */
  handoffAsk: { scenarioKey: string | null } | null;
  /** «~N минут» (ответ POST handoff или конфиг). */
  eta: string | null;
  scenarios: Scenario[];
  /** Идущий сценарий: шаг и ответы (только в памяти). */
  scen: {
    s: Scenario;
    step: number;
    answers: Array<{ q: string; a: string }>;
    done: boolean;
  } | null;
  /** Э5: голос — кнопки, запись, озвучка (src/chat/voice.ts). */
  voice: VoiceUi;
  /** Э6: открытый ролик обучалки (подписанная ссылка своего origin). */
  video: { url: string; title: string } | null;
  /** Э6-бис: голосовое управление — фаза плана, карточка подтверждения. */
  plan: UiPlanUi;
  /** Э6-бис (г): мастер проверки голосового управления (только владельцу по ссылке). */
  vt: VtUi;
  /** Тексты мастера — из ленивого чанка vt.js (null — не загружен). */
  vtT: VtDict | null;
  /**
   * Э3-бис: вариант B эксперимента (только группа b посетителя с согласием)
   * — приветствие и подсказки по языкам; null — как в опубликованном виде.
   */
  expGreeting: Partial<Record<UiLang, string>> | null;
  expSuggestions: Partial<Record<UiLang, string[]>> | null;
}

/** Ответ проактивного сигнала/сценария, отмеченный для атрибуции цели. */
interface AssistMarks {
  proactive: string | null;
  scenario: string | null;
  link: boolean;
}

type Identity = {
  name?: string;
  email?: string;
  externalId?: string;
  userHash?: string;
};

interface Pending {
  crid: string;
  q: string;
  conv: string | null;
  mid?: string;
  /** Э5: билет распознавания — повтор после перезагрузки тоже «голосом». */
  vt?: string | null;
}

type Init = Extract<ParentMessage, { type: 'init' }>;

const DIALOG_IDLE_MS = 30 * 60 * 1000;
/** Опрос ответа оператора (HANDOFF_DEFAULTS.widgetPollMs, решение 3). */
export const HANDOFF_POLL_MS = 3000;

export function uuid(): string {
  const c = window.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => (x + 256).toString(16).slice(1)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function store(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export class ChatController {
  state: ChatState;
  /** Э5: голос (запись, озвучка) — кнопки зовут его методы напрямую. */
  readonly voice: VoiceController;
  readonly plans: UiPlanController;
  /** Э6-бис (г): мастер проверки Т-2 — из ленивого чанка vt.js (у посетителей null). */
  vt: VoiceTestController | null = null;
  /** Режим тестовой сессии мастера (план iframe — как при `on`). */
  private vtCfg: VoiceControlPublic | null = null;
  /** Э6-бис: «голосовое управление не включено» — одно уведомление на вкладку. */
  private vcOffShown = false;
  private subs: Array<() => void> = [];
  private auth: Auth = { token: null, preview: null };
  private pk: string;
  private parentOrigin: string;
  private toParent: (m: FrameMessage) => void;
  private conversationId: string | null = null;
  private stateVersion = -1;
  private page: { url: string | null; title: string | null } = {
    url: null,
    title: null,
  };
  private context: Record<string, string | number> | null = null;
  private channel: BroadcastChannel | null = null;
  private following = new Set<string>();
  private loops = new Set<string>();
  private booted = false;
  private pollTimer = 0;
  // ── Э3 ──
  private handoffTimer = 0;
  private identity: Identity = {};
  /** Кто открыл НОВЫЙ диалог: proactive:<ключ> | scenario:<ключ> (иначе user). */
  private openedBy: string | null = null;
  private marks: AssistMarks = { proactive: null, scenario: null, link: false };
  /** Последний клик посетителя по действию помощника (ссылка, кнопка сценария). */
  private lastClick: number | null = null;
  private missedSeen: string | null = null;
  /** Цели, пришедшие до сессии (см. sendGoal). */
  private goalQ: Array<Extract<ParentMessage, { type: 'goal' }>> = [];
  /** Э3-бис: ключ визита посетителя с согласием (только память iframe). */
  private visit: string | null = null;
  private linked = '';

  /**
   * Э3-бис (§5-тер.9): связанный режим — диалог этого посетителя ↔ визит
   * (сервер пишет только хеш, и только при связанном режиме сайта): цель на
   * другой странице получит «с участием». Раз на пару диалог+визит.
   */
  private linkVisit() {
    const c = this.conversationId;
    const v = this.visit;
    if (!c || !v || !this.auth.token || this.linked === c + v) return;
    this.linked = c + v;
    fetch('/widget/v1/visit', {
      method: 'POST',
      credentials: 'omit',
      headers: headers(this.auth, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ conversationId: c, v }),
    }).catch(() => {
      this.linked = '';
    });
  }

  constructor(
    pk: string,
    parentOrigin: string,
    toParent: ChatController['toParent']
  ) {
    this.pk = pk;
    this.parentOrigin = parentOrigin;
    this.toParent = toParent;
    const lang: UiLang = 'uk';
    this.state = {
      phase: 'boot',
      cfg: defaultPublicConfig(),
      view: defaultViewConfig(),
      lang,
      t: DICTS[lang],
      dark: false,
      inline: false,
      siteFont: null,
      messages: [],
      busy: false,
      notice: null,
      lead: 'hidden',
      resumedBanner: false,
      confirmForget: false,
      prefill: {},
      allowedOrigins: [parentOrigin],
      draft: this.ss('draft') || '',
      handoff: null,
      handoffAsk: null,
      eta: null,
      scenarios: [],
      scen: null,
      voice: voiceOff(),
      video: null,
      plan: uiPlanOff(),
      vt: vtOff(),
      vtT: null,
      expGreeting: null,
      expSuggestions: null,
    };
    this.voice = new VoiceController({
      ui: () => this.state.voice,
      setUi: (p) => this.set({ voice: { ...this.state.voice, ...p } }),
      t: () => this.state.t,
      notify: (text) => this.set({ notice: { text } }),
      auth: () => this.auth,
      refreshSession: async () => {
        await this.session(true);
      },
      // Идёт ответ — распознанное не теряется: в поле ввода (как V4CAssist('ask')).
      // Э6-бис: команда-действие голосом — план, а не вопрос.
      ask: (text, ticket) => void this.voiceText(text, ticket),
      speech: (on) => this.plans.speech(on),
      planText: (text, ticket) => void this.plans.planSpeech(text, ticket),
      storage: (kind, name, value) =>
        kind === 'local' ? this.ls(name, value) : this.ss(name, value),
      broadcast: (msg) => this.signal(msg),
    });
    this.plans = new UiPlanController({
      ui: () => this.state.plan,
      setUi: (p) => {
        this.set({ plan: { ...this.state.plan, ...p } });
        // Э6-бис (г): итог безопасной команды мастера.
        const ph = p.phase;
        if (ph === 'done' || ph === 'failed' || ph === 'stopped')
          this.vt?.planDone(ph);
      },
      t: () => this.state.t,
      lang: () => this.state.lang,
      // (г) Тестовая сессия мастера — режим в любом состоянии сайта.
      cfg: () =>
        this.vtCfg ??
        (this.state.cfg.status === 'active'
          ? this.state.cfg.voiceControl
          : null),
      release: () => CHAT_RELEASE,
      api: (method, path, body) => this.api(method, path, body),
      toParent: (m) => this.toParent(m),
      conversationId: () => this.conversationId,
      setConversation: (id) => {
        this.conversationId = id;
      },
      feed: (role, text, byVoice) => this.feedLocal(role, text, byVoice),
      storage: (kind, name, value) =>
        kind === 'local' ? this.ls(name, value) : this.ss(name, value),
      pageUrl: () => this.page.url,
      listen: (on) => this.voice.planListen(on),
      random: () => uuid().replace(/-/g, '').slice(0, 16),
    });
    document.addEventListener('visibilitychange', () => {
      // Ушли со вкладки — открытый микрофон гаснет без отправки (§5-бис.7).
      if (document.visibilityState === 'hidden') this.voice.hidden();
      // Вернулся на вкладку во время передачи — сразу свежий ответ оператора.
      if (document.visibilityState === 'visible' && this.handoffTimer)
        void this.pollHandoff();
    });
  }

  /**
   * Э6-бис (г): мастер проверки — ленивый чанк vt.js (контроллер и тексты);
   * грузится только по ссылке мастера или для незавершённого мастера вкладки.
   */
  private async vtLoad(): Promise<VoiceTestController | null> {
    if (this.vt) return this.vt;
    const host: VtHost = {
      ui: () => this.state.vt,
      setUi: (p) => this.set({ vt: { ...this.state.vt, ...p } }),
      t: () => this.state.vtT as VtDict,
      lang: () => this.state.lang,
      api: (method, path, body) => this.api(method, path, body),
      toParent: (m) => this.toParent(m),
      storage: (name, value) => this.ss(name, value),
      setSession: (s) => {
        this.auth.vtest = s;
      },
      setVoiceControl: (cfg) => {
        this.vtCfg = cfg;
      },
      random: () => uuid().replace(/-/g, '').slice(0, 16),
      now: () => Date.now(),
      micPolicy: () => micPolicy(),
      micProbe: () => micProbe(),
      listen: () => {
        if (this.state.voice.mic) this.voice.press();
      },
      plans: {
        snap: () => this.plans.snap(),
        dry: (text) => this.plans.dry(text),
        command: (text) => this.plans.command(text, 'typed', null),
      },
    };
    try {
      const m = (await import(/* @vite-ignore */ `${CHUNK_BASE}vt.js`)) as {
        VoiceTestController: new (h: VtHost) => VoiceTestController;
        VT_DICTS: Record<UiLang, VtDict>;
      };
      this.vt = new m.VoiceTestController(host);
      this.set({ vtT: m.VT_DICTS[this.state.lang] });
      this.vtDicts = m.VT_DICTS;
      return this.vt;
    } catch {
      return null;
    }
  }

  private vtDicts: Record<UiLang, VtDict> | null = null;

  // ── подписка UI ─────────────────────────────────────────────────────────

  subscribe(fn: () => void): () => void {
    this.subs.push(fn);
    return () => {
      this.subs = this.subs.filter((x) => x !== fn);
    };
  }

  private set(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.subs) fn();
  }

  // ── хранилище iframe ────────────────────────────────────────────────────

  key(name: string): string {
    return `${WIDGET_STORAGE_PREFIX}:${this.pk}:${this.parentOrigin}:${name}`;
  }

  private ss(name: string, value?: string | null): string | null {
    const s = store('session');
    if (!s) return null;
    try {
      if (value === undefined) return s.getItem(this.key(name));
      if (value === null) s.removeItem(this.key(name));
      else s.setItem(this.key(name), value);
    } catch {
      /* квота/запрет — не критично */
    }
    return null;
  }

  private ls(name: string, value?: string | null): string | null {
    const s = store('local');
    if (!s) return null;
    try {
      if (value === undefined) return s.getItem(this.key(name));
      if (value === null) s.removeItem(this.key(name));
      else s.setItem(this.key(name), value);
    } catch {
      /* стороннее хранилище запрещено — останется CHIPS-cookie */
    }
    return null;
  }

  private pending(): Pending | null {
    try {
      const p = JSON.parse(this.ss('pending') || 'null');
      return isObj(p) && typeof p.crid === 'string' && typeof p.q === 'string'
        ? (p as unknown as Pending)
        : null;
    } catch {
      return null;
    }
  }

  // ── сообщения родителя ──────────────────────────────────────────────────

  onParent(m: ParentMessage) {
    switch (m.type) {
      case 'init':
        return this.onInit(m);
      case 'ask':
        // До готовности сессии — отложить (V4CAssist('ask') сразу после загрузки).
        if (this.state.phase === 'boot') this.queuedAsk = m.question;
        else if (this.state.phase !== 'ready') return;
        else if (this.state.busy) this.setDraft(m.question);
        else void this.ask(m.question);
        return;
      case 'context':
        this.context = m.data;
        return;
      case 'close':
        // Окно закрыли — микрофон и озвучка гаснут сразу.
        this.voice.cancel();
        return;
      case 'route':
        this.page = { url: m.page.url, title: m.page.title };
        return;
      case 'identify':
        // Э3: в памяти iframe; на сервер — только с лидом или передачей (К-3).
        this.identity = {
          name: m.name,
          email: m.email,
          externalId: m.externalId,
          userHash: m.userHash,
        };
        this.set({
          prefill: { ...this.state.prefill, name: m.name, email: m.email },
        });
        return;
      case 'proactive':
        return this.onProactive(m);
      case 'goal':
        void this.sendGoal(m);
        return;
      case 'ana':
        // Э3-бис: согласие посетителя (ключ визита) и вариант эксперимента.
        this.visit = m.visit;
        this.set({ expGreeting: m.greeting, expSuggestions: m.suggestions });
        this.linkVisit();
        return;
      case 'highlight-result':
        void this.highlightResult(m.elementId, m.found);
        return;
      case 'ui-snapshot':
      case 'ui-step':
      case 'ui-stopped':
      case 'ui-need':
      case 'ui-undone':
        // Э6-бис: снимок/итоги шагов — только своему плану (rid, planId).
        return this.plans.onParent(m);
      case 'vt-result':
        // Э6-бис (г): ответ чанка проверки — только ожидаемому запросу (rid).
        return this.vt?.onResult(m.rid, m.data);
      case 'preview':
        // «к Л2»: второй замок — флаг из конфига сервера здесь же.
        if (this.state.cfg.allowClientPreview)
          this.set({
            view: applyPreviewPatch(this.state.view, m.partialConfig),
          });
        return;
      default:
        return;
    }
  }

  private onInit(m: Init) {
    // init — только от НАШЕГО загрузчика этой страницы: pk и origin совпадают.
    if (m.pk !== this.pk || m.parentOrigin !== this.parentOrigin) return;
    this.page = { url: m.page.url, title: m.page.title };
    const lang = m.uiLang || 'uk';
    this.set({
      lang,
      t: DICTS[lang],
      vtT: this.vtDicts ? this.vtDicts[lang] : null,
      inline: m.mode === 'inline',
      siteFont: m.siteFont,
      dark: this.isDark(this.state.view, m.siteTheme),
    });
    this.siteTheme = m.siteTheme;
    if (this.booted) return;
    this.booted = true;
    void this.boot(m.previewToken, m.voiceTest);
  }

  private siteTheme: 'light' | 'dark' | null = null;
  private queuedAsk: string | null = null;

  private isDark(view: ViewConfig, site: 'light' | 'dark' | null): boolean {
    const th = view.brand.theme;
    if (th === 'dark') return true;
    if (th === 'light') return false;
    if (th === 'site') return site === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  private applyView(view: ViewConfig) {
    this.set({ view, dark: this.isDark(view, this.siteTheme) });
  }

  // ── старт: конфиг, предпросмотр, сессия, состояние ─────────────────────

  private async boot(previewToken: string | null, voiceTest: string | null) {
    try {
      const raw = await request(
        'GET',
        `/widget/v1/config?pk=${encodeURIComponent(this.pk)}`,
        this.auth
      );
      const cfg = parsePublicConfig(raw);
      const origins = [this.parentOrigin, ...cfg.hosts.map((h) => h.origin)];
      this.set({
        cfg,
        allowedOrigins: origins,
        scenarios: parseScenarios(isObj(raw) ? raw.engagement : null),
      });
      this.applyView(cfg.config);
    } catch {
      /* без конфига — вид по умолчанию */
    }
    try {
      await this.preview(previewToken);
      const s = await this.session(false);
      for (const g of this.goalQ.splice(0)) void this.sendGoal(g);
      if (this.state.cfg.status === 'lead_only')
        this.set({ lead: 'form', notice: { text: this.state.t.errDisabled } });
      this.set({ phase: 'ready' });
      // Э5: голос — только при активном чате (lead_only — без голоса).
      this.voice.configure(
        this.state.cfg.status === 'active' ? this.state.cfg.voice : null
      );
      await this.loadState(s ? s.resumed : false);
      this.openChannel();
      // Э6-бис (г): ссылка мастера проверки — тестовая сессия; иначе —
      // продолжить мастер этой вкладки после перехода страницы.
      if (voiceTest || this.ss('vtsess')) {
        const vt = await this.vtLoad();
        if (vt && voiceTest) await vt.start(voiceTest);
        else if (vt) vt.resume();
      }
      // Э6-бис: голосовой план этой вкладки — продолжить на новой странице.
      void this.plans.resume();
    } catch (e) {
      this.fail(e);
    }
  }

  private async preview(token: string | null) {
    if (token) {
      // Одноразовый обмен: токен из адреса уже убран загрузчиком (§3-бис.4).
      const r = parsePreviewExchange(
        await request('POST', '/widget/v1/preview/exchange', this.auth, {
          pk: this.pk,
          token,
          parentOrigin: this.parentOrigin,
        })
      );
      this.ss('preview', r.previewSession);
      this.ss('pview', JSON.stringify(r.config));
      this.ss('token', null);
    }
    const ps = this.ss('preview');
    if (ps) {
      this.auth.preview = ps;
      try {
        this.applyView(
          mergeView(defaultViewConfig(), JSON.parse(this.ss('pview') || 'null'))
        );
      } catch {
        /* черновой вид не прочитался — опубликованный */
      }
    }
  }

  private async session(force: boolean) {
    if (!force) {
      try {
        const saved = JSON.parse(this.ss('token') || 'null');
        if (
          isObj(saved) &&
          typeof saved.t === 'string' &&
          typeof saved.e === 'number' &&
          saved.e > Date.now() + 5000
        ) {
          this.auth.token = saved.t;
          return null;
        }
      } catch {
        /* нет сохранённой сессии */
      }
    }
    this.auth.token = null;
    const s = parseSession(
      await request('POST', '/widget/v1/session', this.auth, {
        pk: this.pk,
        parentOrigin: this.parentOrigin,
        resumeKey: this.ls('resume'),
        previewSession: this.auth.preview,
      })
    );
    this.auth.token = s.visitorToken;
    const exp = Date.parse(s.expiresAt);
    this.ss(
      'token',
      JSON.stringify({
        t: s.visitorToken,
        e: isNaN(exp) ? Date.now() + 3600e3 : exp,
      })
    );
    if (s.resumeKey) this.ls('resume', s.resumeKey);
    return s;
  }

  /** Вызов API с одним повтором после пересоздания истёкшей сессии. */
  private async api(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<unknown> {
    try {
      return await request(method, path, this.auth, body);
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.code === 'SESSION_EXPIRED' || e.code === 'SESSION_REQUIRED')
      ) {
        await this.session(true);
        return request(method, path, this.auth, body);
      }
      throw e;
    }
  }

  private fail(e: unknown) {
    const code = e instanceof ApiError ? e.code : 'NETWORK';
    if (
      code === 'ORIGIN_DENIED' ||
      code === 'WIDGET_UNKNOWN_KEY' ||
      code === 'PREVIEW_INVALID'
    ) {
      this.set({ phase: 'unavailable' });
      this.toParent({ type: 'unavailable', code });
      return;
    }
    if (
      code === 'WIDGET_DISABLED' ||
      code === 'SITE_QUOTA' ||
      code === 'PLATFORM_BUDGET'
    ) {
      this.set({
        phase: 'ready',
        lead: 'form',
        notice: {
          text:
            code === 'SITE_QUOTA'
              ? this.state.t.errQuota
              : code === 'PLATFORM_BUDGET'
                ? this.state.t.errPlatform
                : this.state.t.errDisabled,
        },
      });
      return;
    }
    this.set({
      phase: this.state.phase === 'boot' ? 'ready' : this.state.phase,
      notice: { text: this.state.t.errGeneric },
    });
  }

  private async loadState(resumed: boolean) {
    const st = parseState(await this.api('GET', '/widget/v1/state'));
    this.applyState(st);
    const c = st.conversation;
    if (resumed && c) {
      const last = Date.parse(c.lastMessageAt);
      if (!isNaN(last) && Date.now() - last > DIALOG_IDLE_MS)
        this.set({ resumedBanner: true });
    }
    let p = this.pending();
    // Перезагрузка до `meta` первого вопроса: в pending нет диалога, а сервер
    // ищет повтор clientRequestId только В ДИАЛОГЕ (§4-бис.4) — повторяем в
    // текущий диалог посетителя, иначе второй вызов модели и второй диалог.
    if (p && !p.conv && c) p = { ...p, conv: c.id };
    if (c && c.streamingMessageId) void this.follow(c.streamingMessageId);
    else if (p) void this.send(p, true);
    else if (this.queuedAsk) void this.ask(this.queuedAsk);
    this.queuedAsk = null;
  }

  private applyState(st: WidgetStateView) {
    const c = st.conversation;
    if (!c) {
      this.conversationId = null;
      this.stateVersion = -1;
      this.setHandoff(null);
      if (!this.state.busy) this.set({ messages: [] });
      return;
    }
    this.conversationId = c.id;
    this.linkVisit();
    this.stateVersion = c.stateVersion;
    this.setHandoff(c.handoff);
    if (this.state.busy) return; // свой стрим допишет сам
    const keep = this.state.messages.filter((m) => this.following.has(m.id));
    const merged: UiMessage[] = c.messages.map((m) => {
      const k = keep.find((x) => x.id === m.id);
      const old = this.state.messages.find((x) => x.id === m.id);
      // Склейка стрима (решение 23): своё дочитанное длиннее — только если
      // текст базы его НАЧАЛО; иначе (маска телефона на стыке сброса)
      // правда — текст из state целиком.
      const base: UiMessage =
        k && k.text.length > m.text.length && k.text.indexOf(m.text) === 0
          ? { ...m, text: k.text }
          : m;
      return old && old.rated ? { ...base, rated: true } : base;
    });
    this.set({ messages: merged });
  }

  async refreshState() {
    if (this.state.phase !== 'ready') return;
    try {
      const st = parseState(await this.api('GET', '/widget/v1/state'));
      this.applyState(st);
      const sid = st.conversation && st.conversation.streamingMessageId;
      if (sid && !this.loops.has(sid) && !this.state.busy)
        void this.follow(sid);
    } catch (e) {
      this.fail(e);
    }
  }

  // ── вкладки (§4-бис.7): только указатели, по ним — перечитать с сервера ─

  private openChannel() {
    if (typeof BroadcastChannel !== 'function') {
      this.poll();
      return;
    }
    this.channel = new BroadcastChannel(
      `${WIDGET_CHANNEL_PREFIX}:${this.pk}:${this.parentOrigin}`
    );
    this.channel.onmessage = (e) => {
      const d = e.data;
      if (typeof d !== 'string' || d.length > 100) return;
      if (d === 'reset') void this.resetLocal(false);
      else if (d.indexOf('voice-on:') === 0) this.voice.onChannel(d);
      else if (/^(message|state):[A-Za-z0-9_-]{1,64}$/.test(d))
        void this.refreshState();
    };
  }

  private poll() {
    // Без BroadcastChannel — опрос раз в 10 с, пока вкладка видима.
    clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      if (
        document.visibilityState !== 'visible' ||
        this.state.busy ||
        this.state.phase !== 'ready'
      )
        return;
      try {
        const st = parseState(
          await this.api('GET', `/widget/v1/state?since=${this.stateVersion}`)
        );
        if (
          st.conversation &&
          st.conversation.stateVersion !== this.stateVersion
        )
          await this.refreshState();
      } catch {
        /* следующий тик */
      }
    }, 10000);
  }

  private signal(s: string) {
    try {
      this.channel?.postMessage(s);
    } catch {
      /* канал закрыт */
    }
  }

  // ── вопрос, стрим, продолжение ─────────────────────────────────────────

  setDraft(text: string) {
    this.ss('draft', text || null);
    this.set({ draft: text });
  }

  async ask(question: string, voiceTicket: string | null = null) {
    const q = question.trim().slice(0, 600);
    if (!q || this.state.busy || this.state.phase !== 'ready') return;
    const p: Pending = { crid: uuid(), q, conv: this.conversationId };
    if (voiceTicket) p.vt = voiceTicket;
    this.ss('pending', JSON.stringify(p));
    const now = new Date().toISOString();
    this.set({
      messages: [
        ...this.state.messages,
        {
          id: 'local-' + p.crid,
          role: 'visitor',
          text: q,
          sources: [],
          actions: [],
          streamState: 'complete',
          rating: null,
          createdAt: now,
          local: true,
          ...(voiceTicket ? { byVoice: true } : {}),
        },
      ],
      notice: null,
      resumedBanner: false,
    });
    this.setDraft('');
    await this.send(p, false);
  }

  /**
   * Набор в поле ввода iframe (жест посетителя внутри iframe). Э6-бис:
   * команда-действие — план (§5-бис.6 п.1: «набранная команда» — только
   * отсюда; `V4CAssist('ask')` идёт мимо — в `ask`).
   */
  async submit(text: string) {
    const q = text.trim().slice(0, 600);
    if (!q || this.state.busy || this.state.phase !== 'ready') return;
    if (await this.tryCommand(q, 'typed', null)) {
      this.setDraft('');
      return;
    }
    await this.ask(q);
  }

  /** Распознанная речь (Э5): план, ответ на карточку или обычный вопрос. */
  private async voiceText(text: string, ticket: string | null) {
    // Э6-бис (г): «перевірка зв'язку» в мастере — не вопрос и не команда.
    if (this.vt?.heard(text)) return;
    if (this.plans.active()) {
      if (await this.plans.planSpeech(text, ticket)) return;
    }
    if (await this.tryCommand(text, 'voice', ticket)) return;
    if (this.state.busy) this.setDraft(text);
    else await this.ask(text, ticket);
  }

  private async tryCommand(
    text: string,
    source: 'voice' | 'typed',
    ticket: string | null
  ): Promise<boolean> {
    // (д)+(е): «отмени последнее», «що ти вмієш», фразы мемо — тоже в план.
    if (!looksLikeCommand(text) && !this.plans.wants(text)) return false;
    if (!this.plans.available()) {
      // §5-бис.10 п.6: режим выключен — сказать и ответить текстом, ничего не нажимая.
      if (!this.vcOffShown && this.state.cfg.voice) {
        this.vcOffShown = true;
        this.feedLocal('assistant', this.state.t.vcOff);
      }
      return false;
    }
    return this.plans.command(text, source, ticket);
  }

  /** Строка плана в ленте — только локально (сервер хранит план, не реплики). */
  private feedLocal(
    role: 'visitor' | 'assistant',
    text: string,
    byVoice = false
  ) {
    const id = 'local-vc-' + uuid();
    this.set({
      messages: [
        ...this.state.messages,
        {
          id,
          role,
          text,
          sources: [],
          actions: [],
          streamState: 'complete',
          rating: null,
          createdAt: new Date().toISOString(),
          local: true,
          ...(byVoice ? { byVoice: true } : {}),
        },
      ],
    });
  }

  /** Esc в iframe во время плана — стоп плана, а не закрытие окна. */
  stopPlanIfRunning(): boolean {
    if (!this.plans.active()) return false;
    this.plans.stop('esc');
    return true;
  }

  /** Повтор после «ответ прервался»: новый вопрос с тем же текстом. */
  retry() {
    const last = [...this.state.messages]
      .reverse()
      .find((m) => m.role === 'visitor');
    if (last) void this.ask(last.text);
  }

  private upsert(id: string, patch: Partial<UiMessage>, create = false) {
    const list = this.state.messages;
    const i = list.findIndex((m) => m.id === id);
    if (i < 0) {
      if (!create) return;
      this.set({
        messages: [
          ...list,
          {
            id,
            role: 'assistant',
            text: '',
            sources: [],
            actions: [],
            streamState: 'streaming',
            rating: null,
            createdAt: new Date().toISOString(),
            ...patch,
          },
        ],
      });
      return;
    }
    const next = list.slice();
    next[i] = { ...next[i], ...patch };
    this.set({ messages: next });
  }

  /** true — сообщение уже было в ленте (повтор clientRequestId): первый токен заменит текст. */
  private rename(from: string, to: string): boolean {
    const list = this.state.messages;
    if (list.some((m) => m.id === to)) {
      this.set({ messages: list.filter((m) => m.id !== from) });
      return true;
    }
    this.set({
      messages: list.map((m) => (m.id === from ? { ...m, id: to } : m)),
    });
    return false;
  }

  private async send(p: Pending, resend: boolean) {
    this.set({ busy: true });
    let mid = 'p-' + p.crid;
    this.upsert(mid, {}, true);
    let gotDone = false;
    let replaceText = false;
    let relayed = false;
    let streamed = false;
    let lastError: StreamErrorCode | null = null;
    const body = {
      conversationId: p.conv,
      clientRequestId: p.crid,
      question: p.q,
      page: this.page,
      context: this.context,
      uiLang: this.state.lang,
      // Э3: кто открыл диалог — только для нового (сервер пишет при создании).
      openedBy: p.conv ? null : this.openedBy || 'user',
      // Э5: вопрос голосом — билет распознавания (вес диалога решает сервер).
      voiceTicket: p.vt || null,
    };
    const handle = (ev: WidgetChatEvent) => {
      switch (ev.type) {
        case 'meta':
          this.conversationId = ev.conversationId;
          this.linkVisit();
          replaceText = this.rename(mid, ev.messageId);
          mid = ev.messageId;
          this.following.add(mid);
          this.ss(
            'pending',
            JSON.stringify({ ...p, conv: ev.conversationId, mid })
          );
          this.signal('message:' + mid);
          break;
        case 'token': {
          const m = this.state.messages.find((x) => x.id === mid);
          this.upsert(mid, {
            text: (m && !replaceText ? m.text : '') + ev.t,
            streamState: 'streaming',
          });
          replaceText = false;
          break;
        }
        case 'sources':
          this.upsert(mid, { sources: ev.items });
          break;
        case 'actions':
          this.upsert(mid, { actions: ev.items });
          break;
        case 'done':
          gotDone = true;
          this.upsert(mid, { streamState: 'complete' });
          break;
        case 'error':
          lastError = ev.code;
          break;
        case 'handoff':
          // Вопрос ушёл человеку: ответа модели не будет — заглушка «пишет…»
          // не нужна, ответ оператора придёт опросом state.
          relayed = true;
          gotDone = true;
          this.set({
            messages: this.state.messages.filter((x) => x.id !== mid),
          });
          break;
      }
    };
    try {
      const streamOk =
        typeof ReadableStream === 'function' &&
        typeof TextDecoder === 'function';
      const exec = () =>
        fetch('/widget/v1/chat', {
          method: 'POST',
          credentials: 'include',
          headers: headers(this.auth, {
            'Content-Type': 'application/json',
            Accept: streamOk ? 'text/event-stream' : 'application/json',
          }),
          body: JSON.stringify(body),
        });
      let res = await exec();
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        try {
          unwrap(res.status, err);
        } catch (e) {
          if (
            e instanceof ApiError &&
            (e.code === 'SESSION_EXPIRED' || e.code === 'SESSION_REQUIRED')
          ) {
            await this.session(true);
            res = await exec();
            if (!res.ok) unwrap(res.status, await res.json().catch(() => null));
          } else throw e;
        }
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.indexOf('application/json') >= 0 || !res.body) {
        const j = parseChatJson(unwrap(res.status, await res.json()));
        if (j.handoff) {
          this.conversationId = j.conversationId;
          handle({ type: 'handoff', ...j.handoff });
          this.set({ busy: false });
          this.ss('pending', null);
          void this.refreshState();
          return;
        }
        handle({
          type: 'meta',
          conversationId: j.conversationId,
          messageId: j.messageId,
          replay: false,
        });
        this.upsert(mid, {
          text: j.text,
          sources: j.sources,
          actions: j.actions,
          streamState: j.streaming
            ? 'streaming'
            : j.refused
              ? 'refused'
              : 'complete',
        });
        gotDone = !j.streaming;
      } else {
        streamed = true;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const sse = new SseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const e of sse.push(dec.decode(value, { stream: true }))) {
            let data: unknown = null;
            try {
              data = JSON.parse(e.data);
            } catch {
              continue;
            }
            const ev = parseChatEvent(e.event, data);
            if (ev) handle(ev);
          }
        }
      }
    } catch (e) {
      // Обрыв соединения после meta — ответ дописывается на сервере: дочитаем.
      if (!(e instanceof ApiError) && mid.indexOf('p-') !== 0) {
        this.set({ busy: false });
        void this.follow(mid);
        return;
      }
      this.set({
        busy: false,
        messages: this.state.messages.filter((m) => m.id !== mid || m.text),
      });
      this.ss('pending', null);
      if (e instanceof ApiError) this.restError(e.code);
      else if (!resend)
        this.set({ notice: { text: this.state.t.errGeneric, retry: true } });
      return;
    }
    this.set({ busy: false });
    if (lastError) {
      this.ss('pending', null);
      this.following.delete(mid);
      this.streamError(lastError, mid);
      return;
    }
    if (!gotDone && mid.indexOf('p-') !== 0) {
      void this.follow(mid);
      return;
    }
    this.ss('pending', null);
    this.openedBy = null;
    if (relayed) {
      void this.refreshState();
      return;
    }
    if (mid.indexOf('p-') === 0) {
      // Поток закрылся без meta (функция/прокси оборвали до начала ответа):
      // дочитывать нечего, а заглушка «печатает…» висела бы вечно.
      this.set({
        messages: this.state.messages.filter((m) => m.id !== mid),
        notice: { text: this.state.t.errGeneric, retry: true },
      });
      return;
    }
    this.following.delete(mid);
    this.signal('message:' + mid);
    // Сверка с базой (склейка стрима, решение 23): дописанное ПОТОКОМ могло
    // быть маскировано на стыке сброса — правда в state (JSON-путь уже из базы).
    if (streamed) void this.refreshState();
  }

  private streamError(code: StreamErrorCode, mid: string) {
    const t = this.state.t;
    const m = this.state.messages.find((x) => x.id === mid);
    if (m && !m.text)
      this.set({ messages: this.state.messages.filter((x) => x.id !== mid) });
    else if (m) this.upsert(mid, { streamState: 'partial' });
    switch (code) {
      case 'disabled':
        return this.set({ lead: 'form', notice: { text: t.errDisabled } });
      case 'site_quota':
        return this.set({ lead: 'form', notice: { text: t.errQuota } });
      case 'platform_budget':
        return this.set({ lead: 'form', notice: { text: t.errPlatform } });
      case 'rate_limited':
        return this.set({ notice: { text: t.errRate } });
      case 'origin_denied':
        this.set({ phase: 'unavailable' });
        return this.toParent({ type: 'unavailable', code: 'ORIGIN_DENIED' });
      case 'bad_request':
        return this.set({ notice: { text: t.errGeneric } });
      default:
        return this.set({ notice: { text: t.retry, retry: true } });
    }
  }

  private restError(code: string) {
    const t = this.state.t;
    const stream = streamCodeOfRest(code);
    if (stream) return this.streamError(stream, '');
    this.set({
      notice: {
        text: code === 'QUESTION_TOO_LONG' ? t.errTooLong : t.errGeneric,
      },
    });
  }

  /** Продолжение стрима после перезагрузки/обрыва (§4-бис.4): опрос/длинный опрос БД. */
  async follow(mid: string) {
    if (this.loops.has(mid)) return;
    this.loops.add(mid);
    this.following.add(mid);
    const cur = this.state.messages.find((m) => m.id === mid);
    if (!cur) this.upsert(mid, {}, true);
    let off = cur ? cur.text.length : 0;
    try {
      for (let n = 0; n < 200; n++) {
        const c = parseChunk(
          await this.api(
            'GET',
            `/widget/v1/messages/${encodeURIComponent(mid)}/stream?from=${off}`
          )
        );
        const m = this.state.messages.find((x) => x.id === mid);
        const base = m ? m.text.slice(0, off) : '';
        const patch: Partial<UiMessage> = {
          text: base + c.text,
          streamState: c.streamState,
        };
        if (c.sources.length) patch.sources = c.sources;
        if (c.actions.length) patch.actions = c.actions;
        this.upsert(mid, patch);
        off = Math.max(c.offset, off + c.text.length);
        if (c.streamState !== 'streaming') break;
        if (!c.text) await sleep(1000);
      }
    } catch (e) {
      this.fail(e);
    }
    this.following.delete(mid);
    this.loops.delete(mid);
    const p = this.pending();
    if (p && p.mid === mid) this.ss('pending', null);
    this.signal('message:' + mid);
  }

  // ── оценка, лид, «позвать человека», забыть ────────────────────────────

  async feedback(messageId: string, rating: 1 | -1) {
    this.upsert(messageId, { rating, rated: true });
    try {
      await this.api('POST', '/widget/v1/feedback', { messageId, rating });
    } catch {
      /* оценка — не критично */
    }
  }

  openLead() {
    this.set({ lead: 'form' });
  }

  // ── Э3: передача человеку (§3.7) ───────────────────────────────────────

  private etaText(minutes: number | null): string | null {
    const h = this.state.cfg.handoff;
    const t = h && h.etaText[this.state.lang];
    if (minutes) return this.state.t.etaMinutes.replace('{n}', String(minutes));
    if (t) return t;
    const n = h && h.etaMinutes;
    return n ? this.state.t.etaMinutes.replace('{n}', String(n)) : null;
  }

  /** «Позвать человека?» — подтверждение с «~N минут» (§3.7 п.1). */
  askHandoff(scenarioKey: string | null = null) {
    this.set({ handoffAsk: { scenarioKey }, eta: this.etaText(null) });
  }

  cancelAskHandoff() {
    this.set({ handoffAsk: null });
  }

  async handoff() {
    const ask = this.state.handoffAsk;
    this.set({ handoffAsk: null });
    const id = this.identityBody();
    try {
      const r = parseHandoffResponse(
        await this.api('POST', '/widget/v1/handoff', {
          conversationId: this.conversationId,
          uiLang: this.state.lang,
          pageUrl: this.page.url,
          scenarioKey: ask ? ask.scenarioKey : null,
          ...(id ? { identity: id } : {}),
        })
      );
      if (r.mode === 'lead') {
        this.set({
          lead: 'form',
          notice: { text: this.state.t.handoffLead },
        });
      } else {
        this.set({ eta: this.etaText(r.etaMinutes) });
        this.setHandoff(r.handoff);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RATE_LIMITED')
        this.set({ notice: { text: this.state.t.errRate } });
      else this.set({ lead: 'form' });
    }
    this.toParent({ type: 'event', name: 'handoff' });
  }

  /** Посетитель передумал ждать (только waiting — дальше решает сервер). */
  async cancelHandoff() {
    const c = this.conversationId;
    if (!c) return;
    try {
      await this.api('POST', '/widget/v1/handoff/cancel', {
        conversationId: c,
      });
    } catch {
      /* состояние подтянет опрос */
    }
    await this.refreshState();
  }

  /** Новое состояние передачи: опрос, форма заявки при missed, сигнал загрузчику. */
  private setHandoff(h: VisitorHandoffView | null) {
    const prev = this.state.handoff;
    if (
      prev === h ||
      (prev &&
        h &&
        prev.id === h.id &&
        prev.state === h.state &&
        prev.takenAt === h.takenAt)
    )
      return;
    this.set({ handoff: h });
    const open = !!h && (h.state === 'waiting' || h.state === 'active');
    clearInterval(this.handoffTimer);
    this.handoffTimer = 0;
    if (open) {
      // Опрос state раз в 3 с, пока передача открыта и вкладка видима (решение 3).
      this.handoffTimer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void this.pollHandoff();
      }, HANDOFF_POLL_MS);
    }
    if (h && h.state === 'missed' && this.missedSeen !== h.id) {
      this.missedSeen = h.id;
      this.set({ lead: 'form', notice: { text: this.state.t.handoffMissed } });
    }
    if (h && (!prev || prev.state !== h.state))
      this.toParent({ type: 'handoff-state', state: h.state });
  }

  private async pollHandoff() {
    if (this.state.phase !== 'ready' || this.state.busy) return;
    try {
      const st = parseState(
        await this.api('GET', `/widget/v1/state?since=${this.stateVersion}`)
      );
      const c = st.conversation;
      if (c && c.stateVersion !== this.stateVersion) await this.refreshState();
      else if (c) this.setHandoff(c.handoff);
    } catch {
      /* следующий тик */
    }
  }

  // ── Э3: identify, проактивный сигнал, сценарии, цели ───────────────────

  /** identify — только то, что дала страница; на сервер — лишь с лидом/передачей. */
  private identityBody(): Identity | null {
    const i = this.identity;
    return i.name || i.email || i.externalId ? i : null;
  }

  private onProactive(m: Extract<ParentMessage, { type: 'proactive' }>) {
    this.marks.proactive = m.triggerKey;
    // Новый диалог — «открыт сигналом»; идущий диалог не переподписываем.
    if (!this.conversationId) this.openedBy = 'proactive:' + m.triggerKey;
    if (m.action === 'prefill' && m.question) {
      // Префилл без автоотправки (§5-тер.12): посетитель отправит сам.
      this.setDraft(m.question);
    } else if (m.action === 'scenario' && m.scenarioKey) {
      this.startScenario(m.scenarioKey, true);
    }
  }

  startScenario(key: string, fromProactive = false) {
    const s = this.state.scenarios.find((x) => x.key === key);
    if (!s || this.state.phase !== 'ready') return;
    this.marks.scenario = key;
    this.lastClick = Date.now();
    if (!fromProactive && !this.conversationId)
      this.openedBy = 'scenario:' + key;
    this.toParent({ type: 'count', kind: 'scenario_started', key });
    this.set({ scen: { s, step: 0, answers: [], done: false } });
    if (!s.steps.length) this.finishScenario();
  }

  /** Ответ на шаг сценария (только в памяти iframe). */
  answerStep(value: string) {
    const sc = this.state.scen;
    if (!sc || sc.done) return;
    const step = sc.s.steps[sc.step];
    const q =
      step.question[this.state.lang] || Object.values(step.question)[0] || '';
    const answers = value ? [...sc.answers, { q, a: value }] : sc.answers;
    this.lastClick = Date.now();
    if (sc.step + 1 < sc.s.steps.length)
      this.set({ scen: { ...sc, step: sc.step + 1, answers } });
    else {
      this.set({ scen: { ...sc, answers } });
      this.finishScenario();
    }
  }

  cancelScenario() {
    this.set({ scen: null });
  }

  private finishScenario() {
    const sc = this.state.scen;
    if (!sc) return;
    this.set({ scen: { ...sc, done: true } });
    this.toParent({ type: 'count', kind: 'scenario_done', key: sc.s.key });
    const summary = sc.answers.map((x) => `${x.q} — ${x.a}`).join('; ');
    const f = sc.s.final;
    if (f.kind === 'lead') {
      // Вопросы квалификации (№40) — в комментарий заявки, посетитель видит его.
      this.set({
        lead: 'form',
        prefill: { ...this.state.prefill, comment: summary.slice(0, 1000) },
      });
    } else if (f.kind === 'handoff') this.askHandoff(sc.s.key);
    else if (f.kind === 'ask') {
      const title = sc.s.title[this.state.lang] || '';
      const q = [title, summary].filter(Boolean).join(': ').slice(0, 600);
      if (q) void this.ask(q);
      this.set({ scen: null });
    }
  }

  /** Клик по действию помощника (ссылка ответа/сценария) — для атрибуции и счётчика. */
  linkClicked() {
    this.lastClick = Date.now();
    this.marks.link = true;
    this.toParent({ type: 'count', kind: 'link_click', key: null });
  }

  /**
   * Цель, пойманная загрузчиком этого документа (решение 12): с посетителем,
   * диалогом и временем последнего клика по действию помощника — атрибуцию
   * direct/assisted решает сервер (A). keepalive — страница может уходить.
   */
  private async sendGoal(m: Extract<ParentMessage, { type: 'goal' }>) {
    if (!this.auth.token) {
      // iframe прислал ready раньше, чем получил сессию: загрузчик уже отдал
      // цель сюда (не маяком) — держим до сессии, иначе она теряется.
      if (this.state.phase === 'boot' && this.goalQ.length < 10)
        this.goalQ.push(m);
      return;
    }
    const body = JSON.stringify({
      goalKey: m.goalKey,
      detector: m.detector,
      docId: m.docId,
      path: m.path,
      orderId: m.orderId,
      value: m.value,
      currency: m.currency,
      conversationId: this.conversationId,
      lastAssistClickAt: this.lastClick
        ? new Date(this.lastClick).toISOString()
        : null,
      assist: this.marks,
      // Э3-бис: только с согласием посетителя (связанный режим).
      ...(this.visit ? { visit: this.visit } : {}),
    });
    const go = () =>
      fetch('/widget/v1/goal', {
        method: 'POST',
        keepalive: true,
        credentials: 'omit',
        headers: headers(this.auth, { 'Content-Type': 'application/json' }),
        body,
      });
    try {
      const r = await go();
      if (r.status === 401) {
        await this.session(true);
        await go();
      }
    } catch {
      /* цель — не критично для посетителя */
    }
  }

  async submitLead(
    fields: Partial<Record<LeadField, string>>,
    consent: boolean
  ): Promise<string | null> {
    const t = this.state.t;
    if (!consent) return t.consentRequired;
    const id = this.identityBody();
    try {
      await this.api('POST', '/widget/v1/lead', {
        conversationId: this.conversationId,
        fields,
        consent: true,
        uiLang: this.state.lang,
        pageUrl: this.page.url,
        ...(id ? { identity: id } : {}),
      });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      return code === 'CONSENT_REQUIRED'
        ? t.consentRequired
        : code === 'LEAD_INVALID'
          ? t.leadInvalid
          : t.errGeneric;
    }
    this.set({ lead: 'sent', scen: null });
    // Наружу — только тип события, без полей (§3-бис.2).
    this.toParent({ type: 'event', name: 'lead' });
    return null;
  }

  askForget(on: boolean) {
    this.set({ confirmForget: on });
  }

  async forget() {
    this.set({ confirmForget: false });
    try {
      await this.api('POST', '/widget/v1/forget', {});
    } catch {
      this.set({ notice: { text: this.state.t.errGeneric } });
      return;
    }
    this.signal('reset');
    await this.resetLocal(true);
  }

  private async resetLocal(own: boolean) {
    for (const k of ['token', 'pending', 'draft', 'scroll']) this.ss(k, null);
    this.ls('resume', null);
    this.conversationId = null;
    this.stateVersion = -1;
    this.auth.token = null;
    this.set({
      messages: [],
      draft: '',
      lead: this.state.cfg.status === 'lead_only' ? 'form' : 'hidden',
      resumedBanner: false,
      notice: own ? { text: this.state.t.forgotten } : null,
      scen: null,
      handoffAsk: null,
    });
    this.setHandoff(null);
    this.identity = {};
    this.lastClick = null;
    this.marks = { proactive: null, scenario: null, link: false };
    try {
      await this.session(true);
    } catch (e) {
      this.fail(e);
    }
  }

  newQuestion() {
    this.conversationId = null;
    this.set({ messages: [], resumedBanner: false });
  }

  dismissResume() {
    this.set({ resumedBanner: false });
  }

  actionClicked(a: SiteAction) {
    this.lastClick = Date.now();
    if (a.kind === 'lead') this.openLead();
    else if (a.kind === 'handoff') this.askHandoff();
    else if (a.kind === 'video') void this.openVideo(a.videoId);
    else if (a.kind === 'highlight') {
      // Э6: подсветку делает загрузчик (DOM страницы iframe недоступен);
      // ждём итог только по элементу, который сами попросили показать.
      this.highlightAsked.set(a.elementId, this.page.url);
      this.toParent({
        type: 'highlight',
        elementId: a.elementId,
        selector: a.selector,
        caption: a.caption,
      });
    }
  }

  // ── Э6: видео и «показать на экране» ──────────────────────────────────

  /** Элементы, которые посетитель попросил показать: id → страница. */
  private readonly highlightAsked = new Map<string, string | null>();

  /** Ролик: подписанная ссылка по клику (третий барьер — на сервере). */
  private async openVideo(videoId: string) {
    try {
      const v = parseVideoLink(
        await this.api('POST', '/widget/v1/video', { videoId })
      );
      this.set({ video: { url: v.url, title: v.title } });
    } catch {
      this.set({ notice: { text: this.state.t.videoUnavailable } });
    }
  }

  closeVideo() {
    this.set({ video: null });
  }

  /**
   * Итог подсветки от загрузчика. Не нашёл — ТИХО (посетителю ничего не
   * показываем) шлём сигнал «карта устарела»; ответ «сообщение подделано
   * страницей» не опасен — только по элементу, который мы сами просили.
   */
  private async highlightResult(elementId: string, found: boolean) {
    if (!this.highlightAsked.has(elementId)) return;
    const pageUrl = this.highlightAsked.get(elementId) ?? null;
    this.highlightAsked.delete(elementId);
    if (found || !pageUrl) return;
    try {
      await this.api('POST', '/widget/v1/highlight-miss', {
        elementId,
        pageUrl,
      });
    } catch {
      /* сигнал не дошёл — не беда посетителю */
    }
  }

  saveScroll(id: string | null) {
    this.ss('scroll', id);
  }

  savedScroll(): string | null {
    return this.ss('scroll');
  }
}

/**
 * Э6-бис (г): политика микрофона ДЛЯ ЭТОГО iframe — `featurePolicy` внутри
 * iframe видит и Permissions-Policy сайта, и атрибут `allow` загрузчика
 * (Chromium; в спецификации — `permissionsPolicy`; иначе — «неизвестно»,
 * решит запрос микрофона).
 */
function micPolicy(): VtMicPolicy {
  const d = document as Document & {
    featurePolicy?: { allowsFeature(f: string): boolean };
    permissionsPolicy?: { allowsFeature(f: string): boolean };
  };
  const p = d.permissionsPolicy || d.featurePolicy;
  if (!p || typeof p.allowsFeature !== 'function') return 'unknown';
  try {
    return p.allowsFeature('microphone') ? 'allowed' : 'denied';
  } catch {
    return 'unknown';
  }
}

/** Э6-бис (г): запрос микрофона мастера — диагноз без записи. */
async function micProbe(): Promise<VtMicStatus> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (!md || typeof md.getUserMedia !== 'function')
    return /iP(hone|ad|od)/.test(navigator.userAgent)
      ? 'ios_gesture'
      : 'no_device';
  try {
    const stream = await md.getUserMedia({ audio: true });
    stream.getTracks().forEach((tr) => tr.stop());
    return 'ok';
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'NotFoundError' || name === 'OverconstrainedError')
      return 'no_device';
    if (name === 'SecurityError') return 'denied_policy';
    if (name === 'NotAllowedError')
      return micPolicy() === 'denied' ? 'denied_policy' : 'denied_user';
    return 'no_device';
  }
}
