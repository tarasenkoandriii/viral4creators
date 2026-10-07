/**
 * Э-С Ш5: база знаний из кода генератора → документы базы знаний тенанта
 * «viral4creators» в sites-backend (системный API знаний, модуль
 * `sites-backend/src/modules/assist-site-knowledge-api`). ЧИСТАЯ часть:
 * какие документы, проверка «без секретов и ПДн», подпись, план, прогон с
 * подменяемой сетью. Запуск — `npm run assist:knowledge-sync`
 * (`scripts/sync-assistant-knowledge.ts`), по умолчанию — сухой прогон.
 *
 *  - документ на локаль: `gen-kb-<локаль>` — тот же markdown, что видит
 *    старый консультант (`ASSISTANT_KNOWLEDGE`), БЕЗ строки-штампа «Собрано
 *    автоматически <дата> … коммит — <sha>»: штамп меняется на каждой
 *    сборке, и каждая синхронизация была бы новой версией знаний с новыми
 *    эмбеддингами вместо `unchanged`;
 *  - перед отправкой — проверка утечек: формы секретов (те же правила,
 *    что у сервера, плюс ключи платформы и внутренние адреса — аудит Ш5;
 *    и в нормализованном виде) и ПДн (почта, телефон, номер карты по Луну,
 *    IBAN). Хоть одна находка — НИЧЕГО не отправляется
 *    (код выхода 1): база собирается из словарей и констант, ПДн и ключей
 *    в ней быть не должно, а находка значит, что их туда занесли;
 *  - подпись — `t=…,v1=hex HMAC(ключ, "<t>.<МЕТОД>.<siteId>.<ключ>.<тело>")`
 *    (общий вектор с сервером в спеках обеих сторон);
 *  - удаляются только «свои» документы (префикс `gen-`), которых больше нет
 *    в коде: документы, опубликованные в тенант иначе, не трогаются.
 */
import { createHash, createHmac } from 'crypto';

export const SYNC_KEY_PREFIX = 'gen-';
export const SYNC_SIGNATURE_HEADER = 'X-Assist-Signature';
/** Потолок текста документа у сервера (KNOWLEDGE_API_DEFAULTS.contentMaxBytes). */
export const SYNC_CONTENT_MAX_BYTES = 96 * 1024;

export interface SyncDocument {
  key: string;
  title: string;
  lang: string;
  format: 'markdown';
  content: string;
  /** Страница лендинга этой локали (ссылка-источник в ответе виджета) или null. */
  url: string | null;
}

/** Строка-штамп сборки из шапки базы (дата и коммит меняются САМИ). */
const STAMP_LINE = /^_.*\d{4}-\d{2}-\d{2}.*_\s*$/;

export function stripBuildStamp(md: string): string {
  const lines = md.split('\n');
  // Только в шапке (первые 5 строк): ниже такой строки быть не может, а
  // курсив с датой в теле — содержание, его не трогаем.
  const i = lines.slice(0, 5).findIndex((l) => STAMP_LINE.test(l));
  if (i < 0) return md;
  lines.splice(i, lines[i + 1] === '' ? 2 : 1);
  return lines.join('\n');
}

/** Документы синхронизации из базы по локалям (`ASSISTANT_KNOWLEDGE`). */
/**
 * `pageBase` — публичный адрес лендинга (`LANDING_PUBLIC_URL`, только https):
 * документ локали ссылается на `<origin>/<локаль>` — sites-backend примет
 * адрес, только если хост подтверждён у сайта тенанта.
 */
export function landingPageBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' && !u.username && !u.password
      ? u.origin
      : null;
  } catch {
    return null;
  }
}

// ── «Открыть приложение» (Ш5 (6), Р-Ш5-13) ────────────────────────────

/**
 * Страница лендинга `/<локаль>/open` (`landing/src/app/[locale]/open`):
 * «Открыть в Telegram» и браузер. Прямой `t.me` виджет платформы выдать не
 * может — фильтр ссылок пускает только хосты сайта, — поэтому действие
 * «открыть приложение» (`open-app` старого консультанта) — ссылка на эту
 * страницу. Ссылку виджет берёт из атрибута `url` фрагмента знаний, отсюда
 * отдельный короткий документ на локаль с `url` этой страницы: на вопросы
 * «как открыть / где бот / как начать» поиск находит его, и кнопка ведёт
 * на страницу-переход, а не на главную.
 */
export const OPEN_APP_PATH = 'open';
export const OPEN_APP_KEY_PREFIX = `${SYNC_KEY_PREFIX}open-`;

const OPEN_APP_DOCS: Readonly<
  Record<string, { title: string; content: string }>
> = {
  ru: {
    title: 'Как открыть приложение viral4creators',
    content: [
      '# Как открыть приложение viral4creators',
      '',
      'viral4creators работает в двух местах с одинаковыми возможностями: как мини-апп внутри Telegram и как обычный сайт в браузере. Скачивать и устанавливать ничего не нужно.',
      '',
      'Открыть приложение — на странице «Открыть viral4creators»: кнопка «Открыть в Telegram» запускает мини-апп в Telegram, кнопка «Открыть в браузере» — тот же продукт в браузере, сразу с формой нового ролика.',
      '',
      'Как начать, где бот, как запустить мини-апп, как попасть в приложение — всё это та же страница.',
    ].join('\n'),
  },
  uk: {
    title: 'Як відкрити застосунок viral4creators',
    content: [
      '# Як відкрити застосунок viral4creators',
      '',
      'viral4creators працює у двох місцях з однаковими можливостями: як міні-застосунок у Telegram і як звичайний сайт у браузері. Завантажувати й встановлювати нічого не потрібно.',
      '',
      'Відкрити застосунок — на сторінці «Відкрити viral4creators»: кнопка «Відкрити в Telegram» запускає міні-застосунок у Telegram, кнопка «Відкрити в браузері» — той самий продукт у браузері, одразу з формою нового ролика.',
      '',
      'Як почати, де бот, як запустити міні-застосунок, як потрапити в застосунок — усе це та сама сторінка.',
    ].join('\n'),
  },
  en: {
    title: 'How to open the viral4creators app',
    content: [
      '# How to open the viral4creators app',
      '',
      'viral4creators runs in two places with the same features: as a Mini App inside Telegram and as a regular website in your browser. There is nothing to download or install.',
      '',
      'Open the app on the "Open viral4creators" page: the "Open in Telegram" button launches the Mini App in Telegram, and "Open in browser" opens the same product in your browser, right at the new video form.',
      '',
      'How to start, where the bot is, how to launch the Mini App, how to get into the app — it is all the same page.',
    ].join('\n'),
  },
  de: {
    title: 'So öffnen Sie die App viral4creators',
    content: [
      '# So öffnen Sie die App viral4creators',
      '',
      'viral4creators läuft an zwei Orten mit denselben Funktionen: als Mini App in Telegram und als normale Website im Browser. Sie müssen nichts herunterladen oder installieren.',
      '',
      'Die App öffnen Sie auf der Seite „viral4creators öffnen“: Die Schaltfläche „In Telegram öffnen“ startet die Mini App in Telegram, „Im Browser öffnen“ dasselbe Produkt im Browser, direkt mit dem Formular für ein neues Video.',
      '',
      'Wie man anfängt, wo der Bot ist, wie man die Mini App startet, wie man in die App kommt — das ist alles dieselbe Seite.',
    ].join('\n'),
  },
  es: {
    title: 'Cómo abrir la app viral4creators',
    content: [
      '# Cómo abrir la app viral4creators',
      '',
      'viral4creators funciona en dos lugares con las mismas funciones: como Mini App dentro de Telegram y como sitio web normal en el navegador. No hay que descargar ni instalar nada.',
      '',
      'Abre la app en la página «Abrir viral4creators»: el botón «Abrir en Telegram» inicia la Mini App en Telegram y «Abrir en el navegador» abre el mismo producto en el navegador, directamente en el formulario de un nuevo vídeo.',
      '',
      'Cómo empezar, dónde está el bot, cómo iniciar la Mini App, cómo entrar en la app: todo es la misma página.',
    ].join('\n'),
  },
};

/**
 * Документы «Открыть приложение» локалей базы. Только с адресом лендинга:
 * без `url` документ не дал бы кнопки — ради неё он и есть.
 */
export function buildOpenAppDocuments(
  locales: readonly string[],
  pageBase: string | null,
): SyncDocument[] {
  if (!pageBase) return [];
  return [...locales]
    .sort()
    .filter((l) => OPEN_APP_DOCS[l])
    .map((locale) => ({
      key: `${OPEN_APP_KEY_PREFIX}${locale}`,
      title: `${OPEN_APP_DOCS[locale].title} (${locale})`.slice(0, 200),
      lang: locale,
      format: 'markdown' as const,
      content: OPEN_APP_DOCS[locale].content.trim() + '\n',
      url: `${pageBase}/${locale}/${OPEN_APP_PATH}`,
    }));
}

/**
 * Документы синхронизации: база локали (`gen-kb-<локаль>`, ссылка — главная
 * локали) и, при адресе лендинга, «Открыть приложение»
 * (`gen-open-<локаль>`, ссылка — `/<локаль>/open`).
 */
export function buildSyncDocuments(
  knowledge: Record<string, string>,
  pageBase: string | null = null,
): SyncDocument[] {
  return [
    ...buildKnowledgeDocuments(knowledge, pageBase),
    ...buildOpenAppDocuments(Object.keys(knowledge), pageBase),
  ];
}

function buildKnowledgeDocuments(
  knowledge: Record<string, string>,
  pageBase: string | null,
): SyncDocument[] {
  return Object.keys(knowledge)
    .sort()
    .map((locale) => {
      const content = stripBuildStamp(knowledge[locale]).trim() + '\n';
      const h1 = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
      return {
        key: `${SYNC_KEY_PREFIX}kb-${locale}`,
        title: `${h1 || 'viral4creators'} (${locale})`.slice(0, 200),
        lang: locale,
        format: 'markdown' as const,
        content,
        url: pageBase ? `${pageBase}/${locale}` : null,
      };
    });
}

// ── Проверка утечек ─────────────────────────────────────────────────────

const SECRET_RULES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'api-key-sk', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/ },
  { name: 'stripe-key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'aws-access-key', re: /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/ },
  {
    name: 'github-token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'telegram-bot-token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  {
    name: 'platform-secret',
    re: /\b(?:whsec|idsec|knsec)_[A-Za-z0-9_-]{20,}/,
  },
  { name: 'vercel-blob-token', re: /\bvercel_blob_rw_[A-Za-z0-9_]{10,}/ },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  {
    name: 'credentialed-url',
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{1,128}@/i,
  },
  // Генератор: публичный ключ виджета и ключ env вида NAME=значение.
  { name: 'widget-public-key', re: /\bpk_(?:live|test)_[0-9A-Za-z]{24}\b/ },
  {
    name: 'env-assignment',
    re: /\b[A-Z][A-Z0-9_]{2,}(?:KEY|SECRET|TOKEN|PASSWORD|DSN)\s*=\s*\S{6,}/,
  },
  // Аудит Ш5: внутренние адреса (стенд, частная сеть, служебные зоны,
  // превью-сборки Vercel, проект Supabase) — посетителю они не нужны, а
  // попасть в базу могут из словаря или константы.
  {
    name: 'internal-url',
    re: /\b(?:https?|wss?|postgres(?:ql)?|redis):\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9.-]+\.(?:internal|local|lan|localhost))(?![a-z0-9-])/i,
  },
  {
    name: 'vercel-preview-host',
    re: /\b[a-z0-9-]+-git-[a-z0-9-]+\.vercel\.app\b/i,
  },
  {
    name: 'supabase-project-host',
    re: /\b[a-z0-9]{20}\.supabase\.(?:co|in)\b/i,
  },
];

const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
/** Телефон: +код и ≥ 9 цифр с разделителями, или 10+ цифр подряд с разделителями. */
const PHONE =
  /(?:\+\d[\d\s().-]{8,}\d)|(?:\b\d{3}[\s.-]\d{3}[\s.-]\d{2}[\s.-]?\d{2}\b)/;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[0-9A-Z]{4}){3,7}\b/;
const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Аудит Ш5: те же формы, что у сервера (`secretScanForms` в
 * sites-backend `knowledge-api.ts`): NFKC, без невидимых символов формата
 * (\p{Cf}), с раскрытыми %XX и числовыми HTML-сущностями — иначе
 * `sk-` + U+200B + хвост прошёл бы проверку, а модель пересказала бы ключ.
 */
export function leakScanForms(text: string): string[] {
  let n = text.normalize('NFKC').replace(/\p{Cf}/gu, '');
  n = n.replace(/&#(x[0-9a-f]{1,6}|\d{1,7});?/gi, (m, v: string) => {
    const cp =
      v[0] === 'x' || v[0] === 'X' ? parseInt(v.slice(1), 16) : Number(v);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
  n = n.replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
  n = n.normalize('NFKC').replace(/\p{Cf}/gu, '');
  return n === text ? [text] : [text, n];
}

/** Имена сработавших правил (секреты и ПДн) — без самих совпадений. */
export function findKnowledgeLeaks(text: string): string[] {
  const forms = leakScanForms(text);
  if (forms.length > 1) {
    return [...new Set(forms.flatMap((f) => findKnowledgeLeaksIn(f)))];
  }
  return findKnowledgeLeaksIn(text);
}

function findKnowledgeLeaksIn(text: string): string[] {
  const out: string[] = [];
  for (const r of SECRET_RULES) if (r.re.test(text)) out.push(r.name);
  if (EMAIL.test(text)) out.push('email');
  if (PHONE.test(text)) out.push('phone');
  if (IBAN.test(text)) out.push('iban');
  for (const m of text.match(CARD_CANDIDATE) ?? []) {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      out.push('card-number');
      break;
    }
  }
  return out;
}

// ── Подпись (вектор — общий с sites-backend) ─────────────────────────────

export type SyncMethod = 'GET' | 'PUT' | 'DELETE';

export function signKnowledgeRequest(
  secret: string,
  req: { method: SyncMethod; siteId: string; key: string; rawBody: string },
  unixSec: number,
): string {
  const t = Math.floor(unixSec);
  const v1 = createHmac('sha256', secret)
    .update(
      `${t}.${req.method}.${req.siteId}.${req.key}.${req.rawBody}`,
      'utf8',
    )
    .digest('hex');
  return `t=${t},v1=${v1}`;
}

// ── План и прогон ───────────────────────────────────────────────────────

export interface SyncConfig {
  origin: string;
  siteId: string;
  secret: string;
}

/** Конфиг из env; чего не хватает — список имён (секрет в ответ не идёт). */
export function syncConfigFromEnv(
  env: NodeJS.ProcessEnv,
): { ok: true; config: SyncConfig } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  let origin: string | null = null;
  const raw = env.SITES_BACKEND_URL?.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' || u.hostname === 'localhost') {
        origin = u.origin;
      }
    } catch {
      origin = null;
    }
  }
  if (!origin) missing.push('SITES_BACKEND_URL');
  const siteId = env.ASSIST_LANDING_SITE_ID?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(siteId)) {
    missing.push('ASSIST_LANDING_SITE_ID');
  }
  const secret = env.ASSIST_KNOWLEDGE_API_KEY?.trim() ?? '';
  if (!/^knsec_[A-Za-z0-9_-]{20,}$/.test(secret)) {
    missing.push('ASSIST_KNOWLEDGE_API_KEY');
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, config: { origin: origin as string, siteId, secret } };
}

export function planSync(
  local: SyncDocument[],
  remoteKeys: string[],
): { put: SyncDocument[]; remove: string[] } {
  const keep = new Set(local.map((d) => d.key));
  return {
    put: local,
    remove: remoteKeys
      .filter((k) => k.startsWith(SYNC_KEY_PREFIX) && !keep.has(k))
      .sort(),
  };
}

export function contentSha(doc: SyncDocument): string {
  return createHash('sha256')
    .update(JSON.stringify([doc.title, doc.lang, doc.content, doc.url]), 'utf8')
    .digest('hex');
}

export interface SyncReport {
  applied: boolean;
  /** Документы и их проверка — и в сухом прогоне. */
  documents: Array<{ key: string; bytes: number; sha: string }>;
  leaks: Array<{ key: string; rules: string[] }>;
  results: Array<{ key: string; status: string }>;
  removed: string[];
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/**
 * Прогон. Утечка или слишком большой документ — исключение ДО любого
 * сетевого вызова. `apply: false` — только проверка и отчёт.
 */
export async function runKnowledgeSync(p: {
  docs: SyncDocument[];
  apply: boolean;
  config?: SyncConfig;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<SyncReport> {
  const report: SyncReport = {
    applied: false,
    documents: p.docs.map((d) => ({
      key: d.key,
      bytes: Buffer.byteLength(d.content, 'utf8'),
      sha: contentSha(d),
    })),
    leaks: [],
    results: [],
    removed: [],
  };
  for (const d of p.docs) {
    const rules = findKnowledgeLeaks(`${d.title}\n${d.content}`);
    if (rules.length) report.leaks.push({ key: d.key, rules });
  }
  if (report.leaks.length) {
    throw Object.assign(
      new SyncError(
        `в документах найдено похожее на секреты/ПДн: ${report.leaks
          .map((l) => `${l.key} (${l.rules.join(', ')})`)
          .join('; ')} — ничего не отправлено`,
      ),
      { report },
    );
  }
  const big = report.documents.find((d) => d.bytes > SYNC_CONTENT_MAX_BYTES);
  if (big) {
    throw new SyncError(
      `${big.key}: ${big.bytes} байт — больше потолка API (${SYNC_CONTENT_MAX_BYTES})`,
    );
  }
  if (!p.apply) return report;
  if (!p.config || !p.fetchImpl) {
    throw new SyncError('нет конфигурации или сети для --apply');
  }
  const { origin, siteId, secret } = p.config;
  const now = p.now ?? (() => Date.now() / 1000);
  const base = `${origin}/assist/v1/sites/${encodeURIComponent(siteId)}/knowledge/site/documents`;
  const call = async (
    method: SyncMethod,
    key: string,
    body: string,
  ): Promise<unknown> => {
    const headers: Record<string, string> = {
      [SYNC_SIGNATURE_HEADER]: signKnowledgeRequest(
        secret,
        { method, siteId, key, rawBody: body },
        now(),
      ),
    };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await p.fetchImpl!(
      key ? `${base}/${encodeURIComponent(key)}` : base,
      { method, headers, ...(body ? { body } : {}) },
    );
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      // Тело ошибки — код и сообщение сервера (секретов в нём нет).
      throw new SyncError(
        `${method} ${key || '(список)'}: HTTP ${res.status} ${text.slice(0, 300)}`,
        res.status,
      );
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    // Конверт sites-backend: { success, data } — или голое тело.
    const o = parsed as { data?: unknown } | null;
    return o && typeof o === 'object' && 'data' in o ? o.data : parsed;
  };

  const listed = (await call('GET', '', '')) as {
    documents?: Array<{ key?: unknown }>;
  } | null;
  const remoteKeys = (listed?.documents ?? [])
    .map((d) => d.key)
    .filter((k): k is string => typeof k === 'string');
  const plan = planSync(p.docs, remoteKeys);
  for (const d of plan.put) {
    const body = JSON.stringify({
      title: d.title,
      lang: d.lang,
      format: d.format,
      content: d.content,
      ...(d.url ? { url: d.url } : {}),
    });
    const r = (await call('PUT', d.key, body)) as { status?: unknown } | null;
    report.results.push({
      key: d.key,
      status: typeof r?.status === 'string' ? r.status : 'unknown',
    });
  }
  for (const key of plan.remove) {
    await call('DELETE', key, '');
    report.removed.push(key);
  }
  report.applied = true;
  return report;
}
