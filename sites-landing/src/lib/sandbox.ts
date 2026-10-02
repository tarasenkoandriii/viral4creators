/**
 * Песочница «Попробовать на своём сайте» (Л4, ТЗ лендинга §6) — модель
 * без React и DOM (проверяет `scripts/sandbox.test.ts`).
 *
 * Продукт — `sites-backend` (Э1, K3): публичные маршруты
 *   POST /public/assist/sandbox          { url }      → PublicSandboxCreated
 *   GET  /public/assist/sandbox/:id      X-Sandbox-Key → SandboxView
 *   POST /public/assist/sandbox/:id/chat X-Sandbox-Key { question } → SandboxAnswer
 * Типы ниже — КОПИЯ `sites-backend/src/modules/assist-knowledge-core/api-types.ts`
 * (код бэкенда в сборку лендинга не тянем); совпадение типов, лимитов,
 * заголовка и кодов отказа держит `scripts/api-contract.test.ts`.
 *
 * Правила, которые здесь, а не в компоненте:
 *  - предпроверка адреса — та же форма, что у сервера (`checkUrl`): только
 *    https, порт 443, без `user:pass@`, без IP-литералов и внутренних имён.
 *    Это подсказка до запроса; решает сервер (SSRF, opt-out, категории);
 *  - ответ песочницы — ВРАЖДЕБНЫЙ текст чужого сайта (§6.2): рендерится
 *    только как текст (никакого markdown/HTML), маркеры `[S#]` → источник;
 *    ссылкой источник становится, только если это `https:` на хост
 *    песочницы без логина и нестандартного порта — иначе текст без ссылки;
 *  - ключ браузера живёт в `sessionStorage` вкладки (строго необходимое
 *    хранение для запрошенной услуги, §13) и не дольше 24 ч;
 *  - перенос в TMA — `startapp=sb_<id>` (`tmaStartLink`) (читатель — экран
 *    `SandboxTransferScreen` TMA, префикс — `site-tma-kit` `START_PREFIXES.sb`).
 */
import { PRODUCT_NAMES } from '../brand';
import { tmaStartLink } from './widget-draft';

// ── Типы продукта (копия api-types.ts) ────────────────────────────────

export type SandboxStatus = 'queued' | 'crawling' | 'indexing' | 'ready' | 'failed' | 'blocked' | 'expired';
export const SANDBOX_STATUSES: readonly SandboxStatus[] = ['queued', 'crawling', 'indexing', 'ready', 'failed', 'blocked', 'expired'];

export interface SandboxSourceRef {
  n: number;
  url: string | null;
  title: string | null;
}

export interface SandboxMessageView {
  role: 'visitor' | 'assistant';
  text: string;
  sources: SandboxSourceRef[];
  createdAt: string;
}

export interface SandboxView {
  id: string;
  kind: 'public' | 'cabinet';
  status: SandboxStatus;
  statusReason: string | null;
  url: string;
  host: string;
  title: string | null;
  lang: string | null;
  themeColor: string | null;
  progress: { sitemap: boolean; found: number; read: number; titles: string[] };
  pagesRead: number;
  pagesLimit: number;
  questions: number;
  questionsLimit: number;
  suggestedQuestions: string[];
  messages: SandboxMessageView[];
  expiresAt: string;
  answersFrom: 'sandbox' | 'knowledge';
}

export interface SandboxAnswer {
  answer: string;
  sources: SandboxSourceRef[];
  refused: boolean;
  questionsLeft: number;
}

export interface PublicSandboxCreated {
  id: string;
  sandboxKey: string;
  status: SandboxStatus;
}

/** Тела запросов (DTO сервера: `SandboxUrlDto`, `SandboxChatDto`). */
export interface SandboxCreateBody {
  url: string;
}
export interface SandboxChatBody {
  question: string;
}

// ── Лимиты публичной песочницы (`SANDBOX_LIMITS.public` сервера) ─────────

export const SANDBOX_PUBLIC_LIMITS = {
  pages: 8,
  questions: 10,
  ttlHours: 24,
  perIpPerDay: 3,
  newCrawlsPerDomainPerDay: 3,
  maxQuestionChars: 500,
  maxUrlChars: 2048,
} as const;

/** id песочницы: 128 бит base64url у сервера; `sb_<id>` ≤ 64 → id ≤ 60 (site-tma-kit). */
export const SANDBOX_ID_RE = /^[A-Za-z0-9_-]{16,60}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,200}$/;

export function sandboxEndpoint(apiOrigin: string): string {
  return `${apiOrigin}/public/assist/sandbox`;
}

/**
 * Адрес страницы без параметра `url` (адрес сайта из hero, `/try?url=…`) —
 * для `history.replaceState` после чтения; остальные параметры и якорь
 * остаются. null — параметра нет (менять адрес не нужно).
 */
export function withoutUrlParam(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!u.searchParams.has('url')) return null;
  u.searchParams.delete('url');
  return `${u.pathname}${u.search}${u.hash}`;
}

// ── Предпроверка адреса ───────────────────────────────────────────────

export type UrlProblem = 'empty' | 'too-long' | 'scheme' | 'credentials' | 'port' | 'ip' | 'host';

const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home.arpa', 'corp', 'test', 'invalid', 'example', 'onion'];

/**
 * Ввод без схемы — https (как сервер); `http://` и прочие схемы — отказ,
 * а не «молча https» (сервер делает так же — человек должен видеть, что
 * проверяем именно https-версию).
 */
export function precheckUrl(raw: string): { ok: true; url: string; host: string } | { ok: false; problem: UrlProblem } {
  const input = raw.trim();
  if (!input) return { ok: false, problem: 'empty' };
  if (input.length > SANDBOX_PUBLIC_LIMITS.maxUrlChars) return { ok: false, problem: 'too-long' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https:\/\//i.test(input)) {
    // `shop.example:8443` без схемы URL тоже читает как «схему» — это порт.
    if (/^[^/:]+:\d+(\/|$)/.test(input)) return { ok: false, problem: 'port' };
    return { ok: false, problem: 'scheme' };
  }
  const withScheme = /^https:\/\//i.test(input) ? input : `https://${input}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, problem: 'host' };
  }
  if (u.username || u.password || /^https:\/\/[^/]*@/i.test(withScheme)) return { ok: false, problem: 'credentials' };
  if (u.port && u.port !== '443') return { ok: false, problem: 'port' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host)) {
    return { ok: false, problem: 'ip' };
  }
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63) || INTERNAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return { ok: false, problem: 'host' };
  }
  return { ok: true, url: `https://${host}${u.pathname === '/' ? '/' : u.pathname}`, host };
}

// ── Ответы сервера ────────────────────────────────────────────────────

/** Все коды отказа, которые могут прийти с публичных маршрутов песочницы. */
export const SANDBOX_ERROR_CODES = [
  'URL_REJECTED',
  'URL_INVALID',
  'OPTED_OUT',
  'BLOCKED_CATEGORY',
  'SANDBOX_DISABLED',
  'SANDBOX_BUDGET',
  'SANDBOX_LIMIT_IP',
  'SANDBOX_LIMIT_DOMAIN',
  'SANDBOX_QUESTIONS_EXHAUSTED',
  'SANDBOX_EXPIRED',
  'SANDBOX_NOT_FOUND',
  'SANDBOX_NOT_READY',
  'ANSWER_UNAVAILABLE',
  'ORIGIN_FORBIDDEN',
] as const;
export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

/**
 * Что показать человеку. `unavailable` — «сейчас недоступно, оставьте
 * заявку» (рубильник или денежный потолок, §6.3: не ошибка); `limit-ip` —
 * «откройте в Telegram» (веб-входа нет, В-13).
 */
export type SandboxProblem =
  | 'unavailable'
  | 'limit-ip'
  | 'limit-domain'
  | 'rejected'
  | 'opted-out'
  | 'blocked'
  | 'origin'
  | 'gone'
  | 'exhausted'
  | 'not-ready'
  | 'answer-unavailable'
  | 'too-long'
  | 'network'
  | 'unexpected';

const PROBLEM_OF: Record<SandboxErrorCode, SandboxProblem> = {
  URL_REJECTED: 'rejected',
  URL_INVALID: 'rejected',
  OPTED_OUT: 'opted-out',
  BLOCKED_CATEGORY: 'blocked',
  SANDBOX_DISABLED: 'unavailable',
  SANDBOX_BUDGET: 'unavailable',
  SANDBOX_LIMIT_IP: 'limit-ip',
  SANDBOX_LIMIT_DOMAIN: 'limit-domain',
  SANDBOX_QUESTIONS_EXHAUSTED: 'exhausted',
  SANDBOX_EXPIRED: 'gone',
  SANDBOX_NOT_FOUND: 'gone',
  SANDBOX_NOT_READY: 'not-ready',
  ANSWER_UNAVAILABLE: 'answer-unavailable',
  ORIGIN_FORBIDDEN: 'origin',
};

export function problemOf(code: string | null, status: number): SandboxProblem {
  if (code && Object.prototype.hasOwnProperty.call(PROBLEM_OF, code)) return PROBLEM_OF[code as SandboxErrorCode];
  if (status === 503) return 'unavailable';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429) return 'limit-ip';
  if (status === 400) return 'rejected';
  return 'unexpected';
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; problem: SandboxProblem; code: string | null };

/** Конверт `{ success, data }` / `{ success: false, error: { code } }` + строгий разбор данных. */
export function parseEnvelope<T>(status: number, body: unknown, parse: (d: unknown) => T | null): Envelope<T> {
  const o = isObj(body) ? body : null;
  if (o && o.success === true && status >= 200 && status < 300) {
    const data = parse(o.data);
    return data ? { ok: true, data } : { ok: false, problem: 'unexpected', code: null };
  }
  const err = o && isObj(o.error) ? o.error : null;
  const code = err && typeof err.code === 'string' ? err.code : null;
  return { ok: false, problem: problemOf(code, status), code };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function parseCreated(d: unknown): PublicSandboxCreated | null {
  if (!isObj(d) || !str(d.id) || !SANDBOX_ID_RE.test(d.id) || !str(d.sandboxKey) || !KEY_RE.test(d.sandboxKey)) return null;
  if (!SANDBOX_STATUSES.includes(d.status as SandboxStatus)) return null;
  return { id: d.id, sandboxKey: d.sandboxKey, status: d.status as SandboxStatus };
}

function parseSources(v: unknown): SandboxSourceRef[] | null {
  if (!Array.isArray(v)) return null;
  const out: SandboxSourceRef[] = [];
  for (const s of v.slice(0, 20)) {
    if (!isObj(s) || !int(s.n) || !strOrNull(s.url) || !strOrNull(s.title)) return null;
    out.push({ n: s.n, url: s.url, title: s.title });
  }
  return out;
}

export function parseView(d: unknown): SandboxView | null {
  if (!isObj(d) || !str(d.id) || !SANDBOX_ID_RE.test(d.id) || !SANDBOX_STATUSES.includes(d.status as SandboxStatus)) return null;
  if (!str(d.url) || !str(d.host) || !strOrNull(d.statusReason) || !strOrNull(d.title) || !strOrNull(d.lang) || !strOrNull(d.themeColor)) return null;
  const p = d.progress;
  if (!isObj(p) || typeof p.sitemap !== 'boolean' || !int(p.found) || !int(p.read) || !Array.isArray(p.titles)) return null;
  if (![d.pagesRead, d.pagesLimit, d.questions, d.questionsLimit].every(int) || !str(d.expiresAt)) return null;
  if (!Array.isArray(d.suggestedQuestions) || !Array.isArray(d.messages)) return null;
  const messages: SandboxMessageView[] = [];
  for (const m of d.messages.slice(0, 100)) {
    if (!isObj(m) || (m.role !== 'visitor' && m.role !== 'assistant') || !str(m.text) || !str(m.createdAt)) return null;
    const sources = parseSources(m.sources);
    if (!sources) return null;
    messages.push({ role: m.role, text: m.text, sources, createdAt: m.createdAt });
  }
  return {
    id: d.id,
    kind: d.kind === 'cabinet' ? 'cabinet' : 'public',
    status: d.status as SandboxStatus,
    statusReason: d.statusReason,
    url: d.url,
    host: d.host,
    title: d.title,
    lang: d.lang,
    themeColor: d.themeColor,
    progress: { sitemap: p.sitemap, found: p.found, read: p.read, titles: p.titles.filter(str).slice(0, 20) },
    pagesRead: d.pagesRead as number,
    pagesLimit: d.pagesLimit as number,
    questions: d.questions as number,
    questionsLimit: d.questionsLimit as number,
    suggestedQuestions: d.suggestedQuestions.filter(str).slice(0, 3),
    messages,
    expiresAt: d.expiresAt,
    answersFrom: d.answersFrom === 'knowledge' ? 'knowledge' : 'sandbox',
  };
}

export function parseAnswer(d: unknown): SandboxAnswer | null {
  if (!isObj(d) || !str(d.answer) || typeof d.refused !== 'boolean' || !int(d.questionsLeft)) return null;
  const sources = parseSources(d.sources);
  if (!sources) return null;
  return { answer: d.answer, sources, refused: d.refused, questionsLeft: d.questionsLeft };
}

/** Идёт ли ещё работа (опрашивать дальше). */
export function isWorking(status: SandboxStatus): boolean {
  return status === 'queued' || status === 'crawling' || status === 'indexing';
}

/** Пауза перед следующим опросом: часто в начале, реже потом; потолок ожидания ≈ 3 мин. */
export function pollDelayMs(attempt: number): number {
  return attempt < 10 ? 1500 : attempt < 30 ? 3000 : 5000;
}
export const MAX_POLLS = 60;

// ── Безопасный рендер ответа (§6.2, ТЗ TMA §4.9, §4.12) ────────────────

/**
 * Ссылка на источник — только `https:` на САМ хост песочницы, порт 443,
 * без логина. Чужой хост, `http:`, `javascript:`, `data:` — null (текст
 * без ссылки): иначе инъекция со страницы чужого сайта стала бы
 * фишинговой ссылкой на нашем домене.
 */
export function safeSourceHref(url: string | null, sandboxHost: string): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  if (u.hostname.toLowerCase() !== sandboxHost.toLowerCase()) return null;
  return u.href;
}

export type AnswerSegment = { kind: 'text'; text: string } | { kind: 'ref'; n: number };

/**
 * Ответ → отрезки: обычный текст и маркеры `[S#]` (номера только из
 * `sources` ответа). Никакого markdown и HTML: `<img>`, `[x](javascript:…)`,
 * голые адреса — остаются буквами, React их экранирует.
 */
export function answerSegments(text: string, sources: readonly SandboxSourceRef[]): AnswerSegment[] {
  const known = new Set(sources.map((s) => s.n));
  const out: AnswerSegment[] = [];
  const re = /\[S(\d{1,2})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'text') prev.text += t;
    else out.push({ kind: 'text', text: t });
  };
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index));
    const n = Number(m[1]);
    if (known.has(n)) out.push({ kind: 'ref', n });
    else push(m[0]);
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

/** Подпись источника: заголовок, иначе путь адреса, иначе «№n». */
export function sourceLabel(s: SandboxSourceRef): string {
  if (s.title && s.title.trim()) return s.title.trim().slice(0, 120);
  if (s.url) {
    try {
      const u = new URL(s.url);
      return `${u.hostname}${u.pathname}`.slice(0, 120);
    } catch {
      return s.url.slice(0, 120);
    }
  }
  return `#${s.n}`;
}

/** Цвет макета из `theme-color` их сайта — только `#rgb`/`#rrggbb`, иначе null. */
export function safeThemeColor(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return `#${s.slice(1).split('').map((c) => c + c).join('')}`.toUpperCase();
  return null;
}

// ── Перенос в TMA ─────────────────────────────────────────────────────

export function tmaSandboxLink(bot: string, sandboxId: string): string {
  if (!SANDBOX_ID_RE.test(sandboxId)) throw new Error('tmaSandboxLink: негодный id песочницы');
  return tmaStartLink(bot, `${PRODUCT_NAMES.sandboxStartPrefix}${sandboxId}`);
}

// ── Сессия вкладки (sessionStorage) ───────────────────────────────────

export const SESSION_KEY = 'assist-sandbox';
export interface SandboxSession {
  id: string;
  key: string;
  createdAt: number;
}

export function serializeSession(s: SandboxSession): string {
  return JSON.stringify({ id: s.id, key: s.key, createdAt: s.createdAt });
}

/** Битая/чужая/старше 24 ч запись — null (её нужно удалить). */
export function parseSession(raw: string | null, now: number): SandboxSession | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(o) || !str(o.id) || !SANDBOX_ID_RE.test(o.id) || !str(o.key) || !KEY_RE.test(o.key)) return null;
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return null;
  const age = now - o.createdAt;
  if (age < 0 || age > SANDBOX_PUBLIC_LIMITS.ttlHours * 3600_000) return null;
  return { id: o.id, key: o.key, createdAt: o.createdAt };
}
