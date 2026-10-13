/**
 * AI Publisher — общее для девяти генераторов (P-B2, проектный документ
 * §12.1–12.3): разметка контекста как недоверенных данных, сборка промпта,
 * проверки ответа после схемы (`postCheck`).
 *
 * Правила `ctx@1` (§12.3):
 *  - каждый фрагмент источника — в `<source id trust="untrusted">`, угловые
 *    скобки внутри экранированы (фрагмент не может «закрыть» тег и выдать
 *    себя за инструкцию); `flag="possible_instruction"` — `detectInjection`
 *    пометил фрагмент, но НЕ удалил (AI-25 проверяет, что модель не
 *    исполняет);
 *  - запрос человека — тоже недоверенные данные (`<request>`);
 *  - запрещённые обещания — отдельным блоком ограничений.
 *
 * Чистый модуль: без Nest и базы.
 */
import type {
  AiContext,
  AiContextSource,
  PostCheckFinding,
} from '../../contracts/ai';
import { sourceIdsOutside } from '../../contracts/ai-schemas';

/** Экранирование данных внутри XML-подобной разметки промпта. */
export function escapeData(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const attr = (v: string): string => escapeData(v).replace(/"/g, '&quot;');

function renderSource(src: AiContextSource & { historical?: boolean }): string {
  const attrs = [
    `id="${attr(src.id)}"`,
    'trust="untrusted"',
    `visibility="${src.visibility}"`,
    ...(src.injectionFlag ? ['flag="possible_instruction"'] : []),
    ...(src.historical ? ['historical="true"'] : []),
  ];
  const title = src.title ? `${escapeData(src.title)}\n` : '';
  const hist = src.historical ? 'історична версія, не чинна\n' : '';
  return `<source ${attrs.join(' ')}>\n${hist}${title}${escapeData(src.fragment)}\n</source>`;
}

function valueText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (
      typeof o.amountMinor === 'number' ||
      typeof o.amountMinor === 'string'
    ) {
      const minor = BigInt(o.amountMinor as string | number);
      const cur = typeof o.currency === 'string' ? ` ${o.currency}` : '';
      const note = typeof o.note === 'string' ? ` (${o.note})` : '';
      const whole = minor / 100n;
      const frac = minor % 100n;
      return `${whole}${frac ? `.${String(frac).padStart(2, '0')}` : ''}${cur}${note}`;
    }
    if (typeof o.question === 'string' && typeof o.answer === 'string') {
      return `${o.question} — ${o.answer}`;
    }
  }
  return JSON.stringify(v);
}

/** Текст запрещённого обещания факта бренда (для проверки ответа). */
export function forbiddenPromiseTexts(ctx: AiContext): string[] {
  return ctx.facts
    .filter((f) => f.kind === 'forbidden_promise')
    .map((f) => valueText(f.value).trim())
    .filter((t) => t.length >= 3);
}

/** Блок контекста промпта (§12.3, `ctx@1`). */
export function renderContext(ctx: AiContext): string {
  const parts: string[] = [
    `<context rules="${ctx.rulesVersion}" audience="${ctx.audience}">`,
  ];
  if (ctx.offer) {
    parts.push(
      `<offer id="${attr(ctx.offer.id)}" version="${ctx.offer.version}" status="active">\n` +
        `${escapeData(ctx.offer.title)}\n${escapeData(ctx.offer.text)}` +
        (ctx.offer.priceNote ? `\n${escapeData(ctx.offer.priceNote)}` : '') +
        '\n</offer>',
    );
  } else {
    parts.push('<offer status="none">активного оферу немає</offer>');
  }
  const facts = ctx.facts.filter((f) => f.kind !== 'forbidden_promise');
  if (facts.length) {
    parts.push(
      '<facts status="active">\n' +
        facts
          .map(
            (f) =>
              `- [${attr(f.id)}] ${escapeData(f.factKey)} (${f.kind}, v${f.version}): ${escapeData(valueText(f.value))}`,
          )
          .join('\n') +
        '\n</facts>',
    );
  }
  const forbidden = forbiddenPromiseTexts(ctx);
  if (forbidden.length) {
    parts.push(
      '<forbidden_promises>\n' +
        forbidden.map((t) => `- ${escapeData(t)}`).join('\n') +
        '\n</forbidden_promises>',
    );
  }
  if (ctx.sources.length === 0) {
    parts.push('<sources count="0">джерел для цього запиту немає</sources>');
  }
  for (const s of ctx.sources) parts.push(renderSource(s));
  parts.push('</context>');
  return parts.join('\n');
}

/** Запрос человека — недоверенные данные. */
export function renderRequest(label: string, text: string): string {
  return `<request kind="${attr(label)}" trust="untrusted">\n${escapeData(text)}\n</request>`;
}

/** Промпт генератора: инструкция → system, контекст + запрос → user. */
export function prompt(
  instruction: string,
  ctx: AiContext,
  request: string[],
): { system: string; user: string } {
  return {
    system: instruction,
    user: [renderContext(ctx), ...request].join('\n\n'),
  };
}

/** Все строки ответа (для проверок текста). */
export function stringsOf(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(v);
  return out;
}

const NUMBER_RE = /\d[\d\s  ]*\d|\d/g;

/** Числа текста (пробелы-разделители тысяч убраны). */
export function numbersIn(text: string): string[] {
  return (text.match(NUMBER_RE) ?? [])
    .map((n) => n.replace(/[\s  ]/g, ''))
    .filter((n) => n.length > 0);
}

/**
 * Однозначное число, которое что-то утверждает (предаудит D2-05): цифра
 * рядом с единицей («3 тижні», «5 %», «$5», «2 заявки»). Номера пунктов
 * («1.», «2)»), части слов и меток («S3», «v2»), дробей («2.5») — не
 * считаются: у них нет единицы.
 */
const UNIT_AFTER =
  /^\s?(%|відсот|процент|грн|₴|uah|usd|eur|\$|€|тиж|недел|дн|день|доб|год|хв|мін|міс|рок|рік|лет|раз|людин|осіб|клієнт|заяв|публікац|переход|сесі|лід)/u;

export function unitDigitsIn(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!/\d/.test(text[i])) continue;
    const prev = text[i - 1] ?? '';
    const next = text[i + 1] ?? '';
    if (/\d/.test(prev) || /\d/.test(next)) continue;
    if (/[.,]/.test(next) && /\d/.test(text[i + 2] ?? '')) continue;
    if (/[.,]/.test(prev) && /\d/.test(text[i - 2] ?? '')) continue;
    if (/[\p{L}_-]/u.test(prev)) continue;
    const after = text.slice(i + 1, i + 16).toLowerCase();
    const before = text.slice(Math.max(0, i - 2), i);
    if (UNIT_AFTER.test(after) || /[$€₴]\s?$/u.test(before)) {
      out.push(text[i]);
    }
  }
  return out;
}

/** Находка «числа вне контекста» с самими числами (предаудит D2-05). */
export type NumberFinding = PostCheckFinding & { values: string[] };

function contextText(ctx: AiContext, extra: string[]): string {
  return [
    ...ctx.sources.map((s) => `${s.title ?? ''} ${s.fragment}`),
    ...ctx.facts.map((f) => valueText(f.value)),
    ctx.offer
      ? `${ctx.offer.title} ${ctx.offer.text} ${ctx.offer.priceNote ?? ''}`
      : '',
    ...extra,
  ].join('\n');
}

/**
 * Общие проверки ответа после схемы (§12.1 `postCheck`): id источников вне
 * контекста — критично; запрещённое обещание — критично; число, которого
 * нет ни в контексте, ни в запросе, — предупреждение человеку; слово
 * «гарант…» — предупреждение (правильный ответ «без гарантій» тоже его
 * содержит — решает человек).
 */
export function commonPostCheck(
  out: unknown,
  ctx: AiContext,
  requestTexts: string[] = [],
): PostCheckFinding[] {
  const findings: PostCheckFinding[] = [];
  const outside = sourceIdsOutside(
    out,
    ctx.sources.map((s) => s.id),
  );
  if (outside.length) {
    findings.push({
      code: 'source_outside_context',
      severity: 'critical',
      text: `Посилання на джерела поза контекстом: ${outside.join(', ')}`,
    });
  }
  const text = stringsOf(out).join('\n').toLowerCase();
  for (const promise of forbiddenPromiseTexts(ctx)) {
    if (text.includes(promise.toLowerCase())) {
      findings.push({
        code: 'forbidden_promise',
        severity: 'critical',
        text: `Заборонена обіцянка: «${promise.slice(0, 200)}»`,
      });
    }
  }
  const known = new Set(numbersIn(contextText(ctx, requestTexts)));
  // id контекста (`used_source_ids` и т. п.) — не утверждения: цифры
  // внутри cuid не «числа вне контекста».
  const ids = new Set<string>([
    ...ctx.sources.map((x) => x.id),
    ...ctx.facts.map((f) => f.id),
    ...(ctx.offer ? [ctx.offer.id] : []),
  ]);
  const outText = stringsOf(out)
    .filter((x) => !ids.has(x))
    .join('\n');
  const unknownNumbers = [
    ...new Set([
      ...numbersIn(outText).filter((n) => n.length >= 2),
      ...unitDigitsIn(outText),
    ]),
  ]
    .filter((n) => !known.has(n))
    .slice(0, 10);
  if (unknownNumbers.length) {
    const f: NumberFinding = {
      code: 'number_not_in_context',
      severity: 'warning',
      text: `Числа, яких немає в контексті: ${unknownNumbers.join(', ')}`,
      values: unknownNumbers,
    };
    findings.push(f);
  }
  if (/гарант/u.test(text)) {
    findings.push({
      code: 'guarantee_word',
      severity: 'warning',
      text: 'У відповіді є слово «гарант…» — перевірте, що це не обіцянка',
    });
  }
  return findings;
}

/** id из ответа вне переданного списка (вопросы, каналы, версии, площадки). */
export function idsOutside(
  ids: readonly string[],
  allowed: readonly string[],
): string[] {
  const ok = new Set(allowed);
  return [...new Set(ids.filter((id) => !ok.has(id)))];
}
