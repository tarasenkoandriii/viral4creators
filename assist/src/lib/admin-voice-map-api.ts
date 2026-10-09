/**
 * Голосовая карта «Админки» в TMA (заход 11, №117; ТЗ §5-кватер.9
 * «Изоляция», §5-кватер.13; В-55) — повтор форм
 * `sites-backend/src/modules/assist-admin-voice-map/api-types.ts` (сверку
 * держит scripts/admin-voice-map-api.test.ts) и клиент
 * `/assist/sites/:id/admin-mode/voice-map*` (только assistAdmin: owner).
 * Разбор версий и ворот — общий с картой «Сайта» (`voice-map-api.ts`): ядро
 * карты одно, контуры разные. Разбор строгий: мусор — умолчания.
 * Публикация — только здесь: панель редактора в админке лишь присылает
 * запрос.
 */
import { ApiError, type ApiClient } from '../kit';
import { seg } from './handoff-api';
import {
  parseGates,
  parseVersionDetail,
  parseVersionSummary,
  type MapGates,
  type MapVersionDetail,
  type MapVersionSummary,
} from './voice-map-api';
import { arr, obj, text } from './widget-api';

export const ADMIN_VOICE_MAP_ERROR_CODES = [
  'VOICE_MAP_CONFLICT',
  'VOICE_MAP_INVALID',
  'VOICE_MAP_VERSION_NOT_FOUND',
  'VOICE_MAP_VERSION_STATE',
  'VOICE_MAP_HELD',
  'VOICE_MAP_PHRASE_TAKEN',
  'VOICE_MAP_IMPORT_KIND',
  'VOICE_MAP_IMPORT_FORMAT',
  'ADMIN_VOICE_MAP_PLAN_REQUIRED',
  'ADMIN_VOICE_MAP_HOST_REQUIRED',
  'ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED',
  'EDITOR_OWNER_REQUIRED',
  'EDITOR_LINK_INVALID',
  'EDITOR_SESSION_EXPIRED',
  'EDITOR_PUBLISH_FORBIDDEN',
  'EDITOR_TRY_LIMIT',
  'EDITOR_PUBLISH_LIMIT',
  'EDITOR_BAD_REQUEST',
] as const;
export type AdminVoiceMapErrorCode =
  (typeof ADMIN_VOICE_MAP_ERROR_CODES)[number];

export function adminVoiceMapErrorCode(
  e: unknown
): AdminVoiceMapErrorCode | null {
  return e instanceof ApiError &&
    (ADMIN_VOICE_MAP_ERROR_CODES as readonly string[]).includes(e.code)
    ? (e.code as AdminVoiceMapErrorCode)
    : null;
}

export const MAP_LANGS = ['uk', 'ru', 'en'] as const;
export type MapLang = (typeof MAP_LANGS)[number];

/** Роли элемента, которые владелец может выбрать для цели в TMA. */
export const MAP_TARGET_ROLES = [
  'link',
  'button',
  'tab',
  'menuitem',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
] as const;
export type MapTargetRole = (typeof MAP_TARGET_ROLES)[number];

export interface AdminMapTarget {
  key: string;
  scope: 'page' | 'template' | 'site';
  templateId: string | null;
  pagePath: string | null;
  /** Видимый текст элемента и роль — как нашёл пикер / ввёл владелец. */
  text: string;
  role: string | null;
  assistId: string | null;
  names: Record<MapLang, string>;
  synonyms: Record<MapLang, string[]>;
  risk: 'now' | 'confirm' | 'never';
  denylisted: boolean;
  stability: string;
  status: 'active' | 'removed';
}

export interface AdminMapTemplate {
  id: string;
  name: string;
  pathPattern: string;
  status: 'suggested' | 'active' | 'removed';
}

export interface AdminVoiceMapDraft {
  revision: number;
  publishedVersion: number;
  targets: AdminMapTarget[];
  templates: AdminMapTemplate[];
  gates: MapGates;
}

export interface AdminVoiceMapSummary {
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
  hosts: string[];
  planAllows: boolean;
}

export interface AdminVoiceMapImported {
  accepted: number;
  rejected: number;
  signed: boolean;
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const KEY = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RANK: Record<string, number> = { now: 0, confirm: 1, never: 2 };

function riskOf(t: Record<string, unknown>): AdminMapTarget['risk'] {
  let r = text(t.riskComputed);
  if (!(r in RANK)) r = 'confirm';
  const o = text(t.riskOwner);
  if (o in RANK && RANK[o] > RANK[r]) r = o;
  return r as AdminMapTarget['risk'];
}

export function parseTarget(v: unknown): AdminMapTarget | null {
  const t = obj(v);
  const key = text(t.key);
  if (!KEY.test(key)) return null;
  const d = obj(t.descriptor);
  const names = obj(t.names);
  const syn = obj(t.synonyms);
  const scope = text(t.scope);
  return {
    key,
    scope:
      scope === 'template' || scope === 'site' || scope === 'page'
        ? scope
        : 'page',
    templateId: typeof t.templateId === 'string' ? t.templateId : null,
    pagePath: typeof t.pagePath === 'string' ? t.pagePath : null,
    text: text(d.text).slice(0, 80),
    role: typeof d.role === 'string' ? d.role : null,
    assistId: typeof d.assistId === 'string' ? d.assistId : null,
    names: Object.fromEntries(
      MAP_LANGS.map((l) => [l, text(names[l]).slice(0, 60)])
    ) as Record<MapLang, string>,
    synonyms: Object.fromEntries(
      MAP_LANGS.map((l) => [
        l,
        arr(syn[l])
          .map((s) => text(obj(s).text).slice(0, 40))
          .filter(Boolean)
          .slice(0, 20),
      ])
    ) as Record<MapLang, string[]>,
    risk: riskOf(t),
    denylisted: t.denylisted === true,
    stability: text(t.stability) || 'fragile',
    status: t.status === 'removed' ? 'removed' : 'active',
  };
}

export function parseDraft(v: unknown): AdminVoiceMapDraft {
  const o = obj(v);
  const c = obj(o.content);
  return {
    revision: num(o.revision),
    publishedVersion: num(o.publishedVersion),
    targets: arr(c.targets)
      .map(parseTarget)
      .filter((x): x is AdminMapTarget => !!x)
      .slice(0, 500),
    templates: arr(c.templates)
      .map(obj)
      .filter(
        (t) => typeof t.id === 'string' && typeof t.pathPattern === 'string'
      )
      .map((t) => ({
        id: text(t.id),
        name: text(t.name).slice(0, 60),
        pathPattern: text(t.pathPattern).slice(0, 200),
        status:
          t.status === 'suggested' || t.status === 'removed'
            ? (t.status as 'suggested' | 'removed')
            : 'active',
      })),
    gates: parseGates(o.gates),
  };
}

export function parseAdminSummary(v: unknown): AdminVoiceMapSummary {
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
    hosts: arr(o.hosts).filter((h): h is string => typeof h === 'string'),
    planAllows: o.planAllows === true,
  };
}

/**
 * Операция «цель из TMA» (без пикера): видимый текст + роль (+ разметка) —
 * дескриптор, имена и синонимы на трёх языках. Риск, разбор и проверки —
 * на сервере (как у панели редактора).
 */
export function targetOp(t: {
  key: string;
  text: string;
  role: MapTargetRole;
  assistId?: string | null;
  scope: 'site' | 'page' | 'template';
  pagePath?: string | null;
  templateId?: string | null;
  names: Partial<Record<MapLang, string>>;
  synonyms: Partial<Record<MapLang, string[]>>;
  denylisted?: boolean;
}): Record<string, unknown> {
  const tag =
    t.role === 'link'
      ? 'a'
      : t.role === 'textbox' || t.role === 'searchbox' || t.role === 'checkbox'
        ? 'input'
        : t.role === 'combobox'
          ? 'select'
          : 'button';
  const clean = (s: string | undefined) => (s ?? '').trim();
  return {
    op: 'upsert-target',
    target: {
      key: t.key,
      scope: t.scope,
      ...(t.scope === 'page' ? { pagePath: t.pagePath ?? '/' } : {}),
      ...(t.scope === 'template' ? { templateId: t.templateId } : {}),
      descriptor: {
        tag,
        role: t.role,
        text: clean(t.text),
        ...(t.assistId ? { assistId: t.assistId } : {}),
        unique: true,
      },
      names: Object.fromEntries(
        MAP_LANGS.map((l) => [l, clean(t.names[l])]).filter(([, v]) => v)
      ),
      synonyms: Object.fromEntries(
        MAP_LANGS.map((l) => [
          l,
          (t.synonyms[l] ?? [])
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => ({ text: s })),
        ])
      ),
      ...(t.denylisted ? { denylisted: true } : {}),
    },
  };
}

/** Правка имён/синонимов существующей цели (дескриптор — прежний). */
export function namesOp(
  key: string,
  names: Record<MapLang, string>,
  synonyms: Record<MapLang, string[]>
): Record<string, unknown> {
  return {
    op: 'upsert-target',
    target: {
      key,
      names: Object.fromEntries(
        MAP_LANGS.map((l) => [l, names[l].trim()]).filter(([, v]) => v)
      ),
      synonyms: Object.fromEntries(
        MAP_LANGS.map((l) => [
          l,
          synonyms[l]
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => ({ text: s })),
        ])
      ),
    },
  };
}

export interface AdminVoiceMapApi {
  summary(siteId: string): Promise<AdminVoiceMapSummary>;
  draft(siteId: string): Promise<AdminVoiceMapDraft>;
  /** Операции черновика — `PATCH …/draft` (409/422); ответ — новая ревизия. */
  patch(
    siteId: string,
    expectedRevision: number,
    ops: unknown[]
  ): Promise<number>;
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
  importFile(
    siteId: string,
    expectedRevision: number,
    file: unknown
  ): Promise<AdminVoiceMapImported>;
}

const n = (x: number) => {
  if (!Number.isInteger(x) || x < 1) throw new Error('bad number');
  return x;
};

export function createAdminVoiceMapApi(client: ApiClient): AdminVoiceMapApi {
  const p = (id: string) => `/assist/sites/${seg(id)}/admin-mode/voice-map`;
  return {
    summary: async (id) =>
      parseAdminSummary(await client.request('GET', p(id))),
    draft: async (id) =>
      parseDraft(await client.request('GET', `${p(id)}/draft`)),
    patch: async (id, expectedRevision, ops) =>
      num(
        obj(
          await client.request('PATCH', `${p(id)}/draft`, {
            expectedRevision,
            ops,
          })
        ).revision
      ),
    editorLink: async (id, body) => {
      const o = obj(await client.request('POST', `${p(id)}/editor-link`, body));
      const url = text(o.url);
      // Ссылка — только https (её откроет владелец у себя в админке).
      if (!/^https:\/\//.test(url)) throw new Error('bad url');
      return { url, expiresAt: text(o.expiresAt) };
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
    exportFile: async (id) => {
      const o = obj(await client.request('GET', `${p(id)}/export`));
      return {
        name: text(o.name) || 'voice-map.admin.json',
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
      return {
        accepted: num(o.accepted),
        rejected: arr(o.rejected).length,
        signed: o.signed === true,
      };
    },
  };
}
