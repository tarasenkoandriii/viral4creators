/**
 * Голосовая карта — общая СЕРВИСНАЯ часть двух контуров без базы (заход 11,
 * №117): кабинеты карты «Сайта» (`assist-site-voice-map`) и «Админки»
 * (`assist-admin-voice-map`) — два экземпляра одного ядра (§5-кватер.9
 * «Изоляция», К-9): таблицы, маршруты, роли и origin у них свои, а хеш
 * содержимого, ошибки операций, вид версии и диффа, разбор ссылки
 * редактора и подпись файла экспорта — одни. Здесь нет ни базы, ни имён
 * таблиц режимов (правила графа `ui-core-no-db`, `ui-core-names`).
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { derivedKeys } from '../../common/secrets-keyring';
import {
  canonicalJson,
  parseVoiceMapContent,
  voiceMapDiff,
  VOICE_MAP_LIMITS,
  type MapGateReport,
  type MapOpIssue,
  type VoiceMapContent,
} from './voice-map';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Хеш содержимого версии (канонический JSON) — сверка экспорта/импорта. */
export function voiceMapContentHash(c: VoiceMapContent): string {
  return createHash('sha256').update(canonicalJson(c)).digest('base64url');
}

/** Ошибки операций → поле `errors` конверта (`{ path: ops.N.поле, code }`). */
export function mapIssuesToErrors(
  issues: ReadonlyArray<Pick<MapOpIssue, 'index' | 'code' | 'path'>>,
): Array<{ path: string; code: string }> {
  return issues.map((i) => ({
    path: `ops.${i.index}${i.path ? `.${i.path}` : ''}`,
    code: i.code,
  }));
}

/** Строка версии карты (поля обеих таблиц версий — одинаковые). */
export interface MapVersionRow {
  number: number;
  status: string;
  content: unknown;
  gateReport: unknown;
  rollbackOf: number | null;
  requestedVia: string;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface MapVersionSummaryView {
  number: number;
  status: string;
  requestedVia: string;
  rollbackOf: number | null;
  createdAt: string;
  publishedAt: string | null;
  ok: boolean;
  problems: number;
  warnings: number;
  diff: { added: number; changed: number; removed: number };
}

export interface MapVersionDetailView extends MapVersionSummaryView {
  gateReport: MapGateReport | null;
  content: VoiceMapContent;
  diffKeys: { added: string[]; changed: string[]; removed: string[] };
}

/** Строка списка версий: статус, ворота, дифф к опубликованной. */
export function mapVersionSummary(
  v: MapVersionRow,
  prev: VoiceMapContent | null,
): MapVersionSummaryView {
  const g = (v.gateReport ?? null) as MapGateReport | null;
  const d = voiceMapDiff(prev, parseVoiceMapContent(v.content));
  return {
    number: v.number,
    status: v.status,
    requestedVia: v.requestedVia,
    rollbackOf: v.rollbackOf,
    createdAt: v.createdAt.toISOString(),
    publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
    ok: g?.ok ?? false,
    problems: g?.problems?.length ?? 0,
    warnings: g?.warnings?.length ?? 0,
    diff: {
      added: d.added.length,
      changed: d.changed.length,
      removed: d.removed.length,
    },
  };
}

/** Версия целиком: отчёт ворот, содержимое, ключи диффа. */
export function mapVersionView(
  v: MapVersionRow,
  prev: VoiceMapContent | null,
): MapVersionDetailView {
  const content = parseVoiceMapContent(v.content);
  return {
    ...mapVersionSummary(v, prev),
    gateReport: (v.gateReport ?? null) as MapGateReport | null,
    content,
    diffKeys: voiceMapDiff(prev, content),
  };
}

/** Путь страницы ссылки редактора: только путь своего хоста, иначе `/`. */
export function editorLinkPath(raw: unknown): string {
  return typeof raw === 'string' &&
    raw.length <= 300 &&
    /^\/(?![/\\])[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/.test(raw)
    ? raw
    : '/';
}

/** Ключ цели, открываемой по ссылке (`focus`), — только формат ключа. */
export function editorFocusKey(raw: unknown): string | null {
  return typeof raw === 'string' && VOICE_MAP_LIMITS.keyRe.test(raw)
    ? raw
    : null;
}

/** День UTC (`YYYY-MM-DD`) суточных счётчиков карты. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Подпись файла экспорта карты (аудит Н-5, №60): свой ключ контура из env
 * (`ownKeyEnv`) или ПРОИЗВОДНЫЙ от `ASSIST_SECRETS_KEY` с меткой контура —
 * сам KEK ключом HMAC файла, который уходит владельцу, не используется.
 * Проверка — всеми версиями связки (файл, выгруженный до ротации, остаётся
 * «нашим»); подпись — текущей. Без ключа подпись формальна (формат), а
 * «нашим» файл не признаётся никогда. Метки контуров разные: файл
 * «Админки», подписанный её ключом, не «наш» для «Сайта» и наоборот.
 */
export interface MapExportSigner {
  sign(payload: unknown): string;
  valid(payload: unknown, got: unknown): boolean;
}

export function mapExportSigner(
  env: NodeJS.ProcessEnv,
  opts: { ownKeyEnv: string; label: string; unsignedKey: string },
): MapExportSigner {
  const keys = (): readonly Buffer[] => {
    const own = env[opts.ownKeyEnv]?.trim();
    if (own) return [Buffer.from(own, 'utf8')];
    return derivedKeys(env, opts.label)?.all ?? [];
  };
  const sig = (payload: unknown, key: Buffer | string) =>
    createHmac('sha256', key)
      .update(canonicalJson(payload))
      .digest('base64url');
  return {
    sign: (payload) => sig(payload, keys()[0] ?? opts.unsignedKey),
    valid: (payload, got) => {
      if (typeof got !== 'string') return false;
      const a = Buffer.from(got, 'utf8');
      return keys().some((key) => {
        const b = Buffer.from(sig(payload, key), 'utf8');
        return a.length === b.length && timingSafeEqual(a, b);
      });
    },
  };
}
