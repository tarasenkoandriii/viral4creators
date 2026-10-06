/**
 * «Голос → Мемо → Из шаблона платформы» и «Опубликовать проверенные»
 * (Э6-тер (к), ТЗ §5-бис.17 п.6, п.14): клиент
 * `/assist/sites/:id/memo-templates` и `/assist/sites/:id/memo-batch/publish`
 * (сервер — `assist-site-voice-control/cabinet/memo-templates.*`). Разбор
 * строгий: мусор — умолчания. Шаблоны создают только черновики; публикация
 * пакетом — только мемо, прошедших проверку на сайте (сервер проверяет).
 */
import type { ApiClient } from '../kit';
import type { MemoLang } from './memo-api';
import { arr, obj, text } from './widget-api';

/** Платформы с шаблонами мемо (В-54: пока одна). */
export const MEMO_TEMPLATE_PLATFORMS = ['woocommerce'] as const;
export type MemoTemplatePlatform = (typeof MEMO_TEMPLATE_PLATFORMS)[number];

export interface MemoTemplateItem {
  platform: MemoTemplatePlatform;
  key: string;
  names: Partial<Record<MemoLang, string>>;
  goal: Partial<Record<MemoLang, string>>;
  exists: boolean;
}

export interface MemoTemplates {
  /** Платформа сайта (по шаблону голосовой карты) или null — кнопки нет. */
  platform: MemoTemplatePlatform | null;
  templates: MemoTemplateItem[];
}

export interface MemoTemplatesApplied {
  created: Array<{ number: number; key: string; gates: 'ok' | string[] }>;
  rejected: Array<{ key: string; code: string }>;
  unresolved: Array<{ key: string; binds: string[] }>;
}

export interface MemoBatchPublished {
  results: Array<{
    number: number;
    version: number | null;
    ok: boolean;
    code: string | null;
  }>;
}

const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CODE = /^[A-Za-z_]{1,40}$/;
const LANGS: readonly MemoLang[] = ['uk', 'ru', 'en'];
const platform = (v: unknown): MemoTemplatePlatform | null =>
  (MEMO_TEMPLATE_PLATFORMS as readonly unknown[]).includes(v)
    ? (v as MemoTemplatePlatform)
    : null;
const langs = (v: unknown): Partial<Record<MemoLang, string>> => {
  const o = obj(v);
  const out: Partial<Record<MemoLang, string>> = {};
  for (const l of LANGS)
    if (typeof o[l] === 'string') out[l] = (o[l] as string).slice(0, 160);
  return out;
};
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
const code = (v: unknown): string =>
  typeof v === 'string' && CODE.test(v) ? v : 'other';

export function parseMemoTemplates(v: unknown): MemoTemplates {
  const o = obj(v);
  return {
    platform: platform(o.platform),
    templates: arr(o.templates)
      .map(obj)
      .filter((t) => !!platform(t.platform) && KEY.test(text(t.key)))
      .map((t) => ({
        platform: platform(t.platform) as MemoTemplatePlatform,
        key: text(t.key),
        names: langs(t.names),
        goal: langs(t.goal),
        exists: t.exists === true,
      }))
      .slice(0, 20),
  };
}

export function parseMemoTemplatesApplied(v: unknown): MemoTemplatesApplied {
  const o = obj(v);
  return {
    created: arr(o.created)
      .map(obj)
      .filter((c) => int(c.number) !== null && KEY.test(text(c.key)))
      .map((c) => ({
        number: c.number as number,
        key: text(c.key),
        gates:
          c.gates === 'ok'
            ? ('ok' as const)
            : arr(c.gates).map(code).slice(0, 20),
      })),
    rejected: arr(o.rejected)
      .map(obj)
      .map((r) => ({ key: text(r.key).slice(0, 64), code: code(r.code) }))
      .slice(0, 20),
    unresolved: arr(o.unresolved)
      .map(obj)
      .map((u) => ({
        key: text(u.key).slice(0, 64),
        binds: arr(u.binds)
          .filter((b): b is string => typeof b === 'string')
          .map((b) => b.slice(0, 64))
          .slice(0, 10),
      }))
      .slice(0, 20),
  };
}

export function parseMemoBatchPublished(v: unknown): MemoBatchPublished {
  return {
    results: arr(obj(v).results)
      .map(obj)
      .filter((r) => int(r.number) !== null)
      .map((r) => ({
        number: r.number as number,
        version: int(r.version),
        ok: r.ok === true,
        code: r.ok === true ? null : code(r.code),
      }))
      .slice(0, 50),
  };
}

export interface MemoTemplatesApi {
  list(siteId: string): Promise<MemoTemplates>;
  apply(
    siteId: string,
    platform: MemoTemplatePlatform,
    keys?: string[]
  ): Promise<MemoTemplatesApplied>;
  /** Публикация пакетом: номера или (без них) все мемо из шаблона. */
  publishBatch(siteId: string, numbers?: number[]): Promise<MemoBatchPublished>;
}

const SEG = /^[A-Za-z0-9_-]{1,64}$/;
function seg(id: string): string {
  if (!SEG.test(id)) throw new Error('bad id');
  return id;
}

export function createMemoTemplatesApi(client: ApiClient): MemoTemplatesApi {
  const base = (id: string) => `/assist/sites/${seg(id)}`;
  return {
    list: async (id) =>
      parseMemoTemplates(
        await client.request('GET', `${base(id)}/memo-templates`)
      ),
    apply: async (id, p, keys) =>
      parseMemoTemplatesApplied(
        await client.request('POST', `${base(id)}/memo-templates`, {
          platform: p,
          ...(keys ? { keys } : {}),
        })
      ),
    publishBatch: async (id, numbers) =>
      parseMemoBatchPublished(
        await client.request(
          'POST',
          `${base(id)}/memo-batch/publish`,
          numbers ? { numbers } : {}
        )
      ),
  };
}
