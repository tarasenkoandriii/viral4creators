/**
 * AI Publisher, P-R — нормализация имени сообщества и URL треда Reddit
 * (reddit-manual-mvp-adapted.md §M1.1, §M1.2; A05, A15). Чистый модуль:
 * сети нет и быть не может (Р-RD-0) — короткие ссылки `redd.it/…` и
 * share-ссылки `/r/<name>/s/<code>` не разворачиваются, а отклоняются.
 *
 * Канон:
 *  - сообщество — `^[a-z0-9_]{2,21}$` в нижнем регистре, URL
 *    `https://www.reddit.com/r/<name>` (без завершающего `/`, как требует
 *    `canonicalUrl()` и триггер `pub_publications.finalUrl`);
 *  - тред — `https://www.reddit.com/r/<name>/comments/<id36>[/<slug>]` без
 *    `/` в конце, query и fragment; `threadKey` = `<id36>`.
 * Совпадает с проверками триггеров `pub_reddit_communities_guard` и
 * `pub_reddit_opportunities_guard`.
 */

export const SUBREDDIT_RE = /^[a-z0-9_]{2,21}$/;
/** `r/u_<ник>` — страница профиля, не сообщество (аудит P-R S3-2). */
const PROFILE_SUBREDDIT_RE = /^u_/;
export const THREAD_KEY_RE = /^[a-z0-9]{1,13}$/;
const SLUG_RE = /^[^/?#\s]{1,300}$/;

/** Хосты, которые принимаются во ВВОДЕ (в канон всегда идёт `www.`). */
export const REDDIT_INPUT_HOSTS = [
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
  'sh.reddit.com',
] as const;

export const REDDIT_CANONICAL_ORIGIN = 'https://www.reddit.com';

export function canonicalCommunityUrl(name: string): string {
  return `${REDDIT_CANONICAL_ORIGIN}/r/${name}`;
}

/** URL из ввода: `https://…` или без схемы (`www.reddit.com/…`); `http:` — нет. */
function parseRedditUrl(input: string): URL | null {
  const raw = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https:\/\//i.test(raw)) {
    return null;
  }
  let u: URL;
  try {
    u = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return (REDDIT_INPUT_HOSTS as readonly string[]).includes(host) ? u : null;
}

function pathParts(u: URL): string[] {
  return u.pathname.split('/').filter((x) => x !== '');
}

/**
 * Имя сообщества из `r/Name`, `/r/name`, `name` или URL сообщества
 * (`https://www|old|new|m.reddit.com/r/name/…`). `null` — не сообщество.
 */
export function normalizeSubreddit(input: unknown): string | null {
  const n = subredditCandidate(input);
  return n !== null && !PROFILE_SUBREDDIT_RE.test(n) ? n : null;
}

/**
 * Код поля для ввода сообщества (UI-аудит S3-2, стабильный контракт):
 * `null` — принято; `profile_ref` — это профиль `r/u_<ник>` (в т. ч. URL);
 * `format` — не сообщество.
 */
export function subredditIssue(
  input: unknown,
): 'format' | 'profile_ref' | null {
  const n = subredditCandidate(input);
  if (n === null) return 'format';
  return PROFILE_SUBREDDIT_RE.test(n) ? 'profile_ref' : null;
}

/** Имя по форме сообщества (без проверки `u_*`). */
function subredditCandidate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw === '' || raw.length > 300) return null;
  let name: string | null = null;
  if (/reddit\.com/i.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    const u = parseRedditUrl(raw);
    if (!u) return null;
    const parts = pathParts(u);
    if (parts.length < 2 || parts[0].toLowerCase() !== 'r') return null;
    name = parts[1];
  } else {
    const m = /^\/?r\/([^/\s]+)\/?$/i.exec(raw) ?? /^([^/\s]+)$/.exec(raw);
    name = m ? m[1] : null;
  }
  if (name === null) return null;
  const n = name.toLowerCase();
  return SUBREDDIT_RE.test(n) ? n : null;
}

export interface NormalizedThread {
  /** Канонический URL треда. */
  url: string;
  subreddit: string;
  /** `<id36>` поста. */
  threadKey: string;
}

/**
 * URL треда → канон. Принимается `/r/<name>/comments/<id36>[/<slug>[/…]]`
 * (хвост после slug — ссылка на комментарий — отбрасывается). `null` —
 * не URL треда (короткие и share-ссылки, `http:`, чужой хост, профиль).
 */
export function normalizeThreadUrl(input: unknown): NormalizedThread | null {
  const t = threadCandidate(input);
  return t && !PROFILE_SUBREDDIT_RE.test(t.subreddit) ? t : null;
}

/** Код поля для URL треда: `profile_ref` — тред в профиле `r/u_<ник>`. */
export function threadUrlIssue(
  input: unknown,
): 'format' | 'profile_ref' | null {
  const t = threadCandidate(input);
  if (t === null) return 'format';
  return PROFILE_SUBREDDIT_RE.test(t.subreddit) ? 'profile_ref' : null;
}

function threadCandidate(input: unknown): NormalizedThread | null {
  if (typeof input !== 'string' || input.length > 2048) return null;
  const u = parseRedditUrl(input);
  if (!u) return null;
  const parts = pathParts(u);
  if (parts.length < 4) return null;
  if (parts[0].toLowerCase() !== 'r' || parts[2].toLowerCase() !== 'comments')
    return null;
  const subreddit = parts[1].toLowerCase();
  const threadKey = parts[3].toLowerCase();
  if (!SUBREDDIT_RE.test(subreddit) || !THREAD_KEY_RE.test(threadKey))
    return null;
  let slug: string | null = null;
  if (parts.length >= 5) {
    const s = parts[4].toLowerCase();
    if (!SLUG_RE.test(s)) return null;
    slug = s;
  }
  const url = `${REDDIT_CANONICAL_ORIGIN}/r/${subreddit}/comments/${threadKey}${slug ? `/${slug}` : ''}`;
  return { url, subreddit, threadKey };
}

/**
 * Домены Reddit (сам домен и любые поддомены) для отказа импорта по URL
 * (`reddit_manual_only`). M2 (хвост S3-7): + `reddituploads.com`,
 * `redditmail.com`, `redditinc.com`, `reddit.app.link`, `rdt.li`.
 */
export const REDDIT_HOST_DOMAINS = [
  'reddit.com',
  'redd.it',
  'redditmedia.com',
  'redditstatic.com',
  'reddituploads.com',
  'redditmail.com',
  'redditinc.com',
  'reddit.app.link',
  'rdt.li',
] as const;

/** Хост Reddit (для отказа импорта по URL, `reddit_manual_only`). */
export function isRedditHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return REDDIT_HOST_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Ник или ссылка на профиль Reddit в свободном тексте (§8.2: P-R не хранит
 * ников и ссылок на профили; аудит P-R S3-2, реаудит N-4). Текст приводится
 * к NFKC (полноширинные `／`, `ｕ` → ASCII), невидимые символы убираются,
 * похожие на `/` знаки (`∕ ⁄ ⧸ ╱ ⟋ …`, которые NFKC не меняет) заменяются
 * на `/`; затем ищутся `u/<ник>`, `user/<ник>` после любого знака, кроме
 * латинской буквы и цифры (граница слова, в том числе `/u/…`, `see/user/…`,
 * `x_u/…`), `reddit.com/u|user/…` и `r/u_<ник>`. Путь `…/user/<имя>` на
 * любом сайте тоже считается профилем: отличить его от ника нельзя.
 * Нарочно испорченные формы (`u /ник`, `u\/ник`, буквы-двойники) — предел
 * регулярного выражения: их ловит ручная проверка PO (§8.2, Р-RD-42).
 */
const PROFILE_REF_RE =
  /(?<![a-z0-9])(u|user)\/[\w-]{3,20}|reddit\.com\/(u|user)\/|(?<![a-z0-9])r\/u_[\w-]+/i;
/** Знаки, похожие на `/` и не сводимые NFKC (UTS #39 confusables). */
const SLASH_LIKE_RE =
  /[\u2044\u2215\u2571\u27CB\u29F6\u29F8\u2CC6\u3033\u30CE\u31D3\u4E3F\u1735\u2E4A\uFF0F]/g;
/** Невидимые разрывы (мягкий перенос, нулевой ширины, направление). */
const INVISIBLE_RE =
  /[\u00AD\u034F\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Текст в форме для поиска ников (экспорт для тестов). */
export function profileRefForm(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .replace(SLASH_LIKE_RE, '/');
}

export function hasProfileRef(text: string | null | undefined): boolean {
  return typeof text === 'string' && PROFILE_REF_RE.test(profileRefForm(text));
}

/** Нормальная форма ключевого запроса (= `pub_reddit_phrase_norm` базы). */
export function phraseNorm(phrase: string): string {
  return phrase.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Ссылка, о которой сообщает человек (P-R M2, §M2.6 «Отметить опубликованным»). */
export interface ReportedUrl {
  /** Канон: пост — как тред; комментарий — `…/comments/<id36>/comment/<cid>`. */
  url: string;
  subreddit: string;
  threadKey: string;
  /** id36 комментария (ссылка на комментарий) или null (ссылка на пост). */
  commentId: string | null;
}

/**
 * URL опубликованного поста или комментария → канон (A15). Пост —
 * `/r/<name>/comments/<id36>[/<slug>]`; комментарий —
 * `/r/<name>/comments/<id36>/<slug|_|comment>/<cid36>` (вид new reddit
 * `/comment/<cid>` и `/<slug>/comment/<cid>` тоже). Хвост, query, fragment отбрасываются; профиль
 * `r/u_*` → `profile_ref`; прочее → `format`.
 */
export function normalizeReportedUrl(
  input: unknown,
): { ok: ReportedUrl } | { issue: 'format' | 'profile_ref' } {
  if (typeof input !== 'string' || input.length > 2048)
    return { issue: 'format' };
  const u = parseRedditUrl(input);
  if (!u) return { issue: 'format' };
  const parts = pathParts(u);
  if (
    parts.length < 4 ||
    parts[0].toLowerCase() !== 'r' ||
    parts[2].toLowerCase() !== 'comments'
  )
    return { issue: 'format' };
  const subreddit = parts[1].toLowerCase();
  const threadKey = parts[3].toLowerCase();
  if (!SUBREDDIT_RE.test(subreddit) || !THREAD_KEY_RE.test(threadKey))
    return { issue: 'format' };
  if (PROFILE_SUBREDDIT_RE.test(subreddit)) return { issue: 'profile_ref' };
  let commentId: string | null = null;
  if (parts.length >= 6) {
    // Новый вид со slug: `…/comments/<id>/<slug>/comment/<cid>` (замечание
    // экранов M2): «comment» — не id комментария.
    const cidRaw = parts[5].toLowerCase() === 'comment' ? parts[6] : parts[5];
    if (!cidRaw) return { issue: 'format' };
    const cid = cidRaw.toLowerCase();
    if (!THREAD_KEY_RE.test(cid)) return { issue: 'format' };
    commentId = cid;
  }
  const base = `${REDDIT_CANONICAL_ORIGIN}/r/${subreddit}/comments/${threadKey}`;
  if (commentId)
    return {
      ok: {
        url: `${base}/comment/${commentId}`,
        subreddit,
        threadKey,
        commentId,
      },
    };
  const t = normalizeThreadUrl(input);
  if (!t) return { issue: 'format' };
  return { ok: { url: t.url, subreddit, threadKey, commentId: null } };
}
