/**
 * Мемо: источники «шаблон платформы» и «импорт/экспорт в файле карты»
 * (Э6-тер (к), ТЗ помощника §5-бис.17 п.6, п.15 п.7; §5-кватер.12) — чистая
 * часть без базы (правило графа `ui-core-no-db`).
 *
 *  - экспорт: переносимое содержимое мемо — ключ, имена, фразы, цель,
 *    слоты, шаги с ОПИСАНИЕМ цели (роль, разметка, видимый текст, тег, путь
 *    ссылки и факты для расчёта риска); без номера, id, статуса,
 *    закреплённого отпечатка `pin` (его поля в файле — плоское описание, не
 *    отпечаток), привязок Ш4 (`uiElementId`/`key`), устойчивости,
 *    предложенных фраз (замаскированные команды посетителей) и статистики;
 *  - импорт: ТОЛЬКО в черновики (новые номера, ключ — если свободен), каждое
 *    мемо — строгий разбор и ворота кода на ЭТОМ сайте (его хост и правила);
 *    опасные шаги («никогда», две точки невозврата, константа в поле ПД,
 *    риск ниже расчёта кода…) — отказ этого мемо в отчёте, остальные
 *    проходят; привязка к цели карты (`mapKey`) — только к цели этой карты;
 *    отпечаток собирается заново, сверку с живой страницей делает сухой
 *    прогон перед публикацией (публикует человек);
 *  - шаблон платформы: мемо `PLATFORM_TEMPLATES` (voice-map.ts) с
 *    подписями целей, путями корзины и маской страницы товара ЭТОГО сайта
 *    (факты — из карты и карты интерфейса Ш4; их собирает вызывающий).
 */
import {
  MEMO_LIMITS,
  memoGates,
  parseMemoContent,
  type MemoContent,
  type MemoGateCode,
  type MemoIssue,
} from './memo';
import { PATH_MASK_RE } from './rules';
import { maskLabel } from './snapshot';
import type { VoiceControlRules } from './types';
import { PLATFORM_TEMPLATES } from './voice-map';

export const MEMO_IO_LIMITS = {
  /** Мемо в файле карты — не больше потолка тарифа Pro (В-71). */
  memos: 100,
} as const;

/**
 * Проблемы ворот, с которыми мемо НЕ импортируется (опасные шаги, ТЗ
 * §5-бис.17 п.15 п.7). Остальные (нет цели, конфликт фраз, шагов больше
 * лимита…) — черновик принимается, публикацию задержат ворота.
 */
export const MEMO_IMPORT_DANGER: ReadonlySet<MemoGateCode> =
  new Set<MemoGateCode>([
    'never_step',
    'two_pnr',
    'effect_after_pnr',
    'value_not_slot',
    'unknown_slot',
    'const_forbidden',
    'const_in_pii',
    'goal_slot',
    'risk_lowering_forbidden',
    'undeclared_compensation',
  ]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// ── экспорт ──────────────────────────────────────────────────────────────

/** Мемо для файла карты: содержимое черновика без id, `pin`, Ш4 и статистики. */
export function memoExportItem(m: {
  key: string;
  listed: boolean;
  content: MemoContent;
}): Record<string, unknown> {
  const c = m.content;
  return {
    key: m.key,
    listed: m.listed,
    view: c.view,
    names: c.names,
    triggers: c.triggers,
    goal: c.goal,
    // `pii` слота ставит код заново (по типу и полям шагов).
    slots: c.slots.map((s) => ({
      name: s.name,
      kind: s.kind,
      options: s.options,
    })),
    steps: c.steps.map((s) => {
      const p = s.target?.pin;
      return {
        page: s.page,
        action: s.action,
        target:
          s.target && p
            ? {
                mapKey: s.target.mapKey ?? null,
                role: p.role,
                assistId: p.assistId,
                text: p.text,
                tag: p.tag,
                href: p.href,
                inputType: p.inputType,
                submit: p.submit,
                inForm: p.inForm,
                pd: p.pd,
                toggle: p.toggle,
              }
            : null,
        value: s.value,
        expect: s.expect,
        say: s.say,
        risk: s.risk,
      };
    }),
  };
}

// ── импорт ───────────────────────────────────────────────────────────────

/** Мемо файла → сырой черновик этого сайта (разбирает `parseMemoContent`). */
function rawFromFile(
  m: Record<string, unknown>,
  mapKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const steps = Array.isArray(m.steps) ? m.steps : [];
  return {
    names: m.names,
    triggers: m.triggers,
    goal: m.goal,
    slots: m.slots,
    view: m.view,
    steps: steps.slice(0, 20).map((s) => {
      if (!isObj(s)) return s;
      const t = isObj(s.target) ? s.target : null;
      return {
        page: s.page,
        action: s.action,
        value: s.value,
        expect: s.expect,
        say: s.say,
        risk: s.risk,
        target: t
          ? {
              // Привязки Ш4 другого сайта не переносятся; цель карты — только
              // если такая есть в карте ЭТОГО сайта.
              uiElementId: null,
              key: null,
              mapKey:
                typeof t.mapKey === 'string' && mapKeys.has(t.mapKey)
                  ? t.mapKey
                  : null,
              pin: {
                role: t.role,
                assistId: t.assistId,
                text: t.text,
                tag: t.tag,
                href: t.href,
                inputType: t.inputType,
                submit: t.submit,
                inForm: t.inForm,
                pd: t.pd,
                toggle: t.toggle,
              },
            }
          : null,
      };
    }),
  };
}

export interface MemoImportAccepted {
  index: number;
  /** Ключ из файла (если формат верен) — займётся, только если свободен. */
  key: string | null;
  listed: boolean;
  content: MemoContent;
}

export interface MemoImportRejected {
  index: number;
  key: string | null;
  code: string;
  path: string | null;
}

/**
 * Мемо файла карты → черновики этого сайта или отказ с причиной. Порядок —
 * как в файле; больше `MEMO_IO_LIMITS.memos` — `too_many`.
 */
export function memoImportItems(
  raw: unknown,
  ctx: {
    rules: VoiceControlRules;
    host: string;
    /** Ключи целей карты ЭТОГО сайта. */
    mapKeys: ReadonlySet<string>;
    /** Фразы сайта (`lang:norm`) — для ворот; конфликт не мешает импорту. */
    taken?: ReadonlySet<string>;
  },
): { accepted: MemoImportAccepted[]; rejected: MemoImportRejected[] } {
  const accepted: MemoImportAccepted[] = [];
  const rejected: MemoImportRejected[] = [];
  if (!Array.isArray(raw)) return { accepted, rejected };
  raw.forEach((m, index) => {
    const key =
      isObj(m) && typeof m.key === 'string' && MEMO_LIMITS.keyRe.test(m.key)
        ? m.key
        : null;
    const no = (code: string, path: string | null = null) =>
      rejected.push({ index, key, code, path });
    if (index >= MEMO_IO_LIMITS.memos) return no('too_many');
    if (!isObj(m)) return no('format');
    const parsed = parseMemoContent(rawFromFile(m, ctx.mapKeys));
    const issue: MemoIssue | undefined = parsed.issues[0];
    if (issue) return no(issue.code, issue.path);
    const c = parsed.content;
    if (!Object.values(c.names).some(Boolean)) return no('no_name', 'names');
    const gate = memoGates(c, { rules: ctx.rules, host: ctx.host });
    const danger = gate.problems.find((p) => MEMO_IMPORT_DANGER.has(p.code));
    if (danger) return no(danger.code, danger.path);
    accepted.push({ index, key, listed: m.listed !== false, content: c });
  });
  return { accepted, rejected };
}

// ── шаблоны платформ ─────────────────────────────────────────────────────

/** Факт сайта для цели шаблона (из карты и Ш4): подпись, путь, страница. */
export interface PlatformFact {
  text?: string | null;
  /** Путь ссылки (`/cart/`) — только путь, без хоста. */
  href?: string | null;
  /** Путь страницы, где элемент видели (`/product/t-shirt/`). */
  page?: string | null;
}

/** Ключи фактов, которые нужны шаблонам платформы (`bind` целей шагов). */
export function platformMemoBinds(platform: string): string[] {
  const out = new Set<string>();
  for (const m of PLATFORM_TEMPLATES[platform]?.memos ?? []) {
    const steps = (m.content.steps ?? []) as Array<{
      target?: { bind?: string };
    }>;
    for (const s of steps) if (s.target?.bind) out.add(s.target.bind);
  }
  return [...out];
}

const pathOk = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.length <= 300 &&
  PATH_MASK_RE.test(p) &&
  !p.includes('*');

/**
 * Черновики мемо шаблона платформы с фактами ЭТОГО сайта: подпись цели —
 * в отпечаток (маска ПД), путь корзины — в ссылку и условие адреса, маска
 * страницы товара — по пути, где видели «В кошик». Цель нажатия без подписи
 * — в `unresolved` (ворота задержат публикацию до привязки в редакторе).
 * `keys` — только эти мемо шаблона; null — платформы нет.
 */
export function platformMemoDrafts(
  platform: string,
  facts: Readonly<Record<string, PlatformFact | undefined>>,
  keys?: readonly string[],
): Array<{
  key: string;
  raw: Record<string, unknown>;
  unresolved: string[];
}> | null {
  const t = PLATFORM_TEMPLATES[platform];
  if (!t?.memos) return null;
  const product = facts['add-to-cart']?.page;
  const seg = pathOk(product) ? product.split('/').filter(Boolean) : [];
  // `/product/t-shirt/` → `/product/*`; одна часть пути — шаблон не трогаем.
  const productMask = seg.length >= 2 ? `/${seg[0]}/*` : null;
  const cart = facts['nav-cart']?.href;
  const cartPath = pathOk(cart) ? cart : null;
  return t.memos
    .filter((m) => !keys || keys.includes(m.key))
    .map((m) => {
      const raw = JSON.parse(JSON.stringify(m.content)) as {
        steps?: Array<Record<string, unknown>>;
        goal?: { expect?: Array<Record<string, unknown>> };
      };
      const unresolved: string[] = [];
      for (const s of raw.steps ?? []) {
        if (productMask && s.page === '/product/*') s.page = productMask;
        const tg = s.target as
          { bind?: string; pin: Record<string, unknown> } | undefined;
        if (!tg) continue;
        const bind = tg.bind ?? '';
        delete tg.bind;
        const f = facts[bind];
        const text =
          typeof f?.text === 'string'
            ? maskLabel(f.text.replace(/\s+/g, ' ').trim()).slice(0, 80)
            : '';
        if (text) tg.pin.text = text;
        else if (s.action === 'click') unresolved.push(bind);
        if (bind === 'nav-cart' && cartPath) tg.pin.href = cartPath;
      }
      if (cartPath)
        for (const g of raw.goal?.expect ?? [])
          if (g.kind === 'url' && g.path === '/cart*')
            g.path = `${cartPath.replace(/\/+$/, '')}*`;
      return { key: m.key, raw: raw as Record<string, unknown>, unresolved };
    });
}
