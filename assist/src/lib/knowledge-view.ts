/**
 * Чистая логика экранов «Знания», «Песочница», онбординга: права, какие
 * кнопки у версии, фаза песочницы, проверка файла до загрузки, разбор
 * списков адресов. Без React — проверяется `scripts/knowledge-view.test.ts`.
 */

import {
  parseHostInput,
  parseStartParam,
  type AccountMember,
  type HostInputError,
} from '../kit';
import type {
  ExclusionKind,
  GateCheck,
  GateReport,
  KnowledgeMode,
  SandboxView,
  VersionView,
} from './knowledge-types';

// ── Вкладки ──────────────────────────────────────────────────────────

/** Вкладки экрана знаний — одинаковые у режимов, данные разные (§4-тер.13). */
export const KNOWLEDGE_TABS = [
  'overview',
  'sources',
  'faq',
  'versions',
  'exclusions',
  'quarantine',
] as const;
export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[number];

export function isKnowledgeTab(v: unknown): v is KnowledgeTab {
  return (
    typeof v === 'string' && (KNOWLEDGE_TABS as readonly string[]).includes(v)
  );
}

export function isKnowledgeMode(v: unknown): v is KnowledgeMode {
  return v === 'site' || v === 'admin';
}

// ── Права (ТЗ §3.2; контракт Э1 §6) ──────────────────────────────────

/**
 * Знания «Сайта»: `assist: manager` (владелец кабинета — manager по
 * умолчанию). Оператор кабинета — нет, что бы ни стояло в productRoles:
 * сервер ответит 403 на всё, и раздел, который всегда падает, хуже
 * отсутствующего.
 */
export function canSiteKnowledge(me: AccountMember): boolean {
  if (me.role === 'operator') return false;
  return me.role === 'owner' || me.productRoles.assist === 'manager';
}

/**
 * «Админка» — ТОЛЬКО `assistAdmin: owner` (К-9). Если сервер уже ответил
 * `adminAvailable` — решает он (это право ЗАПРАШИВАЮЩЕГО); до ответа —
 * то же правило по правам участника.
 */
export function canAdminKnowledge(
  me: AccountMember,
  settings?: { adminAvailable: boolean } | null
): boolean {
  if (me.role === 'operator') return false;
  if (settings) return settings.adminAvailable === true;
  return me.productRoles.assistAdmin === 'owner';
}

/** Перенос песочницы лендинга — владелец или менеджер (контракт Э1 §6). */
export function canTransferSandbox(me: AccountMember): boolean {
  return me.role === 'owner' || me.role === 'manager';
}

/**
 * Песочница кабинета — те же owner|manager кабинета, что и перенос:
 * она создаёт сайт и хост, как `POST /sites` (права маршрута у K3).
 */
export function canUseSandbox(me: AccountMember): boolean {
  return canTransferSandbox(me);
}

// ── Версии базы ──────────────────────────────────────────────────────

export interface VersionActions {
  publish: boolean;
  discard: boolean;
  rollback: boolean;
}

/**
 * Удержанная — «опубликовать как есть» / «отбросить»; откат — только к
 * версии в окне (сервер считает `canRollback`) и не к текущей.
 */
export function versionActions(v: VersionView): VersionActions {
  const held = v.status === 'held';
  return {
    publish: held,
    discard: held,
    rollback: v.canRollback && !v.isPublished && !held,
  };
}

export type VersionTone = 'success' | 'warning' | 'neutral' | 'accent';

export function versionTone(v: VersionView): VersionTone {
  if (v.isPublished) return 'success';
  if (v.status === 'held') return 'warning';
  if (v.status === 'building' || v.status === 'checking') return 'accent';
  return 'neutral';
}

/** Ключ подписи статуса: текущая опубликованная отличается от прежних. */
export function versionLabelKey(
  v: VersionView
): VersionView['status'] | 'current' {
  return v.isPublished ? 'current' : v.status;
}

export function versionStats(v: VersionView): {
  added: number;
  removed: number;
  changed: number;
  chunks: number;
} {
  const n = (x: unknown) =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
  return {
    added: n(v.stats.added),
    removed: n(v.stats.removed),
    changed: n(v.stats.changed),
    chunks: n(v.stats.chunks),
  };
}

/** Проверки ворот, из-за которых версия удержана, — причина человеку. */
export function failedGateChecks(r: GateReport | null): GateCheck[] {
  return r ? r.checks.filter((c) => c.held) : [];
}

// ── Песочница ────────────────────────────────────────────────────────

export type SandboxPhase =
  'preparing' | 'ready' | 'exhausted' | 'expired' | 'failed' | 'blocked';

export function sandboxPhase(s: SandboxView, now: Date): SandboxPhase {
  if (s.status === 'expired') return 'expired';
  const exp = Date.parse(s.expiresAt);
  if (Number.isFinite(exp) && exp <= now.getTime()) return 'expired';
  if (s.status === 'failed' || s.status === 'blocked') return s.status;
  if (s.status !== 'ready') return 'preparing';
  return s.questionsLimit > 0 && s.questions >= s.questionsLimit
    ? 'exhausted'
    : 'ready';
}

/**
 * Подпись источника ответа под пузырём. Номер — в той же форме `[S3]`,
 * что маркер в тексте ответа (sanitize.ts у K3 приводит маркеры к ней):
 * «[3]» под текстом с «[S3]» человек не сопоставит.
 */
export function sourceRefLabel(s: {
  n: number;
  title: string | null;
  url: string | null;
}): string {
  return `[S${s.n}] ${s.title || s.url || ''}`.trim();
}

export function questionsLeft(s: SandboxView): number {
  return Math.max(0, s.questionsLimit - s.questions);
}

/**
 * Пауза опроса подготовки: 2 с, потом реже, но не реже 6 с — человек
 * смотрит на «читаю сайт…», и замершая цифра выглядит как зависание.
 */
export function pollDelayMs(attempt: number): number {
  return Math.min(6000, 2000 + Math.max(0, attempt) * 500);
}

/** Длина вопроса песочницы (SANDBOX_LIMITS.maxQuestionChars). */
export const SANDBOX_QUESTION_MAX = 500;

/** `sb_<id>` из запуска TMA → id песочницы лендинга или null. */
export function sandboxIdFromLaunch(
  startParam: string | null | undefined
): string | null {
  const p = parseStartParam(startParam);
  return p?.kind === 'sb' ? p.value : null;
}

/**
 * Вопрос, с которым открыть песочницу («проверить ответ» в сводке). В
 * памяти, а не в адресе: вопрос в hash остался бы в истории и в ссылке,
 * которую пересылают.
 */
let pendingQuestion: string | null = null;
export function setPendingQuestion(q: string | null): void {
  pendingQuestion = q ? q.slice(0, SANDBOX_QUESTION_MAX) : null;
}
export function takePendingQuestion(): string | null {
  const q = pendingQuestion;
  pendingQuestion = null;
  return q;
}

// ── Документы ────────────────────────────────────────────────────────

/** Зеркало KNOWLEDGE_DEFAULTS (сверяет scripts/knowledge-view.test.ts). */
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
] as const;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

const BY_EXT: Record<string, (typeof DOCUMENT_MIME_TYPES)[number]> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
};

/** Для `<input accept>`: расширения и типы. */
export const DOCUMENT_ACCEPT = [
  ...Object.keys(BY_EXT).map((e) => `.${e}`),
  ...DOCUMENT_MIME_TYPES,
].join(',');

export type UploadCheck =
  | { ok: true; mimeType: string }
  | { ok: false; code: 'DOCUMENT_TOO_LARGE' | 'DOCUMENT_TYPE' };

/**
 * Проверка файла ДО запроса: 20 МБ и типы §3.4. Тип — по расширению,
 * если браузер его не назвал (WebView Telegram часто отдаёт пустой
 * `type` для .md и .csv). Сервер проверит ещё раз — это не защита, а
 * чтобы человек не ждал загрузку 20 МБ ради отказа.
 */
export function checkUpload(f: {
  name: string;
  size: number;
  type: string;
}): UploadCheck {
  if (f.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, code: 'DOCUMENT_TOO_LARGE' };
  }
  const ext = f.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const byExt = BY_EXT[ext];
  const declared = f.type.split(';')[0].trim().toLowerCase();
  if ((DOCUMENT_MIME_TYPES as readonly string[]).includes(declared)) {
    return { ok: true, mimeType: declared };
  }
  // Объявленный тип не из списка (или пустой) — решает расширение:
  // `.md` браузеры называют то `text/x-markdown`, то никак.
  return byExt
    ? { ok: true, mimeType: byExt }
    : { ok: false, code: 'DOCUMENT_TYPE' };
}

/** «Исключить» документ: страница — по URL (не вернётся при переобходе), иначе по id. */
export function exclusionForDocument(d: { id: string; url: string | null }): {
  kind: ExclusionKind;
  value: string;
} {
  return d.url
    ? { kind: 'url', value: d.url }
    : { kind: 'document', value: d.id };
}

// ── Адреса ───────────────────────────────────────────────────────────

/**
 * Одна ссылка «Отдельные URL»: https, порт 443, без логина, доменное
 * имя. Те же правила, что у хостов (`parseHostInput`), но путь
 * сохраняется — это страница, а не хост. Фрагмент `#…` срезается.
 */
export function normalizePageUrl(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  const host = parseHostInput(input);
  if (!host.ok) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : `https://${input}`;
  try {
    const u = new URL(withScheme);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** Адресов в одном источнике «url» (MAX_URLS_PER_SOURCE у K3). */
export const MAX_URLS_PER_SOURCE = 20;

/** Список адресов (по строке или через пробел) → годные + отвергнутые. */
export function parseUrlList(
  text: string,
  max = MAX_URLS_PER_SOURCE
): { urls: string[]; invalid: string[]; tooMany: boolean } {
  const parts = text
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const u = normalizePageUrl(p);
    if (!u) invalid.push(p);
    else if (!urls.includes(u)) urls.push(u);
  }
  return { urls: urls.slice(0, max), invalid, tooMany: urls.length > max };
}

export type SiteUrlResult =
  | { ok: true; url: string; host: string }
  | { ok: false; error: HostInputError };

/**
 * Онбординг, шаг 2 (§3.1): адрес сайта → `https://<хост>/`. Схема
 * дописывается, `www` НЕ срезается (отдельный хост, §3.3), путь
 * отбрасывается — предпросмотр и песочница начинают с главной.
 */
export function normalizeSiteUrl(raw: string): SiteUrlResult {
  const r = parseHostInput(raw);
  if (!r.ok) return r;
  return { ok: true, url: `https://${r.host}/`, host: r.host };
}

/** Горячая страница вкл/выкл: не больше 10 (CRAWL_DEFAULTS.maxHotPages). */
export const MAX_HOT_PAGES = 10;

export function toggleHot(
  current: string[],
  url: string,
  on: boolean
): { ok: true; urls: string[] } | { ok: false; code: 'HOT_PAGES_LIMIT' } {
  const rest = current.filter((u) => u !== url);
  if (!on) return { ok: true, urls: rest };
  if (rest.length >= MAX_HOT_PAGES)
    return { ok: false, code: 'HOT_PAGES_LIMIT' };
  return { ok: true, urls: [...rest, url] };
}

// ── Сводка ───────────────────────────────────────────────────────────

/** `{ uk: 0.92, ru: 0.08 }` → «uk 92% · ru 8%» по убыванию. */
export function langShares(
  langs: Record<string, number>
): Array<{ lang: string; pct: number }> {
  return Object.entries(langs)
    .map(([lang, share]) => ({ lang, pct: Math.round(share * 100) }))
    .filter((x) => x.pct > 0)
    .sort((a, b) => b.pct - a.pct || a.lang.localeCompare(b.lang));
}

/** Доля потраченного бюджета обучения 0..1 (потолок 0 — «исчерпан»). */
export function budgetShare(b: {
  capMicroUsd: number;
  spentMicroUsd: number;
}): number {
  if (b.capMicroUsd <= 0) return 1;
  return Math.min(1, Math.max(0, b.spentMicroUsd / b.capMicroUsd));
}

/** Микродоллары → «$0.12». */
export function formatUsd(micro: number): string {
  return `$${(Math.max(0, micro) / 1_000_000).toFixed(2)}`;
}
