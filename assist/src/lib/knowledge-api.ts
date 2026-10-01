/**
 * Клиент REST Э1: знания «Сайта» и «Админки», песочница, предпросмотр
 * адреса, перенос `sb_` (контракт Э1 §6; формы — `knowledge-types.ts`).
 *
 * Разбор строгий, как в `kit/sites-api.ts`: бэкенд пишут параллельно, и
 * неожиданное поле не должно превратиться в зелёную галочку. Правила:
 * - неизвестный статус → самый осторожный (версия — не «опубликована»,
 *   источник — «обрабатывается», песочница — «ошибка»);
 * - флаги прав и действий (`adminAvailable`, `canRollback`, `isPublished`)
 *   — строго `true`, всё прочее — нет: лишняя кнопка хуже недостающей;
 * - ссылки — только абсолютные http(s): `javascript:` из базы знаний
 *   (отравленная страница сайта) не должна стать кликабельной;
 * - числа — конечные и ≥ 0, иначе 0 (не NaN в интерфейсе).
 *
 * Режим (`site` | `admin`) — часть пути, и клиент режима строит пути
 * только своего режима: экран «Сайта» физически не может позвать
 * маршрут «Админки» (К-9 на стороне интерфейса).
 */

import {
  ApiError,
  parseCrawlRun,
  parseSkippedByReason,
  toCount,
  type ApiClient,
} from '../kit';
import {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  EXCLUSION_KINDS,
  FAQ_STATUSES,
  GATE_CHECKS,
  RECRAWL_EVERY,
  SANDBOX_STATUSES,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  VERSION_STATUSES,
  VERSION_TRIGGERS,
  type AdminKnowledgeSettings,
  type AssistSettingsView,
  type CreateSourceResult,
  type DocumentStatus,
  type DocumentView,
  type ExclusionKind,
  type ExclusionView,
  type FaqView,
  type GateCheck,
  type GateReport,
  type KnowledgeMode,
  type KnowledgeSummary,
  type Page,
  type QuarantineView,
  type RecrawlEvery,
  type SandboxAnswer,
  type SandboxMessageView,
  type SandboxSourceRef,
  type SandboxTransferResult,
  type SandboxView,
  type SourceView,
  type UploadTicketView,
  type UrlPreview,
  type VersionView,
} from './knowledge-types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] =>
  arr(v).filter((x): x is string => typeof x === 'string' && x.length > 0);
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const oneOf = <T extends string>(
  list: readonly T[],
  v: unknown,
  fallback: T
): T =>
  (list as readonly string[]).includes(v as string) ? (v as T) : fallback;

/** Абсолютная http(s)-ссылка или null — ничего кликабельного иного. */
export function safeHttpUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Цвет темы сайта — только `#rgb`/`#rrggbb`: значение идёт в style. */
export function safeColor(v: unknown): string | null {
  return typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)
    ? v
    : null;
}

/** Язык — короткий код (`uk`, `ru`, `pt-BR`), иначе null. */
function lang(v: unknown): string | null {
  return typeof v === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(v)
    ? v
    : null;
}

// ── Разборщики ───────────────────────────────────────────────────────

export function parseSettings(v: unknown): AssistSettingsView {
  const o = obj(v);
  return {
    siteId: text(o.siteId),
    enabled: o.enabled === true,
    knowledgeVersion: toCount(o.knowledgeVersion),
    recrawlEvery: oneOf<RecrawlEvery>(RECRAWL_EVERY, o.recrawlEvery, 'manual'),
    nextCrawlAt: str(o.nextCrawlAt),
    hotPages: strs(o.hotPages)
      .map(safeHttpUrl)
      .filter((x): x is string => !!x),
    lastCrawl: parseCrawlRun(o.lastCrawl),
    adminAvailable: o.adminAvailable === true,
    hasVerifiedHost: o.hasVerifiedHost === true,
  };
}

export function parseAdminSettings(v: unknown): AdminKnowledgeSettings {
  const o = obj(v);
  return {
    // Строго true: «копировать публичное» по умолчанию включено на
    // сервере, но показать «вкл» при битом ответе — значит соврать.
    includePublicInAdmin: o.includePublicInAdmin === true,
    includeUgcInAdmin: o.includeUgcInAdmin === true,
  };
}

function parseGateCheck(v: unknown): GateCheck | null {
  const o = obj(v);
  if (!(GATE_CHECKS as readonly string[]).includes(o.check as string)) {
    return null;
  }
  const c: GateCheck = {
    check: o.check as GateCheck['check'],
    value: num(o.value),
    threshold: num(o.threshold),
    held: o.held === true,
  };
  const note = str(o.note);
  if (note) c.note = note;
  return c;
}

export function parseGateReport(v: unknown): GateReport | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return {
    checks: arr(o.checks)
      .map(parseGateCheck)
      .filter((x): x is GateCheck => !!x),
    held: o.held === true,
    coldStart: o.coldStart === true,
  };
}

export function parseVersion(v: unknown): VersionView {
  const o = obj(v);
  const status = oneOf(VERSION_STATUSES, o.status, 'building');
  return {
    number: toCount(o.number),
    status,
    trigger: oneOf(VERSION_TRIGGERS, o.trigger, 'manual'),
    stats: obj(o.stats),
    gateReport: parseGateReport(o.gateReport),
    heldReason: str(o.heldReason),
    createdAt: text(o.createdAt),
    publishedAt: str(o.publishedAt),
    // «Текущая» — только опубликованная: флаг без статуса — сбой сервера.
    isPublished: o.isPublished === true && status === 'published',
    canRollback: o.canRollback === true,
  };
}

function parseLangs(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(obj(v))) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1)
      out[k] = raw;
  }
  return out;
}

export function parseSummary(
  v: unknown,
  mode: KnowledgeMode
): KnowledgeSummary {
  const o = obj(v);
  const pages = obj(o.pages);
  const budget = obj(o.learningBudget);
  const s: KnowledgeSummary = {
    // Режим — тот, который спрашивали: ответ «не того» режима показать
    // под заголовком этого было бы утечкой хотя бы в интерфейсе.
    mode,
    publishedVersion: toCount(o.publishedVersion),
    pages: {
      read: toCount(pages.read),
      skipped: toCount(pages.skipped),
      skippedByReason: parseSkippedByReason(pages.skippedByReason),
    },
    documents: toCount(o.documents),
    chunks: toCount(o.chunks),
    langs: parseLangs(o.langs),
    lastCrawl: parseCrawlRun(o.lastCrawl),
    heldVersion:
      o.heldVersion && typeof o.heldVersion === 'object'
        ? parseVersion(o.heldVersion)
        : null,
    quarantineCount: toCount(o.quarantineCount),
    suggestedQuestions: strs(o.suggestedQuestions).slice(0, 5),
    learningBudget: {
      period: text(budget.period),
      capMicroUsd: toCount(budget.capMicroUsd),
      spentMicroUsd: toCount(budget.spentMicroUsd),
    },
  };
  if (mode === 'admin' && o.settings && typeof o.settings === 'object') {
    s.settings = parseAdminSettings(o.settings);
  }
  return s;
}

export function parseSource(v: unknown): SourceView {
  const o = obj(v);
  return {
    id: text(o.id),
    kind: oneOf(SOURCE_KINDS, o.kind, 'url'),
    title: str(o.title),
    // Неизвестный статус — «обрабатывается», не «активен».
    status: oneOf(SOURCE_STATUSES, o.status, 'processing'),
    error: str(o.error),
    fileName: str(o.fileName),
    bytes: typeof o.bytes === 'number' ? toCount(o.bytes) : null,
    documentsCount: toCount(o.documentsCount),
    lastSyncAt: str(o.lastSyncAt),
    config: obj(o.config),
    createdAt: text(o.createdAt),
  };
}

/** Ссылки источника `url` (`config.urls`) — только http(s). */
export function sourceUrls(s: SourceView): string[] {
  return strs(s.config.urls)
    .map(safeHttpUrl)
    .filter((x): x is string => !!x);
}

export function parseUploadTicket(v: unknown): UploadTicketView | null {
  const o = obj(v);
  const pathname = str(o.pathname);
  const clientToken = str(o.clientToken);
  const contentType = str(o.contentType);
  // Без любого из полей загрузить нельзя — лучше честная ошибка.
  if (!pathname || !clientToken || !contentType) return null;
  return {
    pathname,
    clientToken,
    maxBytes: toCount(o.maxBytes),
    contentType,
    expiresAt: text(o.expiresAt),
  };
}

export function parseCreateSource(v: unknown): CreateSourceResult {
  const o = obj(v);
  const r: CreateSourceResult = { source: parseSource(o.source) };
  const upload = parseUploadTicket(o.upload);
  if (upload) r.upload = upload;
  return r;
}

export function parseDocument(v: unknown): DocumentView {
  const o = obj(v);
  return {
    id: text(o.id),
    sourceId: text(o.sourceId),
    kind: oneOf(DOCUMENT_KINDS, o.kind, 'page'),
    url: safeHttpUrl(o.url),
    title: str(o.title),
    lang: lang(o.lang),
    status: oneOf(DOCUMENT_STATUSES, o.status, 'skipped'),
    skipReason: str(o.skipReason),
    hot: o.hot === true,
    chunks: toCount(o.chunks),
    updatedAt: text(o.updatedAt),
  };
}

export function parsePage<T>(v: unknown, item: (x: unknown) => T): Page<T> {
  const o = obj(v);
  return { items: arr(o.items).map(item), nextCursor: str(o.nextCursor) };
}

export function parseFaq(v: unknown): FaqView {
  const o = obj(v);
  return {
    id: text(o.id),
    question: text(o.question),
    answer: text(o.answer),
    variants: strs(o.variants),
    lang: lang(o.lang),
    origin: text(o.origin),
    status: oneOf(FAQ_STATUSES, o.status, 'needs_review'),
    updatedAt: text(o.updatedAt),
  };
}

export function parseExclusion(v: unknown): ExclusionView {
  const o = obj(v);
  return {
    id: text(o.id),
    kind: oneOf(EXCLUSION_KINDS, o.kind, 'url'),
    value: text(o.value),
    reason: str(o.reason),
    chunksDeleted: toCount(o.chunksDeleted),
    createdAt: text(o.createdAt),
  };
}

/** Отрывок карантина — ДАННЫЕ: ≤ 500 символов и только текстом. */
export const QUARANTINE_EXCERPT_MAX = 500;

export function parseQuarantine(v: unknown): QuarantineView {
  const o = obj(v);
  return {
    chunkId: text(o.chunkId),
    documentId: text(o.documentId),
    url: safeHttpUrl(o.url),
    title: str(o.title),
    excerpt: text(o.excerpt).slice(0, QUARANTINE_EXCERPT_MAX),
    reason: str(o.reason),
    createdAt: text(o.createdAt),
  };
}

export function parseUrlPreview(v: unknown): UrlPreview {
  const o = obj(v);
  return {
    url: safeHttpUrl(o.url) ?? '',
    host: text(o.host),
    title: str(o.title),
    lang: lang(o.lang),
    sitemapFound: o.sitemapFound === true,
    themeColor: safeColor(o.themeColor),
  };
}

function parseSourceRef(v: unknown): SandboxSourceRef {
  const o = obj(v);
  return { n: toCount(o.n), url: safeHttpUrl(o.url), title: str(o.title) };
}

function parseMessage(v: unknown): SandboxMessageView | null {
  const o = obj(v);
  if (o.role !== 'visitor' && o.role !== 'assistant') return null;
  return {
    role: o.role,
    text: text(o.text),
    sources: arr(o.sources).map(parseSourceRef),
    createdAt: text(o.createdAt),
  };
}

export function parseSandbox(v: unknown): SandboxView {
  const o = obj(v);
  const p = obj(o.progress);
  return {
    id: text(o.id),
    kind: o.kind === 'public' ? 'public' : 'cabinet',
    // Неизвестный статус — «ошибка»: опрос остановится, а не будет
    // крутить «читаю сайт…» бесконечно.
    status: oneOf(SANDBOX_STATUSES, o.status, 'failed'),
    statusReason: str(o.statusReason),
    url: safeHttpUrl(o.url) ?? '',
    host: text(o.host),
    title: str(o.title),
    lang: lang(o.lang),
    themeColor: safeColor(o.themeColor),
    progress: {
      sitemap: p.sitemap === true,
      found: toCount(p.found),
      read: toCount(p.read),
      titles: strs(p.titles),
    },
    pagesRead: toCount(o.pagesRead),
    pagesLimit: toCount(o.pagesLimit),
    questions: toCount(o.questions),
    questionsLimit: toCount(o.questionsLimit),
    suggestedQuestions: strs(o.suggestedQuestions),
    messages: arr(o.messages)
      .map(parseMessage)
      .filter((x): x is SandboxMessageView => !!x),
    expiresAt: text(o.expiresAt),
    answersFrom: o.answersFrom === 'knowledge' ? 'knowledge' : 'sandbox',
  };
}

export function parseSandboxAnswer(v: unknown): SandboxAnswer {
  const o = obj(v);
  return {
    answer: text(o.answer),
    sources: arr(o.sources).map(parseSourceRef),
    refused: o.refused === true,
    questionsLeft: toCount(o.questionsLeft),
  };
}

export function parseTransfer(v: unknown): SandboxTransferResult {
  const o = obj(v);
  const siteId = str(o.siteId);
  if (!siteId) throw new Error('Сервер не вернул сайт после переноса');
  return { siteId, hostId: text(o.hostId) };
}

/**
 * 404 «нет такого маршрута» (сервер старее фронта), а не «нет такой
 * записи»: у записей свои коды (`SITE_NOT_FOUND`, `SANDBOX_NOT_FOUND`…).
 */
export function isMissingRoute(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.status === 404 &&
    (e.code === 'NOT_FOUND' || e.code === 'http_404')
  );
}

const list = <T>(v: unknown, item: (x: unknown) => T): T[] =>
  arr(Array.isArray(v) ? v : obj(v).items).map(item);

// ── Клиент ───────────────────────────────────────────────────────────

const enc = encodeURIComponent;

export type FileSourceInput = {
  fileName: string;
  mimeType: string;
  bytes: number;
  /** Только «Сайт»: «этот файл увидят все посетители» (ТЗ §3.4). */
  confirmPublic?: true;
};

export type FaqInput = {
  question: string;
  answer: string;
  variants?: string[];
  lang?: string | null;
};

export interface DocumentsQuery {
  sourceId?: string;
  status?: DocumentStatus;
  cursor?: string | null;
}

/** Общее для двух режимов: пути отличаются только сегментом режима. */
function modeApi(client: ApiClient, siteId: string, mode: KnowledgeMode) {
  const k = `/assist/sites/${enc(siteId)}/knowledge/${mode}`;
  const l = `/assist/sites/${enc(siteId)}/learning/${mode}`;
  return {
    mode,
    summary: async () =>
      parseSummary(await client.request('GET', `${k}/summary`), mode),
    sources: async () =>
      list(await client.request('GET', `${k}/sources`), parseSource),
    addUrls: async (urls: string[]) =>
      parseCreateSource(
        await client.request('POST', `${k}/sources`, { kind: 'url', urls })
      ),
    addFile: async (f: FileSourceInput) =>
      parseCreateSource(
        await client.request('POST', `${k}/sources`, { kind: 'file', ...f })
      ),
    uploaded: async (sourceId: string) =>
      parseSource(
        await client.request('POST', `${k}/sources/${enc(sourceId)}/uploaded`)
      ),
    patchSource: async (
      sourceId: string,
      patch: {
        title?: string;
        status?: 'active' | 'disabled';
        urls?: string[];
      }
    ) =>
      parseSource(
        await client.request('PATCH', `${k}/sources/${enc(sourceId)}`, patch)
      ),
    deleteSource: async (sourceId: string) => {
      const r = obj(
        await client.request('DELETE', `${k}/sources/${enc(sourceId)}`)
      );
      return { ok: r.ok === true };
    },
    documents: async (q: DocumentsQuery = {}) => {
      const p = new URLSearchParams();
      if (q.sourceId) p.set('sourceId', q.sourceId);
      if (q.status) p.set('status', q.status);
      if (q.cursor) p.set('cursor', q.cursor);
      const qs = p.toString();
      return parsePage(
        await client.request('GET', `${k}/documents${qs ? `?${qs}` : ''}`),
        parseDocument
      );
    },
    faq: async () => list(await client.request('GET', `${k}/faq`), parseFaq),
    createFaq: async (f: FaqInput) =>
      parseFaq(await client.request('POST', `${k}/faq`, f)),
    patchFaq: async (id: string, f: Partial<FaqInput>) =>
      parseFaq(await client.request('PATCH', `${k}/faq/${enc(id)}`, f)),
    deleteFaq: async (id: string) => {
      await client.request('DELETE', `${k}/faq/${enc(id)}`);
    },
    versions: async () =>
      list(await client.request('GET', `${l}/versions`), parseVersion),
    versionAction: async (
      n: number,
      action: 'publish' | 'discard' | 'rollback'
    ) =>
      parseVersion(
        await client.request('POST', `${l}/versions/${toCount(n)}/${action}`)
      ),
    exclusions: async () =>
      list(await client.request('GET', `${l}/exclusions`), parseExclusion),
    addExclusion: async (e: {
      kind: ExclusionKind;
      value: string;
      reason?: string;
    }) => parseExclusion(await client.request('POST', `${l}/exclusions`, e)),
    liftExclusion: async (id: string) => {
      await client.request('DELETE', `${l}/exclusions/${enc(id)}`);
    },
    quarantine: async () =>
      list(await client.request('GET', `${l}/quarantine`), parseQuarantine),
    allowQuarantined: async (chunkId: string) =>
      parseVersion(
        await client.request('POST', `${l}/quarantine/${enc(chunkId)}/allow`)
      ),
  };
}

export type ModeKnowledgeClient = ReturnType<typeof modeApi>;

export function createKnowledgeApi(client: ApiClient) {
  const site = (siteId: string) => {
    const base = modeApi(client, siteId, 'site');
    const k = `/assist/sites/${enc(siteId)}/knowledge/site`;
    return {
      ...base,
      /**
       * Настройки сайта без побочных эффектов. В контракте Э1 этого GET нет
       * (есть только POST enable, который на каждом вызове просит
       * initial-обход) — запрошен у координатора; до него 404 → null.
       */
      settings: async () => {
        try {
          return parseSettings(await client.request('GET', `${k}/settings`));
        } catch (e) {
          if (isMissingRoute(e)) return null;
          throw e;
        }
      },
      setHotPages: async (urls: string[]) =>
        parseSettings(await client.request('PUT', `${k}/hot-pages`, { urls })),
      setRecrawlEvery: async (recrawlEvery: RecrawlEvery) =>
        parseSettings(
          await client.request('PATCH', `${k}/settings`, { recrawlEvery })
        ),
      recrawl: async () => {
        const run = parseCrawlRun(await client.request('POST', `${k}/recrawl`));
        if (!run) throw new Error('Сервер не вернул прогон обхода');
        return run;
      },
    };
  };
  const admin = (siteId: string) => {
    const base = modeApi(client, siteId, 'admin');
    const k = `/assist/sites/${enc(siteId)}/knowledge/admin`;
    return {
      ...base,
      settings: async () =>
        parseAdminSettings(await client.request('GET', `${k}/settings`)),
      updateSettings: async (patch: Partial<AdminKnowledgeSettings>) =>
        parseAdminSettings(
          await client.request('PATCH', `${k}/settings`, patch)
        ),
    };
  };
  return {
    site,
    admin,
    /**
     * Подключить помощника к сайту (ТЗ §3.1 «Подключить Помощника»). Только
     * по действию человека: сервер на каждом вызове просит initial-обход.
     */
    enable: async (siteId: string) =>
      parseSettings(
        await client.request('POST', `/assist/sites/${enc(siteId)}/enable`)
      ),
    urlPreview: async (url: string) =>
      parseUrlPreview(
        await client.request('POST', '/assist/url-preview', { url })
      ),
    sandbox: async (siteId: string) =>
      parseSandbox(
        await client.request('GET', `/assist/sites/${enc(siteId)}/sandbox`)
      ),
    createSandbox: async (siteId: string) =>
      parseSandbox(
        await client.request('POST', `/assist/sites/${enc(siteId)}/sandbox`)
      ),
    sandboxChat: async (siteId: string, question: string) =>
      parseSandboxAnswer(
        await client.request(
          'POST',
          `/assist/sites/${enc(siteId)}/sandbox/chat`,
          { question }
        )
      ),
    transferSandbox: async (sandboxId: string) =>
      parseTransfer(
        await client.request(
          'POST',
          `/assist/sandbox/${enc(sandboxId)}/transfer`
        )
      ),
  };
}

export type KnowledgeApi = ReturnType<typeof createKnowledgeApi>;
export type SiteKnowledgeClient = ReturnType<KnowledgeApi['site']>;
export type AdminKnowledgeClient = ReturnType<KnowledgeApi['admin']>;
