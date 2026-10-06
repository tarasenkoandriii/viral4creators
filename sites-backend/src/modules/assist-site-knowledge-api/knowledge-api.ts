/**
 * Системный API знаний сайта — Э-С Ш5 (аудит слияния §3.3 «Ш5» п.2):
 * ЧИСТЫЙ модуль (без базы и Nest) — подпись, разбор тела, ключ документа,
 * фильтр «похоже на секрет».
 *
 * Зачем: консультант лендинга viral4creators переезжает в виджет
 * платформы, а его база знаний собирается из КОДА генератора
 * (`backend/scripts/build-assistant-knowledge.ts`). Код публикует её не в
 * свой `generated.ts`, а документами в базу знаний тенанта — тем же
 * конвейером, что файлы владельца (ворота версии, карантин инъекций).
 *
 * Подлинность — ключ интеграции сайта `knsec_…` (assist_site_integrations,
 * выпуск/отзыв — владелец кабинета в TMA, показ один раз). Ключ по сети не
 * ходит: запрос подписан HMAC-SHA256, заголовок — тот же
 * `X-Assist-Signature` (brand.ts), что у вебхука целей:
 *   `t=<unix секунды>,v1=<hex HMAC(ключ, "<t>.<МЕТОД>.<siteId>.<key>.<сырое тело>")>`
 * Метод, сайт и ключ документа — внутри подписи: подпись PUT одного
 * документа не годится ни для DELETE, ни для другого документа, ни для
 * другого сайта. Окно ±5 мин. Аудит Ш5 (05.10.2026): повтор внутри окна
 * НЕ безвреден — перехваченный старый PUT, присланный после нового,
 * откатил бы текст, а старый DELETE снёс бы пересозданный документ. Поэтому
 * изменяющий запрос (PUT/DELETE) принимается ОДИН раз: отпечаток
 * `knowledgeRequestDigest` (детерминированный HMAC запроса — лишний `v1` в
 * заголовке его не меняет) помнится до конца окна, повтор — 409
 * `KNOWLEDGE_API_REPLAY`; повторная отправка — с новой подписью. Путь
 * (префикс прокси) в подпись не входит намеренно: за Vercel/Traefik он
 * может отличаться.
 *
 * Фильтр «похоже на секрет» — последняя линия: генератор сам проверяет
 * свои документы (ключи и ПДн) до отправки; сервер отказывает документу,
 * в котором есть токены/ключи/закрытые ключи/строки подключения с
 * паролем, — для ЛЮБОГО тенанта (ПДн не режем: контакты компании в
 * документах владельца законны).
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const KNOWLEDGE_API_DEFAULTS = {
  /** Сырое тело запроса (JSON с markdown внутри). */
  bodyMaxBytes: 128 * 1024,
  /** Текст документа (UTF-8). База одной локали генератора — ≤ 40 КБ. */
  contentMaxBytes: 96 * 1024,
  titleMax: 200,
  /** Запросов в минуту на сайт (PUT/DELETE/GET вместе). */
  ratePerMinute: 60,
  /**
   * Аудит Ш5: изменений (создан/изменён/удалён — то, что публикует версию
   * знаний) на сайт в сутки UTC. Каждая версия — проход по фрагментам
   * сайта и смена ключа семантического кэша (ответы посетителям снова
   * платные), а 60 запросов в минуту — это 86 400 версий в сутки.
   * Генератор шлёт ≤ 5 документов на пуш, `unchanged` не считается.
   */
  changesPerDay: 200,
  signatureWindowSec: 300,
} as const;

/** Ключ документа: латиница, цифры, `.`, `_`, `-`; 1–80; не с точки. */
export const KNOWLEDGE_API_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const SITE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LANG = /^[a-z]{2}$/;

export function validSiteId(v: unknown): v is string {
  return typeof v === 'string' && SITE_ID.test(v);
}

export function validDocumentKey(v: unknown): v is string {
  return typeof v === 'string' && KNOWLEDGE_API_KEY.test(v);
}

export type KnowledgeApiMethod = 'GET' | 'PUT' | 'DELETE';

function payload(
  t: number,
  method: KnowledgeApiMethod,
  siteId: string,
  key: string,
  rawBody: string,
): string {
  return `${t}.${method}.${siteId}.${key}.${rawBody}`;
}

/** Подпись запроса (её же собирает `backend/…/knowledge-sync.ts`). */
export function signKnowledgeApiRequest(
  secret: string,
  req: {
    method: KnowledgeApiMethod;
    siteId: string;
    key: string;
    rawBody: string;
  },
  unixSec: number,
): string {
  const t = Math.floor(unixSec);
  const v1 = createHmac('sha256', secret)
    .update(payload(t, req.method, req.siteId, req.key, req.rawBody), 'utf8')
    .digest('hex');
  return `t=${t},v1=${v1}`;
}

/**
 * Отпечаток запроса для защиты от повтора: hex HMAC того же содержимого,
 * что подписано, с меткой времени из заголовка. Зовётся ПОСЛЕ успешной
 * проверки подписи (метка там уже разобрана и в окне); заголовок без
 * метки — null.
 */
export function knowledgeRequestDigest(
  secret: string,
  req: {
    method: KnowledgeApiMethod;
    siteId: string;
    key: string;
    rawBody: string;
  },
  header: string | undefined,
): { t: number; digest: string } | null {
  const h = parseSignatureHeader(header);
  if (typeof h === 'string') return null;
  const t = h.t;
  const digest = createHmac('sha256', secret)
    .update(payload(t, req.method, req.siteId, req.key, req.rawBody), 'utf8')
    .digest('hex');
  return { t, digest };
}

export type KnowledgeSignatureCheck =
  'ok' | 'missing' | 'malformed' | 'stale' | 'mismatch';

/** Разбор `t=…,v1=…[,v1=…]` — общий для проверки и отпечатка повтора. */
function parseSignatureHeader(
  header: string | undefined,
): { t: number; sigs: string[] } | 'missing' | 'malformed' {
  if (!header || !header.trim()) return 'missing';
  if (header.length > 600) return 'malformed';
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) return 'malformed';
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') {
      if (!/^\d{1,12}$/.test(v) || t !== null) return 'malformed';
      t = Number(v);
    } else if (k === 'v1') {
      if (!/^[0-9a-f]{64}$/.test(v)) return 'malformed';
      sigs.push(v);
    }
  }
  if (t === null || !sigs.length) return 'malformed';
  return { t, sigs };
}

export function verifyKnowledgeApiRequest(
  secret: string,
  req: {
    method: KnowledgeApiMethod;
    siteId: string;
    key: string;
    rawBody: string;
  },
  header: string | undefined,
  nowSec: number,
): KnowledgeSignatureCheck {
  const h = parseSignatureHeader(header);
  if (typeof h === 'string') return h;
  const { t, sigs } = h;
  if (Math.abs(nowSec - t) > KNOWLEDGE_API_DEFAULTS.signatureWindowSec) {
    return 'stale';
  }
  const expected = createHmac('sha256', secret)
    .update(payload(t, req.method, req.siteId, req.key, req.rawBody), 'utf8')
    .digest();
  return sigs.some((s) => timingSafeEqual(Buffer.from(s, 'hex'), expected))
    ? 'ok'
    : 'mismatch';
}

export interface KnowledgeApiDocument {
  title: string;
  lang: string | null;
  format: 'markdown' | 'text';
  content: string;
  /**
   * Страница сайта, о которой документ (необязательно): https на
   * подтверждённом хосте этого сайта — проверяет сервис. Даёт ссылку-
   * источник и действие `link` в ответе виджета.
   */
  url: string | null;
}

export type BodyParse =
  | { ok: true; doc: KnowledgeApiDocument }
  | {
      ok: false;
      reason: 'json' | 'shape' | 'title' | 'content' | 'too_large' | 'url';
    };

const BODY_KEYS = new Set(['title', 'lang', 'format', 'content', 'url']);

/** https без учётных данных, порта и фрагмента; длина ≤ 2000. */
export function documentUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  u.hash = '';
  return u;
}

/** Тело PUT: белый список полей, длины, формат. */
export function parseKnowledgeApiBody(raw: string): BodyParse {
  if (Buffer.byteLength(raw, 'utf8') > KNOWLEDGE_API_DEFAULTS.bodyMaxBytes) {
    return { ok: false, reason: 'too_large' };
  }
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return { ok: false, reason: 'shape' };
  }
  const b = o as Record<string, unknown>;
  if (Object.keys(b).some((k) => !BODY_KEYS.has(k))) {
    return { ok: false, reason: 'shape' };
  }
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (
    !title ||
    title.length > KNOWLEDGE_API_DEFAULTS.titleMax ||
    /[\u0000-\u001f\u007f]/.test(title)
  ) {
    return { ok: false, reason: 'title' };
  }
  let lang: string | null = null;
  if (b.lang !== undefined && b.lang !== null) {
    if (typeof b.lang !== 'string' || !LANG.test(b.lang)) {
      return { ok: false, reason: 'shape' };
    }
    lang = b.lang;
  }
  const format = b.format === undefined ? 'markdown' : b.format;
  if (format !== 'markdown' && format !== 'text') {
    return { ok: false, reason: 'shape' };
  }
  if (typeof b.content !== 'string' || !b.content.trim()) {
    return { ok: false, reason: 'content' };
  }
  if (
    Buffer.byteLength(b.content, 'utf8') >
    KNOWLEDGE_API_DEFAULTS.contentMaxBytes
  ) {
    return { ok: false, reason: 'too_large' };
  }
  let url: string | null = null;
  if (b.url !== undefined && b.url !== null) {
    const u = documentUrl(b.url);
    if (!u) return { ok: false, reason: 'url' };
    url = u.toString();
  }
  return { ok: true, doc: { title, lang, format, content: b.content, url } };
}

/**
 * Узнаваемые формы секретов — имя правила, без самого совпадения (в
 * ответ и лог секрет не попадает). Общий список с генератором
 * (`backend/src/common/tutorial-knowledge/knowledge-sync.ts`, там ещё ПДн).
 */
export const SECRET_LIKE_RULES: ReadonlyArray<{ name: string; re: RegExp }> = [
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
  { name: 'platform-secret', re: /\b(?:whsec|idsec|knsec)_[A-Za-z0-9_-]{20,}/ },
  { name: 'vercel-blob-token', re: /\bvercel_blob_rw_[A-Za-z0-9_]{10,}/ },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  {
    name: 'credentialed-url',
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{1,128}@/i,
  },
];

/**
 * Аудит Ш5: обход фильтра кодировками. Модель читает текст «насквозь»:
 * `sk-` + U+200B + хвост, полноширинные `ｓｋ－…`, `%73k-…` или `&#115;k-…`
 * она перескажет посетителю как ключ, а регулярка мимо. Поэтому проверяется
 * и нормализованный вид: NFKC, без невидимых символов формата (\p{Cf}:
 * нулевой ширины, мягкий перенос, BOM, направляющие), с раскрытыми
 * %XX и числовыми HTML-сущностями. base64 целиком не раскрывается —
 * произвольный base64 не отличить от данных (хвост в отчёте аудита).
 */
export function secretScanForms(text: string): string[] {
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

/** Имя первого сработавшего правила или null. */
export function findSecretLike(text: string): string | null {
  for (const form of secretScanForms(text)) {
    for (const r of SECRET_LIKE_RULES) if (r.re.test(form)) return r.name;
  }
  return null;
}
