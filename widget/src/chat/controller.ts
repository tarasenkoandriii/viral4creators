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
 */
import {
  ApiError,
  headers,
  parseChatEvent,
  parseChatJson,
  parseChunk,
  parsePreviewExchange,
  parseSession,
  parseState,
  request,
  streamCodeOfRest,
  unwrap,
  type Auth,
  type SiteAction,
  type StreamErrorCode,
  type WidgetChatEvent,
  type WidgetMessageView,
  type WidgetStateView,
} from './api';
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
import type { ParentMessage } from '../shared/protocol';

export interface UiMessage extends WidgetMessageView {
  /** Вопрос этой вкладки, ещё не перечитанный с сервера (сырой текст — только в памяти). */
  local?: boolean;
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
  prefill: { name?: string; email?: string };
  allowedOrigins: string[];
  draft: string;
}

interface Pending {
  crid: string;
  q: string;
  conv: string | null;
  mid?: string;
}

type Init = Extract<ParentMessage, { type: 'init' }>;

const DIALOG_IDLE_MS = 30 * 60 * 1000;

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
  private subs: Array<() => void> = [];
  private auth: Auth = { token: null, preview: null };
  private pk: string;
  private parentOrigin: string;
  private toParent: (
    m:
      | { type: 'event'; name: 'lead' | 'handoff' }
      | { type: 'unavailable'; code: string }
  ) => void;
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
    };
  }

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
      case 'route':
        this.page = { url: m.page.url, title: m.page.title };
        return;
      case 'identify':
        // Э2: только предзаполнение формы лида, в памяти iframe (userHash — Э3).
        this.set({ prefill: { name: m.name, email: m.email } });
        return;
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
      inline: m.mode === 'inline',
      siteFont: m.siteFont,
      dark: this.isDark(this.state.view, m.siteTheme),
    });
    this.siteTheme = m.siteTheme;
    if (this.booted) return;
    this.booted = true;
    void this.boot(m.previewToken);
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

  private async boot(previewToken: string | null) {
    try {
      const cfg = parsePublicConfig(
        await request(
          'GET',
          `/widget/v1/config?pk=${encodeURIComponent(this.pk)}`,
          this.auth
        )
      );
      const origins = [this.parentOrigin, ...cfg.hosts.map((h) => h.origin)];
      this.set({ cfg, allowedOrigins: origins });
      this.applyView(cfg.config);
    } catch {
      /* без конфига — вид по умолчанию */
    }
    try {
      await this.preview(previewToken);
      const s = await this.session(false);
      if (this.state.cfg.status === 'lead_only')
        this.set({ lead: 'form', notice: { text: this.state.t.errDisabled } });
      this.set({ phase: 'ready' });
      await this.loadState(s ? s.resumed : false);
      this.openChannel();
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
      if (!this.state.busy) this.set({ messages: [] });
      return;
    }
    this.conversationId = c.id;
    this.stateVersion = c.stateVersion;
    if (this.state.busy) return; // свой стрим допишет сам
    const keep = this.state.messages.filter((m) => this.following.has(m.id));
    const merged: UiMessage[] = c.messages.map((m) => {
      const k = keep.find((x) => x.id === m.id);
      const old = this.state.messages.find((x) => x.id === m.id);
      const base: UiMessage =
        k && k.text.length > m.text.length ? { ...m, text: k.text } : m;
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

  async ask(question: string) {
    const q = question.trim().slice(0, 600);
    if (!q || this.state.busy || this.state.phase !== 'ready') return;
    const p: Pending = { crid: uuid(), q, conv: this.conversationId };
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
        },
      ],
      notice: null,
      resumedBanner: false,
    });
    this.setDraft('');
    await this.send(p, false);
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
    let lastError: StreamErrorCode | null = null;
    const body = {
      conversationId: p.conv,
      clientRequestId: p.crid,
      question: p.q,
      page: this.page,
      context: this.context,
      uiLang: this.state.lang,
    };
    const handle = (ev: WidgetChatEvent) => {
      switch (ev.type) {
        case 'meta':
          this.conversationId = ev.conversationId;
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

  async handoff() {
    try {
      const r = await this.api('POST', '/widget/v1/handoff', {});
      if (isObj(r) && r.mode === 'lead') this.set({ lead: 'form' });
    } catch {
      this.set({ lead: 'form' });
    }
    this.toParent({ type: 'event', name: 'handoff' });
  }

  async submitLead(
    fields: Partial<Record<LeadField, string>>,
    consent: boolean
  ): Promise<string | null> {
    const t = this.state.t;
    if (!consent) return t.consentRequired;
    try {
      await this.api('POST', '/widget/v1/lead', {
        conversationId: this.conversationId,
        fields,
        consent: true,
        uiLang: this.state.lang,
        pageUrl: this.page.url,
      });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      return code === 'CONSENT_REQUIRED'
        ? t.consentRequired
        : code === 'LEAD_INVALID'
          ? t.leadInvalid
          : t.errGeneric;
    }
    this.set({ lead: 'sent' });
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
    });
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
    if (a.kind === 'lead') this.openLead();
    else if (a.kind === 'handoff') void this.handoff();
  }

  saveScroll(id: string | null) {
    this.ss('scroll', id);
  }

  savedScroll(): string | null {
    return this.ss('scroll');
  }
}
