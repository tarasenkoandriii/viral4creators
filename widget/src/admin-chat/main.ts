/**
 * Чат сотрудника в iframe на ОТДЕЛЬНОМ origin `wa.` (Э7, ТЗ §4.12, §4-бис.8,
 * У-13, У-18) — `/v1/admin-chat.js`. Ванильный TS без HTML-приёмников
 * (CSP iframe: `require-trusted-types-for 'script'; trusted-types 'none'`).
 *
 * Сессия сотрудника — только в памяти и `sessionStorage` этого origin
 * (публичный чат живёт на `w.` — XSS там сюда не дотянется). Указатель
 * привязан к паре (pk, `sub` из JWT):
 *  - новый JWT с другим `sub` → очистка sessionStorage и `reset` по
 *    BroadcastChannel во все вкладки `wa.` этого сайта;
 *  - вкладка, получившая `reset`, очищает окно и восстанавливается только
 *    по JWT, выданному ПОЗЖЕ сброса (`iat`), иначе — «оновіть сторінку»;
 *  - за 90 с до `exp` просит у родителя свежий JWT (SPA-админка: эндпоинт
 *    заказчика или `V4CAssist('identify-admin', jwt)`); без него — «сесія
 *    закінчилась», история на сервере ждёт до 8 ч.
 * Ответ модели — враждебный текст: только textContent, без ссылок и
 * картинок (§4.3-бис «Админка → внешний мир»).
 *
 * Э8: карточка подтверждения действия (§5.4 п.5): «было → станет», пометка
 * «без вашей просьбы», для danger — слово подтверждения; «Да» — отдельный
 * POST `/proposals/:id/confirm` с хешем параметров, которые видел
 * сотрудник; итог и восстановление после перезагрузки — из `state`
 * (§4-бис.5: повторного исполнения нет — решает сервер).
 */
import './admin-chat.css';
import { ADMIN_CHANNEL_PREFIX, ADMIN_SESSION_HEADER } from '../shared/brand';
import {
  adminEnvelope,
  jwtClaims,
  parseAdminParentMessage,
} from '../shared/admin-protocol';
import { T, type AdminLang } from './i18n';

interface Msg {
  id: string;
  role: 'employee' | 'assistant';
  text: string;
  answerPath: string | null;
  rating: number | null;
  /** Э8: карточка подтверждения при этом сообщении. */
  proposalId?: string | null;
}

/** Э8: строка карточки «было → станет». */
interface Field {
  name: string;
  before?: string | string[] | null;
  after: string | string[];
}

/** Э8: предложение действия (сервер — источник правды, §4-бис.5). */
interface Proposal {
  id: string;
  status: string;
  kind: string;
  title: string;
  fields: Field[];
  paramsHash: string;
  unrequested: boolean;
  confirmPhrase: string | null;
  idempotent: boolean;
  undoDeclared: boolean;
  undoAvailable: boolean;
  checkAvailable: boolean;
  dryRun: string;
  dryRunStatus: string | null;
  dryRunNote: string | null;
  amount: number | null;
  errorText: string | null;
  compensationOf: string | null;
  memo: { step: number } | null;
}

const S = {
  pk: '' as string,
  parentOrigin: '' as string,
  lang: 'uk' as AdminLang,
  session: null as string | null,
  sub: null as string | null,
  exp: 0,
  /** Момент сброса другой вкладкой: JWT старше — не принимается. */
  resetAt: 0,
  busy: false,
  refreshTimer: 0 as number,
  messages: [] as Msg[],
  banner: false,
  /** Э8: карточки по id (восстанавливаются из `state` после перезагрузки). */
  proposals: new Map<string, Proposal>(),
  acting: false,
};

let channel: BroadcastChannel | null = null;
const storageKey = () => `${ADMIN_CHANNEL_PREFIX}:s:${S.pk}`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ── разметка (один раз) ────────────────────────────────────────────────
const app = document.getElementById('app') || document.body;
const shell = el('div', 'wa');
const head = el('div', 'wa-h');
const title = el('div', 'wa-t');
const close = el('button', 'wa-x', '×');
close.type = 'button';
head.append(title, close);
const note = el('div', 'wa-n');
note.setAttribute('role', 'status');
const banner = el('div', 'wa-b');
const list = el('div', 'wa-l');
list.setAttribute('aria-live', 'polite');
const form = el('form', 'wa-f');
const input = el('textarea', 'wa-i');
input.rows = 2;
input.maxLength = 2000;
const sendBtn = el('button', 'wa-s');
sendBtn.type = 'submit';
form.append(input, sendBtn);
shell.append(head, banner, note, list, form);
app.appendChild(shell);

function t() {
  return T[S.lang];
}

function setNote(text: string) {
  note.textContent = text;
  note.style.display = text ? '' : 'none';
}

function renderStatic() {
  title.textContent = t().title;
  close.setAttribute('aria-label', t().close);
  input.placeholder = t().placeholder;
  sendBtn.textContent = t().send;
  banner.textContent = t().banner;
  banner.style.display = S.banner ? '' : 'none';
}

// ── Э8: карточка подтверждения (порт автомата voice-confirm: propose →
// confirm | cancel; «Да» — отдельный запрос, ничего молча) ───────────────
const CARD_DONE = new Set(['done', 'failed', 'unknown', 'rejected', 'expired']);

function btn(text: string, cls: string, on: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.disabled = S.acting;
  b.addEventListener('click', on);
  return b;
}

function shown(v: string | string[] | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return Array.isArray(v) ? v.join(', ') : v;
}

function card(p: Proposal): HTMLElement {
  const c = el('div', `wa-card wa-${p.kind === 'danger' ? 'danger' : 'write'}`);
  c.dataset.status = p.status;
  c.appendChild(
    el(
      'div',
      'wa-card-t',
      `${p.compensationOf ? t().cardUndoTitle : t().cardTitle} ${p.title}`
    )
  );
  if (p.memo)
    c.appendChild(el('div', 'wa-card-m', `${t().memoStep} ${p.memo.step + 1}`));
  const ul = el('ul', 'wa-card-f');
  for (const f of p.fields) {
    const li = el('li');
    li.appendChild(el('b', '', `${f.name}: `));
    if (f.before !== undefined) {
      li.appendChild(el('s', '', shown(f.before)));
      li.appendChild(document.createTextNode(' → '));
    }
    li.appendChild(el('span', '', shown(f.after)));
    ul.appendChild(li);
  }
  c.appendChild(ul);
  const warn = (text: string) => c.appendChild(el('div', 'wa-card-w', text));
  if (p.unrequested) warn(t().unrequested);
  if (p.kind === 'danger' && !p.undoDeclared) warn(t().noUndo);
  if (p.dryRun === 'none' && p.status === 'pending') warn(t().noPreview);
  if (p.dryRunStatus === 'failed' && p.dryRunNote)
    warn(`${t().dryFailed} ${p.dryRunNote}`);
  const row = el('div', 'wa-card-a');
  if (p.status === 'pending') {
    let phrase: HTMLInputElement | null = null;
    if (p.confirmPhrase) {
      c.appendChild(
        el('div', 'wa-card-p', `${t().phraseHint} ${p.confirmPhrase}`)
      );
      phrase = el('input', 'wa-card-i');
      phrase.autocomplete = 'off';
      phrase.setAttribute('aria-label', t().phraseHint);
      c.appendChild(phrase);
    }
    row.append(
      btn(
        t().yes,
        'wa-yes',
        () =>
          void act(p, 'confirm', {
            paramsHash: p.paramsHash,
            ...(phrase ? { phrase: phrase.value } : {}),
          })
      ),
      btn(t().edit, 'wa-edit', () => {
        void act(p, 'reject', {});
        input.placeholder = t().editHint;
        input.focus();
      }),
      btn(t().no, 'wa-no', () => void act(p, 'reject', {}))
    );
  } else if (p.status === 'executing') {
    c.appendChild(el('div', 'wa-card-s', t().executing));
  } else {
    const label: Record<string, string> = {
      done: t().stDone,
      failed: t().stFailed,
      unknown: t().stUnknown,
      rejected: t().stRejected,
      expired: t().stExpired,
    };
    c.appendChild(
      el(
        'div',
        'wa-card-s',
        `${label[p.status] ?? p.status}${p.errorText ? ` ${p.errorText}` : ''}`
      )
    );
    if (p.status === 'done' && p.undoAvailable) {
      row.appendChild(
        btn(t().undo, 'wa-undo', () => void act(p, 'compensate', {}))
      );
    }
    if (p.status === 'unknown') {
      if (p.checkAvailable) {
        row.appendChild(btn(t().check, 'wa-check', () => void check(p, c)));
      }
      // danger: повтор после unknown — тоже со словом подтверждения (сервер
      // требует его на каждое «Да»; без поля повтор был невозможен).
      let again: HTMLInputElement | null = null;
      if (p.confirmPhrase) {
        c.appendChild(
          el('div', 'wa-card-p', `${t().phraseHint} ${p.confirmPhrase}`)
        );
        again = el('input', 'wa-card-i');
        again.autocomplete = 'off';
        again.setAttribute('aria-label', t().phraseHint);
        c.appendChild(again);
      }
      let ack: HTMLInputElement | null = null;
      if (!p.idempotent) {
        const l = el('label', 'wa-card-k');
        ack = el('input');
        ack.type = 'checkbox';
        l.append(ack, document.createTextNode(` ${t().retryAck}`));
        c.appendChild(l);
      }
      row.appendChild(
        btn(
          t().retry,
          'wa-retry',
          () =>
            void act(p, 'confirm', {
              paramsHash: p.paramsHash,
              ...(again ? { phrase: again.value } : {}),
              ...(ack ? { acknowledgeRisk: ack.checked } : {}),
            })
        )
      );
    }
  }
  if (row.childNodes.length) c.appendChild(row);
  return c;
}

async function act(
  p: Proposal,
  what: 'confirm' | 'reject' | 'compensate',
  b: object
) {
  if (!S.session || S.acting) return;
  S.acting = true;
  renderMessages();
  let ok = false;
  try {
    const r = await api<{ proposal: Proposal | null }>(
      `/assist-admin/v1/proposals/${encodeURIComponent(p.id)}/${what}?lang=${S.lang}`,
      { method: 'POST', body: JSON.stringify(b) }
    );
    if (r.status === 401) {
      S.acting = false;
      return expired();
    }
    ok = r.status === 200;
  } catch {
    ok = false;
  } finally {
    S.acting = false;
  }
  // Итог (и следующий шаг мемо) — с сервера: он же переживает перезагрузку.
  await loadState();
  if (!ok) setNote(t().actionError);
}

async function check(p: Proposal, c: HTMLElement) {
  const r = await api<{
    available: boolean;
    fields: Array<{ name: string; now: string | string[] | null }>;
  }>(
    `/assist-admin/v1/proposals/${encodeURIComponent(p.id)}/check?lang=${S.lang}`,
    {
      method: 'POST',
      body: '{}',
    }
  );
  const box = el('div', 'wa-card-c');
  if (r.status === 200 && r.data && r.data.available) {
    for (const f of r.data.fields)
      box.appendChild(el('div', '', `${f.name}: ${shown(f.now)}`));
  } else box.textContent = t().checkNone;
  c.appendChild(box);
}

function renderMessages() {
  list.replaceChildren();
  const shownCards = new Set<string>();
  for (const m of S.messages) {
    const row = el('div', m.role === 'employee' ? 'wa-m wa-me' : 'wa-m wa-ai');
    for (const para of m.text.split(/\n{2,}/))
      row.appendChild(el('p', '', para));
    if (m.role === 'assistant') {
      const fb = el('div', 'wa-fb');
      const up = el('button', m.rating === 1 ? 'on' : '', '👍');
      const down = el('button', m.rating === -1 ? 'on' : '', '👎');
      up.type = down.type = 'button';
      up.setAttribute('aria-label', t().good);
      down.setAttribute('aria-label', t().bad);
      up.addEventListener('click', () => void feedback(m, 1, null));
      down.addEventListener('click', () => openFix(m, row));
      fb.append(up, down);
      row.appendChild(fb);
    }
    const p = m.proposalId ? S.proposals.get(m.proposalId) : undefined;
    if (p && !shownCards.has(p.id)) {
      shownCards.add(p.id);
      row.appendChild(card(p));
    }
    list.appendChild(row);
  }
  // Карточки без своего сообщения (следующий шаг мемо, незавершённые).
  for (const p of S.proposals.values()) {
    if (shownCards.has(p.id) || CARD_DONE.has(p.status)) continue;
    const row = el('div', 'wa-m wa-ai');
    row.appendChild(card(p));
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

function openFix(m: Msg, row: HTMLElement) {
  if (row.querySelector('.wa-fix')) return;
  const box = el('div', 'wa-fix');
  const ta = el('textarea');
  ta.maxLength = 2000;
  ta.placeholder = t().fixPlaceholder;
  const ok = el('button', '', t().fixSend);
  ok.type = 'button';
  ok.addEventListener('click', () => {
    void feedback(m, -1, ta.value.trim() || null);
    box.remove();
  });
  box.append(ta, ok);
  row.appendChild(box);
}

function clearLocal() {
  S.session = null;
  S.sub = null;
  S.exp = 0;
  S.messages = [];
  S.proposals.clear();
  try {
    sessionStorage.removeItem(storageKey());
  } catch {
    /* хранилище недоступно — состояние только в памяти */
  }
  renderMessages();
}

/** pk из адреса iframe (`/wa/v1/frame?pk=…`). */
function framePk(): string {
  try {
    return new URLSearchParams(location.search).get('pk') || '';
  } catch {
    return '';
  }
}

function toParent(type: 'ready' | 'need-identity' | 'close') {
  const origin = S.parentOrigin || parentGuess();
  if (origin) window.parent.postMessage(adminEnvelope({ type }), origin);
}

function parentGuess(): string {
  const anc = (location as Location & { ancestorOrigins?: DOMStringList })
    .ancestorOrigins;
  if (anc && anc.length) return anc[0];
  try {
    return document.referrer ? new URL(document.referrer).origin : '';
  } catch {
    return '';
  }
}

// ── API ────────────────────────────────────────────────────────────────
async function api<R>(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; data: R | null }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (S.session) headers[ADMIN_SESSION_HEADER] = S.session;
  const r = await fetch(path, { ...init, headers, credentials: 'omit' });
  let data: R | null = null;
  try {
    const j = (await r.json()) as { data?: R } & R;
    data = (j && 'data' in j ? j.data : j) as R;
  } catch {
    data = null;
  }
  return { status: r.status, data };
}

async function loadState() {
  const r = await api<{
    messages: Msg[];
    statsPerEmployee: boolean;
    proposals?: Proposal[];
  }>('/assist-admin/v1/state');
  if (r.status === 401) return expired();
  if (r.status !== 200 || !r.data) return setNote(t().unavailable);
  S.messages = r.data.messages;
  S.proposals.clear();
  for (const p of r.data.proposals ?? []) S.proposals.set(p.id, p);
  S.banner = !!r.data.statsPerEmployee;
  renderStatic();
  renderMessages();
  setNote('');
}

function expired() {
  S.session = null;
  setNote(t().expired);
  toParent('need-identity');
}

function scheduleRefresh() {
  clearTimeout(S.refreshTimer);
  const ms = S.exp * 1000 - Date.now() - 90_000;
  S.refreshTimer = window.setTimeout(
    () => toParent('need-identity'),
    Math.max(5_000, ms)
  );
}

async function identity(jwt: string) {
  const c = jwtClaims(jwt);
  if (!c) return setNote(t().unavailable);
  if (S.resetAt && c.iat * 1000 <= S.resetAt) {
    // Сотрудник на этой машине сменился в другой вкладке — старый JWT не годится.
    return setNote(t().reload);
  }
  let stored: { sub?: string } = {};
  try {
    stored = JSON.parse(sessionStorage.getItem(storageKey()) || '{}');
  } catch {
    stored = {};
  }
  if ((stored.sub && stored.sub !== c.sub) || (S.sub && S.sub !== c.sub)) {
    clearLocal();
    const at = Date.now();
    channel?.postMessage({ type: 'reset', sub: c.sub, at });
  }
  const r = await api<{
    session: string;
    expiresAt: string;
    statsPerEmployee: boolean;
  }>('/assist-admin/v1/session', {
    method: 'POST',
    body: JSON.stringify({ pk: S.pk, jwt }),
  });
  if (r.status !== 200 || !r.data) {
    clearLocal();
    return setNote(r.status === 403 ? t().off : t().rejected);
  }
  S.session = r.data.session;
  S.sub = c.sub;
  S.exp = Math.floor(new Date(r.data.expiresAt).getTime() / 1000);
  S.banner = !!r.data.statsPerEmployee;
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify({ sub: c.sub }));
  } catch {
    /* только память */
  }
  scheduleRefresh();
  await loadState();
}

async function ask(text: string) {
  if (!S.session || S.busy || !text) return;
  S.busy = true;
  sendBtn.disabled = true;
  const rid = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  S.messages.push({
    id: rid,
    role: 'employee',
    text,
    answerPath: null,
    rating: null,
  });
  renderMessages();
  setNote(t().thinking);
  try {
    const r = await api<{
      question: Msg;
      answer: Msg & { proposal?: Proposal | null };
    }>('/assist-admin/v1/chat', {
      method: 'POST',
      body: JSON.stringify({ text, clientRequestId: rid }),
    });
    if (r.status === 401) return expired();
    if (r.status !== 200 || !r.data) return setNote(t().unavailable);
    S.messages = S.messages.filter((m) => m.id !== rid);
    S.messages.push(r.data.question, r.data.answer);
    if (r.data.answer.proposal)
      S.proposals.set(r.data.answer.proposal.id, r.data.answer.proposal);
    input.placeholder = t().placeholder;
    renderMessages();
    setNote('');
  } catch {
    setNote(t().unavailable);
  } finally {
    S.busy = false;
    sendBtn.disabled = false;
  }
}

async function feedback(m: Msg, rating: 1 | -1, correction: string | null) {
  const r = await api(
    `/assist-admin/v1/messages/${encodeURIComponent(m.id)}/feedback`,
    {
      method: 'POST',
      body: JSON.stringify(correction ? { rating, correction } : { rating }),
    }
  );
  if (r.status === 200) {
    m.rating = rating;
    renderMessages();
    if (correction) setNote(t().fixThanks);
  } else if (r.status === 401) expired();
}

// ── события ────────────────────────────────────────────────────────────
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = input.value.trim();
  input.value = '';
  void ask(v);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
close.addEventListener('click', () => toParent('close'));

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const m = parseAdminParentMessage(e.data);
  if (!m) return;
  if (m.type === 'init') {
    const guess = parentGuess();
    // origin родителя: из сообщения и из браузера — должны совпасть.
    if (m.parentOrigin !== e.origin || (guess && guess !== e.origin)) return;
    // pk — тот же, по которому сервер выставил frame-ancestors этого HTML
    // (`?pk=`), и только один раз: родитель хоста админки сайта A не
    // переключит iframe на сайт B (аудит Э7).
    if (m.pk !== framePk() || (S.pk && S.pk !== m.pk)) return;
    S.parentOrigin = e.origin;
    S.pk = m.pk;
    S.lang = m.lang ?? 'uk';
    renderStatic();
    if (typeof BroadcastChannel === 'function' && !channel) {
      channel = new BroadcastChannel(`${ADMIN_CHANNEL_PREFIX}:${S.pk}`);
      channel.onmessage = (ev: MessageEvent) => {
        const d = ev.data as { type?: string; sub?: string; at?: number };
        if (
          d &&
          d.type === 'reset' &&
          d.sub !== S.sub &&
          typeof d.at === 'number'
        ) {
          clearLocal();
          S.resetAt = d.at;
          setNote(t().reload);
          toParent('need-identity');
        }
      };
    }
    return;
  }
  if (!S.parentOrigin || e.origin !== S.parentOrigin) return;
  if (m.type === 'identity') void identity(m.jwt);
  else if (m.type === 'logout') {
    const had = S.session;
    if (had)
      void fetch('/assist-admin/v1/logout', {
        method: 'POST',
        headers: { [ADMIN_SESSION_HEADER]: had },
        credentials: 'omit',
      }).catch(() => null);
    clearLocal();
    setNote(t().loggedOut);
  }
});

renderStatic();
setNote(t().connecting);
toParent('ready');
