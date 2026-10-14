/**
 * AI Publisher, P-R M2 — правила Reddit-брифа (reddit-manual-mvp-
 * adapted.md §M2.1–M2.2; Р-RD-5): чего не хватает брифу сейчас и разбор
 * тезисов. Чистый модуль: без базы и сети.
 *
 * `ready` требует (триггер + сервис): `affiliation` (и `brand` при
 * аффилированности, Р-RD-65), 2..5 тезисов, у
 * каждого — разрешённый источник продукта (`origin=content`, `allowed`;
 * выдержки и первоисточники P-R не подтверждают — Р-RD-4) или пометка
 * `needs_verification`; у комментария — тред и непустой контекст;
 * активная версия оффера.
 */
import type { FieldIssue } from '../contracts/errors';
import type {
  RedditBriefMissing,
  RedditKeyPoint,
} from '../contracts/reddit-api';
import { looksLikeContact } from '../core/pii-guard';
import { weakBrand } from './markers';
import { hasProfileRef } from './normalize';

export const KEY_POINTS_MIN = 2;
export const KEY_POINTS_MAX = 5;
export const KEY_POINT_TEXT_MAX = 300;
export const KEY_POINT_SOURCES_MAX = 10;
const SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface BriefMissingInput {
  objective: string;
  affiliation: string | null;
  /** Имя продукта/бренда для раскрытия (Р-RD-65). */
  brand: string | null;
  contentType: 'post' | 'comment';
  context: string | null;
  opportunityId: string | null;
  keyPoints: RedditKeyPoint[];
  offerActive: boolean;
  /** id источников, которые сейчас `allowed` и `origin=content`. */
  allowedSourceIds: ReadonlySet<string>;
}

export function briefMissing(b: BriefMissingInput): RedditBriefMissing[] {
  const out: RedditBriefMissing[] = [];
  if (!b.objective.trim()) out.push('objective');
  if (!b.affiliation) out.push('affiliation');
  // Бренд ищется в раскрытии целым словом: ≥ 3 знаков и не стоп-слово
  // (раунд 2, Р-RD-75).
  if (b.affiliation && b.affiliation !== 'none' && weakBrand(b.brand))
    out.push('brand');
  if (
    b.keyPoints.length < KEY_POINTS_MIN ||
    b.keyPoints.length > KEY_POINTS_MAX
  )
    out.push('key_points');
  b.keyPoints.forEach((k, i) => {
    if (
      Array.isArray(k.sourceIds) &&
      !k.sourceIds.some((id) => b.allowedSourceIds.has(id))
    )
      out.push(`key_points[${i}]`);
  });
  if (b.contentType === 'comment') {
    if (!b.opportunityId) out.push('thread');
    if (!b.context?.trim()) out.push('context');
  }
  if (!b.offerActive) out.push('offer_active');
  return out;
}

/** Все id источников тезисов. */
export function keyPointSourceIds(points: readonly RedditKeyPoint[]): string[] {
  const out = new Set<string>();
  for (const k of points)
    if (Array.isArray(k.sourceIds)) k.sourceIds.forEach((x) => out.add(x));
  return [...out];
}

/** Разбор `keyPoints` тела: 0..5 тезисов, текст без контактов и ников. */
export function parseKeyPoints(
  raw: unknown,
  field = 'keyPoints',
): { points: RedditKeyPoint[]; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  if (raw === undefined || raw === null) return { points: [], issues };
  if (!Array.isArray(raw) || raw.length > KEY_POINTS_MAX)
    return { points: [], issues: [{ field, code: 'type' }] };
  const points: RedditKeyPoint[] = [];
  raw.forEach((x, i) => {
    const f = `${field}[${i}]`;
    const o = x as Record<string, unknown> | null;
    if (
      !o ||
      typeof o !== 'object' ||
      Array.isArray(o) ||
      Object.keys(o).some((k) => k !== 'text' && k !== 'sourceIds')
    ) {
      issues.push({ field: f, code: 'type' });
      return;
    }
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text || [...text].length > KEY_POINT_TEXT_MAX) {
      issues.push({ field: `${f}.text`, code: 'length' });
      return;
    }
    if (looksLikeContact(text)) {
      issues.push({ field: `${f}.text`, code: 'pii' });
      return;
    }
    if (hasProfileRef(text)) {
      issues.push({ field: `${f}.text`, code: 'profile_ref' });
      return;
    }
    const s = o.sourceIds;
    if (s === 'needs_verification') {
      points.push({ text, sourceIds: 'needs_verification' });
    } else if (
      Array.isArray(s) &&
      s.length >= 1 &&
      s.length <= KEY_POINT_SOURCES_MAX &&
      s.every((y) => typeof y === 'string' && SOURCE_ID_RE.test(y))
    ) {
      points.push({ text, sourceIds: [...new Set(s as string[])] });
    } else {
      issues.push({ field: `${f}.sourceIds`, code: 'type' });
    }
  });
  return { points, issues };
}

/** Тезисы из базы (jsonb) — без проверки (её держит триггер). */
export function keyPointsOf(raw: unknown): RedditKeyPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is RedditKeyPoint =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as RedditKeyPoint).text === 'string',
  );
}

/** Служебный заголовок версии комментария (≤ 300, в копию не входит). */
export function commentServiceTitle(
  subreddit: string,
  titleManual: string,
): string {
  const t = `r/${subreddit} · ${titleManual}`;
  return [...t].length <= 300 ? t : `${[...t].slice(0, 299).join('')}…`;
}
