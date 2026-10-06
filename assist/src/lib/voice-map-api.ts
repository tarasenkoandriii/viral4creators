/**
 * Голосовая карта «Сайта» в TMA (Э6-тер, ТЗ §5-кватер.9, §5-кватер.13) —
 * повтор форм `sites-backend/src/modules/assist-site-voice-map/api-types.ts`
 * (сверку держит scripts/voice-map-api.test.ts) и клиент
 * `/assist/sites/:id/voice-map/site*`. Разбор строгий: мусор — умолчания.
 * Публикация — только здесь (В-50): панель редактора на сайте лишь
 * присылает запрос.
 */
import { ApiError, type ApiClient } from '../kit';
import { arr, obj, text } from './widget-api';

export const VOICE_MAP_ERROR_CODES = [
  'VOICE_MAP_CONFLICT',
  'VOICE_MAP_INVALID',
  'VOICE_MAP_HOST_REQUIRED',
  'VOICE_MAP_VERSION_NOT_FOUND',
  'VOICE_MAP_VERSION_STATE',
  'VOICE_MAP_HELD',
  'VOICE_MAP_PHRASE_TAKEN',
  'VOICE_MAP_IMPORT_KIND',
  'VOICE_MAP_IMPORT_FORMAT',
  // Э-С Ш3: «Снимок» и сверка карты браузерным воркером (экраны — хвост).
  'VOICE_MAP_SNAPSHOT_NOT_FOUND',
  'VOICE_MAP_CHECK_NOT_FOUND',
] as const;
export type VoiceMapErrorCode = (typeof VOICE_MAP_ERROR_CODES)[number];

export function voiceMapErrorCode(e: unknown): VoiceMapErrorCode | null {
  return e instanceof ApiError &&
    (VOICE_MAP_ERROR_CODES as readonly string[]).includes(e.code)
    ? (e.code as VoiceMapErrorCode)
    : null;
}

/** Коды ворот (assist-ui-core/voice-map.ts MapGateCode). */
export const MAP_GATE_CODES = [
  'risk_lowered',
  'never_named',
  'never_attr',
  'phrase_conflict',
  'memo_phrase',
  'text',
  'not_found',
  'empty',
] as const;
export type MapGateCode = (typeof MAP_GATE_CODES)[number];

export const MAP_VERSION_STATUSES = [
  'building',
  'checking',
  'published',
  'held',
  'discarded',
] as const;
export type MapVersionStatus = (typeof MAP_VERSION_STATUSES)[number];

export interface MapGates {
  ok: boolean;
  problems: Array<{
    code: MapGateCode;
    key: string | null;
    phrase: string | null;
  }>;
  warnings: Array<{ code: string; key: string | null; memo: number | null }>;
  counts: {
    targets: number;
    denylisted: number;
    templates: number;
    notFound: number;
    fragile: number;
  };
}

export interface MapVersionSummary {
  number: number;
  status: MapVersionStatus;
  requestedVia: 'editor' | 'tma';
  rollbackOf: number | null;
  createdAt: string;
  publishedAt: string | null;
  ok: boolean;
  problems: number;
  warnings: number;
  diff: { added: number; changed: number; removed: number };
}

export interface MapTargetBrief {
  key: string;
  name: string;
  scope: string;
  risk: string;
  denylisted: boolean;
  stability: string;
}

export interface MapVersionDetail extends MapVersionSummary {
  gates: MapGates | null;
  diffKeys: { added: string[]; changed: string[]; removed: string[] };
  targets: MapTargetBrief[];
}

export interface VoiceMapSummary {
  publishedVersion: number;
  draftRevision: number;
  targets: number;
  denylisted: number;
  templates: number;
  fragile: number;
  draftGates: MapGates;
  draftDirty: boolean;
  versions: MapVersionSummary[];
  activeSessions: number;
  templateSuggestions: Array<{ pathPattern: string; pages: number }>;
  hosts: string[];
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const iso = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
const nstr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseGates(v: unknown): MapGates {
  const o = obj(v);
  const c = obj(o.counts);
  return {
    ok: o.ok === true,
    problems: arr(o.problems).map((p) => {
      const x = obj(p);
      const code = (MAP_GATE_CODES as readonly string[]).includes(text(x.code))
        ? (text(x.code) as MapGateCode)
        : 'text';
      return { code, key: nstr(x.key), phrase: nstr(x.phrase) };
    }),
    warnings: arr(o.warnings).map((w) => {
      const x = obj(w);
      return {
        code: text(x.code),
        key: nstr(x.key),
        memo: typeof x.memo === 'number' ? x.memo : null,
      };
    }),
    counts: {
      targets: num(c.targets),
      denylisted: num(c.denylisted),
      templates: num(c.templates),
      notFound: num(c.notFound),
      fragile: num(c.fragile),
    },
  };
}

export function parseVersionSummary(v: unknown): MapVersionSummary | null {
  const o = obj(v);
  const n = num(o.number);
  if (!n) return null;
  const st = text(o.status);
  const d = obj(o.diff);
  return {
    number: n,
    status: (MAP_VERSION_STATUSES as readonly string[]).includes(st)
      ? (st as MapVersionStatus)
      : 'held',
    requestedVia: o.requestedVia === 'editor' ? 'editor' : 'tma',
    rollbackOf: typeof o.rollbackOf === 'number' ? o.rollbackOf : null,
    createdAt: iso(o.createdAt) ?? '',
    publishedAt: iso(o.publishedAt),
    ok: o.ok === true,
    problems: num(o.problems),
    warnings: num(o.warnings),
    diff: {
      added: num(d.added),
      changed: num(d.changed),
      removed: num(d.removed),
    },
  };
}

function riskOf(t: Record<string, unknown>): string {
  const rank: Record<string, number> = { now: 0, confirm: 1, never: 2 };
  let r = text(t.riskComputed) || 'confirm';
  const o = text(t.riskOwner);
  if (o && (rank[o] ?? 0) > (rank[r] ?? 0)) r = o;
  return r;
}

export function parseVersionDetail(v: unknown): MapVersionDetail | null {
  const s = parseVersionSummary(v);
  if (!s) return null;
  const o = obj(v);
  const dk = obj(o.diffKeys);
  const keys = (x: unknown) =>
    arr(x).filter((k): k is string => typeof k === 'string');
  return {
    ...s,
    gates: o.gateReport ? parseGates(o.gateReport) : null,
    diffKeys: {
      added: keys(dk.added),
      changed: keys(dk.changed),
      removed: keys(dk.removed),
    },
    targets: arr(obj(o.content).targets).map((x) => {
      const t = obj(x);
      const names = obj(t.names);
      const d = obj(t.descriptor);
      return {
        key: text(t.key),
        name:
          text(names.uk) || text(names.ru) || text(names.en) || text(d.text),
        scope: text(t.scope),
        risk: riskOf(t),
        denylisted: t.denylisted === true,
        stability: text(t.stability),
      };
    }),
  };
}

export function parseSummary(v: unknown): VoiceMapSummary {
  const o = obj(v);
  return {
    publishedVersion: num(o.publishedVersion),
    draftRevision: num(o.draftRevision),
    targets: num(o.targets),
    denylisted: num(o.denylisted),
    templates: num(o.templates),
    fragile: num(o.fragile),
    draftGates: parseGates(o.draftGates),
    draftDirty: o.draftDirty === true,
    versions: arr(o.versions)
      .map(parseVersionSummary)
      .filter((x): x is MapVersionSummary => !!x),
    activeSessions: num(o.activeSessions),
    templateSuggestions: arr(o.templateSuggestions).map((x) => {
      const t = obj(x);
      return { pathPattern: text(t.pathPattern), pages: num(t.pages) };
    }),
    hosts: arr(o.hosts).filter((h): h is string => typeof h === 'string'),
  };
}

/** Итог импорта файла карты: цели и (Э6-тер (к)) мемо — черновики/отказы. */
export interface VoiceMapImported {
  accepted: number;
  rejected: number;
  signed: boolean;
  memos: {
    created: Array<{ number: number; key: string; name: string | null }>;
    rejected: Array<{ index: number; key: string | null; code: string }>;
  };
}

const MEMO_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REASON = /^[A-Za-z_]{1,40}$/;

export function parseVoiceMapImported(v: unknown): VoiceMapImported {
  const o = obj(v);
  const m = obj(o.memos);
  return {
    accepted: num(o.accepted),
    rejected: arr(o.rejected).length,
    signed: o.signed === true,
    memos: {
      created: arr(m.created)
        .map(obj)
        .filter(
          (c) =>
            typeof c.number === 'number' &&
            Number.isInteger(c.number) &&
            c.number >= 1 &&
            MEMO_KEY.test(text(c.key))
        )
        .map((c) => ({
          number: c.number as number,
          key: text(c.key),
          name: typeof c.name === 'string' ? c.name.slice(0, 60) : null,
        }))
        .slice(0, 100),
      rejected: arr(m.rejected)
        .map(obj)
        .map((r) => ({
          index: num(r.index),
          key: MEMO_KEY.test(text(r.key)) ? text(r.key) : null,
          code:
            typeof r.code === 'string' && REASON.test(r.code)
              ? r.code
              : 'other',
        }))
        .slice(0, 100),
    },
  };
}

export interface VoiceMapApi {
  summary(siteId: string): Promise<VoiceMapSummary>;
  editorLink(
    siteId: string,
    body: { host?: string; path?: string; focus?: string }
  ): Promise<{ url: string; expiresAt: string }>;
  revokeSessions(siteId: string): Promise<number>;
  build(siteId: string): Promise<MapVersionDetail | null>;
  version(siteId: string, n: number): Promise<MapVersionDetail | null>;
  publish(siteId: string, n: number): Promise<MapVersionDetail | null>;
  discard(siteId: string, n: number): Promise<MapVersionDetail | null>;
  rollback(siteId: string, n: number): Promise<MapVersionDetail | null>;
  exportFile(siteId: string): Promise<{ name: string; json: string }>;
  /** Шаблон платформы (В-54: пока WooCommerce) — цели в черновик. */
  platformTemplate(
    siteId: string,
    platform: 'woocommerce',
    expectedRevision: number
  ): Promise<number>;
  importFile(
    siteId: string,
    expectedRevision: number,
    file: unknown
  ): Promise<VoiceMapImported>;
}

const SEG = /^[A-Za-z0-9_-]{1,64}$/;
const seg = (id: string) => {
  if (!SEG.test(id)) throw new Error('bad id');
  return id;
};
const n = (x: number) => {
  if (!Number.isInteger(x) || x < 1) throw new Error('bad number');
  return x;
};

export function createVoiceMapApi(client: ApiClient): VoiceMapApi {
  const p = (id: string) => `/assist/sites/${seg(id)}/voice-map/site`;
  return {
    summary: async (id) => parseSummary(await client.request('GET', p(id))),
    editorLink: async (id, body) => {
      const o = obj(await client.request('POST', `${p(id)}/editor-link`, body));
      const url = text(o.url);
      if (!/^https:\/\//.test(url)) throw new Error('bad url');
      return { url, expiresAt: iso(o.expiresAt) ?? '' };
    },
    revokeSessions: async (id) =>
      num(
        obj(await client.request('DELETE', `${p(id)}/editor-sessions`)).revoked
      ),
    build: async (id) =>
      parseVersionDetail(await client.request('POST', `${p(id)}/versions`)),
    version: async (id, x) =>
      parseVersionDetail(
        await client.request('GET', `${p(id)}/versions/${n(x)}`)
      ),
    publish: async (id, x) =>
      parseVersionDetail(
        await client.request('POST', `${p(id)}/versions/${n(x)}/publish`)
      ),
    discard: async (id, x) =>
      parseVersionDetail(
        await client.request('POST', `${p(id)}/versions/${n(x)}/discard`)
      ),
    rollback: async (id, x) =>
      parseVersionDetail(
        await client.request('POST', `${p(id)}/versions/${n(x)}/rollback`)
      ),
    platformTemplate: async (id, platform, expectedRevision) =>
      num(
        obj(
          await client.request('POST', `${p(id)}/platform-template`, {
            platform,
            expectedRevision,
          })
        ).applied
      ),
    exportFile: async (id) => {
      const o = obj(await client.request('GET', `${p(id)}/export`));
      return {
        name: text(o.name) || 'voice-map.json',
        json: JSON.stringify(o.file ?? {}, null, 2),
      };
    },
    importFile: async (id, expectedRevision, file) => {
      const o = obj(
        await client.request('POST', `${p(id)}/import`, {
          expectedRevision,
          file,
        })
      );
      return parseVoiceMapImported(o);
    },
  };
}
