/**
 * «Отчёт для разработчика» голосовой карты «Сайта» (Э6-тер (9), ТЗ
 * помощника §5-кватер.4 «Пакетом — отчёт для разработчика», §5-кватер.13
 * `GET …/voice-map/site/dev-report/:token`; заход 9) — ЧИСТАЯ часть без базы:
 *
 *  - `buildDevReport` — снимок для передачи разработчику сайта: цели карты
 *    по шаблонам/страницам, где искать элемент (тег, видимая подпись уже с
 *    маской ПД пикера, CSS-путь), готовая строка разметки
 *    (`data-assist-id="…"`; цель в запрете — `data-assist="never"`),
 *    «Как отменить» (обратная цель), устойчивость; подсказки платформ;
 *  - `devReportHtml` — страница только для чтения: всё через `esc`, без
 *    скриптов (CSP маршрута — `default-src 'none'`), три языка.
 * Чего в отчёте НЕТ: имён/синонимов, которые владелец не назначил целям,
 * значений полей, токенов, id кабинета и участников, журнала.
 */
import {
  effectiveRisk,
  markupSnippet,
  compensationOf,
  type VoiceMapContent,
  type VoiceMapTarget,
  type VoiceMapTemplate,
} from '../assist-ui-core/voice-map';
import {
  escHtml,
  reportPageCsp,
  reportPageHtml,
} from '../../common/report-page';
import { maskLabel, maskPagePath } from '../assist-ui-core/snapshot';

/**
 * Аудит захода 9 (P2-1): отчёт уходит по ссылке без входа — пути страниц и
 * образцов шаблона проходят маску ПД пути (`/u/ivan@x.com` → `/u/:email`),
 * подписи, имена и CSS — маску подписи. Черновик карты не меняется: маска —
 * только в снимке отчёта (HTML и JSON — один снимок).
 */
const mp = (p: string | null): string | null => (p ? maskPagePath(p) : p);
const ml = (t: string | null): string | null => (t ? maskLabel(t) : t);

export const DEV_REPORT_LIMITS = {
  /** Срок ссылки — 7 дней (разработчику нужно время, токен — только хешем). */
  ttlMs: 7 * 86_400_000,
  /** Строк отчёта — как целей карты (≤ 500). */
  items: 500,
  /** Сколько строк ссылок хранится на сайт (истёкшие/отозванные — вон). */
  keepRows: 20,
  tokenRe: /^[A-Za-z0-9_-]{20,128}$/,
} as const;

export type DevReportLang = 'uk' | 'ru' | 'en';

export interface DevReportItem {
  key: string;
  name: string | null;
  /** Тег и видимая подпись (маска ПД — при выборе в пикере). */
  element: string;
  css: string | null;
  /** Готовая строка для вёрстки; `null` — разметка уже есть. */
  line: string | null;
  /** Разметка, которая уже стоит (`data-assist-id`). */
  has: string | null;
  stability: string;
  risk: string;
  denylisted: boolean;
  /** Обратная цель «Как отменить» (`data-assist-id`) или null. */
  undo: string | null;
}

export interface DevReportGroup {
  /** Шаблон страниц (маска) или страница, или весь сайт. */
  kind: 'template' | 'page' | 'site';
  title: string;
  pattern: string | null;
  sample: string | null;
  items: DevReportItem[];
}

export interface DevReportContent {
  v: 1;
  host: string | null;
  platform: string | null;
  draftRevision: number;
  publishedVersion: number;
  generatedAt: string;
  counts: { targets: number; missing: number; never: number; fragile: number };
  groups: DevReportGroup[];
}

function itemOf(
  t: VoiceMapTarget,
  tpl: VoiceMapTemplate | null,
): DevReportItem {
  const d = t.descriptor;
  const snip = markupSnippet(t, tpl);
  const risk = effectiveRisk(t);
  // «Никогда» решил владелец (запрет/риск) — разработчику строка запрета;
  // «никогда» кода по тексту («Купити» без разметки, В-52) снимает именно
  // разметка — ему строка `data-assist-id`.
  const never = t.denylisted || t.riskOwner === 'never';
  const u = compensationOf(t);
  return {
    key: t.key,
    name: ml(t.names.uk ?? t.names.ru ?? t.names.en ?? null),
    element: `${d.tag}${d.role && d.role !== d.tag ? ` [${d.role}]` : ''}${
      d.text ? ` «${maskLabel(d.text)}»` : ''
    }`,
    css: ml(d.css),
    line: never
      ? d.neverAttr
        ? null
        : 'data-assist="never"'
      : (snip?.line ?? null),
    has: d.assistId ? `data-assist-id="${d.assistId}"` : null,
    stability: t.stability,
    risk,
    denylisted: t.denylisted,
    undo: u ? u.assistId : null,
  };
}

/** Снимок отчёта по черновику карты (активные цели и шаблоны). */
export function buildDevReport(
  c: VoiceMapContent,
  meta: {
    host: string | null;
    platform: string | null;
    draftRevision: number;
    publishedVersion: number;
    now: Date;
  },
): DevReportContent {
  const tpls = c.templates.filter((t) => t.status === 'active');
  const groups = new Map<string, DevReportGroup>();
  const groupOf = (t: VoiceMapTarget): DevReportGroup => {
    const tpl =
      t.scope === 'template'
        ? (tpls.find((x) => x.id === t.templateId) ?? null)
        : null;
    const id =
      t.scope === 'site'
        ? 'site'
        : tpl
          ? `t:${tpl.id}`
          : `p:${t.pagePath ?? '/'}`;
    let g = groups.get(id);
    if (!g) {
      g =
        t.scope === 'site'
          ? { kind: 'site', title: '*', pattern: null, sample: null, items: [] }
          : tpl
            ? {
                kind: 'template',
                title: maskLabel(tpl.name),
                pattern: mp(tpl.pathPattern),
                sample: mp(tpl.samplePages[0] ?? null),
                items: [],
              }
            : {
                kind: 'page',
                title: mp(t.pagePath ?? '/') as string,
                pattern: null,
                sample: mp(t.pagePath ?? '/'),
                items: [],
              };
      groups.set(id, g);
    }
    return g;
  };
  const counts = { targets: 0, missing: 0, never: 0, fragile: 0 };
  for (const t of c.targets) {
    if (t.status !== 'active') continue;
    if (counts.targets >= DEV_REPORT_LIMITS.items) break;
    if (t.scope === 'template' && !tpls.some((x) => x.id === t.templateId))
      continue;
    const g = groupOf(t);
    const tpl =
      t.scope === 'template'
        ? (tpls.find((x) => x.id === t.templateId) ?? null)
        : null;
    const it = itemOf(t, tpl);
    g.items.push(it);
    counts.targets++;
    if (it.line) counts.missing++;
    if (it.line === 'data-assist="never"' || d_never(t)) counts.never++;
    if (t.stability === 'fragile') counts.fragile++;
  }
  const order = { site: 0, template: 1, page: 2 } as const;
  return {
    v: 1,
    host: meta.host,
    platform: meta.platform,
    draftRevision: meta.draftRevision,
    publishedVersion: meta.publishedVersion,
    generatedAt: meta.now.toISOString(),
    counts,
    groups: [...groups.values()].sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        (a.pattern ?? a.title).localeCompare(b.pattern ?? b.title),
    ),
  };
}

function d_never(t: VoiceMapTarget): boolean {
  return t.denylisted || t.riskOwner === 'never';
}

// ── страница отчёта ─────────────────────────────────────────────────────

const T: Record<DevReportLang, Record<string, string>> = {
  uk: {
    title: 'Голосова карта — звіт для розробника',
    intro:
      'Додайте атрибути у верстку сайту: з ними голосовий помічник знаходить кнопки надійно. Значення полів і дані покупців у звіті відсутні.',
    site: 'Сайт',
    made: 'Сформовано',
    stats: 'Цілей: {t} · без розмітки: {m} · у забороні: {n} · ненадійних: {f}',
    tpl: 'Шаблон',
    page: 'Сторінка',
    all: 'Увесь сайт',
    sample: 'зразок',
    key: 'Ключ',
    el: 'Елемент',
    add: 'Додати атрибут',
    has: 'Вже є',
    undo: 'Як скасувати',
    never: 'помічник не натисне ніколи',
    fragile: 'ненадійно',
    ok: 'розмітка вже є',
    invalid:
      'Посилання недійсне, застаріло або відкликане — попросіть нове у власника сайту.',
    wp: 'WordPress / WooCommerce: плагін помічника розставляє атрибути сам — оновіть плагін.',
    shopify:
      'Shopify: атрибути — у файлах теми *.liquid (sections/, snippets/).',
    tilda:
      'Tilda / Хорошоп: де блок дозволяє власні атрибути — додайте; де ні — помічник шукає за роллю й текстом.',
  },
  ru: {
    title: 'Голосовая карта — отчёт для разработчика',
    intro:
      'Добавьте атрибуты в вёрстку сайта: с ними голосовой помощник находит кнопки надёжно. Значений полей и данных покупателей в отчёте нет.',
    site: 'Сайт',
    made: 'Сформирован',
    stats: 'Целей: {t} · без разметки: {m} · в запрете: {n} · ненадёжных: {f}',
    tpl: 'Шаблон',
    page: 'Страница',
    all: 'Весь сайт',
    sample: 'образец',
    key: 'Ключ',
    el: 'Элемент',
    add: 'Добавить атрибут',
    has: 'Уже есть',
    undo: 'Как отменить',
    never: 'помощник не нажмёт никогда',
    fragile: 'ненадёжно',
    ok: 'разметка уже есть',
    invalid:
      'Ссылка недействительна, устарела или отозвана — попросите новую у владельца сайта.',
    wp: 'WordPress / WooCommerce: плагин помощника расставляет атрибуты сам — обновите плагин.',
    shopify:
      'Shopify: атрибуты — в файлах темы *.liquid (sections/, snippets/).',
    tilda:
      'Tilda / Хорошоп: где блок разрешает свои атрибуты — добавьте; где нет — помощник ищет по роли и тексту.',
  },
  en: {
    title: 'Voice map — developer report',
    intro:
      'Add these attributes to the site markup: with them the voice assistant finds buttons reliably. The report contains no field values or customer data.',
    site: 'Site',
    made: 'Generated',
    stats: 'Targets: {t} · without markup: {m} · denied: {n} · fragile: {f}',
    tpl: 'Template',
    page: 'Page',
    all: 'Whole site',
    sample: 'sample',
    key: 'Key',
    el: 'Element',
    add: 'Add attribute',
    has: 'Already has',
    undo: 'How to undo',
    never: 'the assistant will never press it',
    fragile: 'fragile',
    ok: 'markup already present',
    invalid:
      'The link is invalid, expired or revoked — ask the site owner for a new one.',
    wp: 'WordPress / WooCommerce: the assistant plugin adds the attributes itself — update the plugin.',
    shopify:
      'Shopify: attributes go to theme *.liquid files (sections/, snippets/).',
    tilda:
      'Tilda / Horoshop: where a block allows custom attributes, add them; otherwise the assistant matches by role and text.',
  },
};

export function devReportLang(raw: unknown): DevReportLang {
  return raw === 'ru' || raw === 'en' ? raw : 'uk';
}

/** Экранирование — общее со страницей отчёта мастера (`common/report-page`). */
const esc = (s: string): string => escHtml(s);

const fill = (t: string, v: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''));

const STYLE =
  'body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px;color:#111;background:#fff}' +
  'h1{font-size:20px}h2{font-size:16px;margin-top:24px}code{background:#f3f4f6;padding:1px 4px;border-radius:4px}' +
  'table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e5e7eb;padding:6px;text-align:left;vertical-align:top}' +
  '.m{color:#6b7280;font-size:12px}.w{color:#b45309}.n{color:#7c3aed}' +
  '@media (prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#222}td,th{border-color:#333}}';

function page(lang: DevReportLang, title: string, body: string): string {
  return reportPageHtml({ lang, title, style: STYLE, body });
}

/** Страница «ссылка недействительна» — одна на все отказы (не оракул). */
export function devReportInvalidHtml(lang: DevReportLang): string {
  const L = T[lang];
  return page(
    lang,
    L.title,
    `<h1>${esc(L.title)}</h1><p>${esc(L.invalid)}</p>`,
  );
}

/** Страница отчёта: всё содержимое — через `esc`; скриптов нет. */
export function devReportHtml(
  c: DevReportContent,
  lang: DevReportLang,
): string {
  const L = T[lang];
  const out: string[] = [
    `<h1>${esc(L.title)}</h1>`,
    `<p>${esc(L.intro)}</p>`,
    `<p class="m">${esc(L.site)}: ${esc(c.host ?? '—')} · ${esc(L.made)}: ${esc(
      c.generatedAt.slice(0, 16).replace('T', ' '),
    )} UTC</p>`,
    `<p>${esc(
      fill(L.stats, {
        t: c.counts.targets,
        m: c.counts.missing,
        n: c.counts.never,
        f: c.counts.fragile,
      }),
    )}</p>`,
  ];
  const pf = (c.platform ?? '').split('@')[0];
  out.push(
    `<p class="m">${esc(
      pf === 'woocommerce'
        ? L.wp
        : pf === 'shopify'
          ? L.shopify
          : pf === 'tilda' || pf === 'horoshop'
            ? L.tilda
            : [L.wp, L.shopify, L.tilda].join(' '),
    )}</p>`,
  );
  for (const g of c.groups) {
    const head =
      g.kind === 'site'
        ? L.all
        : g.kind === 'template'
          ? `${L.tpl}: ${g.title} (${g.pattern ?? ''})`
          : `${L.page}: ${g.title}`;
    out.push(
      `<h2>${esc(head)}</h2>`,
      g.sample && g.kind === 'template'
        ? `<p class="m">${esc(L.sample)}: ${esc(g.sample)}</p>`
        : '',
      `<table><tr><th>${esc(L.key)}</th><th>${esc(L.el)}</th><th>${esc(
        L.add,
      )}</th></tr>`,
    );
    for (const i of g.items) {
      const notes = [
        i.denylisted || i.line === 'data-assist="never"'
          ? `<span class="n">${esc(L.never)}</span>`
          : '',
        i.stability === 'fragile'
          ? `<span class="w">${esc(L.fragile)}</span>`
          : '',
        i.undo
          ? `${esc(L.undo)}: <code>data-assist-id="${esc(i.undo)}"</code>`
          : '',
      ].filter(Boolean);
      out.push(
        '<tr>',
        `<td><code>${esc(i.key)}</code>${i.name ? `<br>${esc(i.name)}` : ''}</td>`,
        `<td>${esc(i.element)}${i.css ? `<br><span class="m">css: ${esc(i.css)}</span>` : ''}${
          notes.length ? `<br>${notes.join(' · ')}` : ''
        }</td>`,
        `<td>${
          i.line
            ? `<code>${esc(i.line)}</code>`
            : `<span class="m">${esc(L.ok)}</span>`
        }${i.has ? `<br><span class="m">${esc(L.has)}: ${esc(i.has)}</span>` : ''}</td>`,
        '</tr>',
      );
    }
    out.push('</table>');
  }
  return page(lang, L.title, out.join('\n'));
}

/** CSP страницы отчёта: ни скриптов, ни ресурсов, ни встраивания, ни форм. */
export const DEV_REPORT_CSP = reportPageCsp("'none'");
