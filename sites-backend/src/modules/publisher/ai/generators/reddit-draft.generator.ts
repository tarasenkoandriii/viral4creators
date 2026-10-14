/**
 * Генератор `pub.reddit.draft` — черновики Reddit (P-R M2, reddit-manual-
 * mvp-adapted.md §M2.3; Р-RD-15, Р-RD-17). Один генератор, пять шаблонов в
 * одной инструкции, 2–3 варианта одним вызовом (не съедают
 * `BASE_GENERATIONS`).
 *
 * Изоляция недоверенного текста: выдержка треда и правила сообщества — в
 * `<thread trust="untrusted">` и `<community_rules trust="untrusted">`
 * (экранирование; `flag="possible_instruction"` по `injectionFlag`
 * выдержки), бриф и запрос редактора — `<request trust="untrusted">`;
 * контакты маскирует шлюз (`preparePrompt`/`maskDeep`) до сборки промпта.
 * Выдержка треда — НЕ источник контекста: restricted не подтверждает
 * утверждения (Р-RD-4).
 *
 * Выключен в коде (`enabledInP0=false`) до живого прогона набора 2.3: в
 * кабинете шлюз пишет `disabled`, в прогоне набора (CLI) — исполняется
 * (покрыт набором, `EVAL_COVERED_GENERATORS`).
 *
 * Проверки ответа:
 *  - против входа как ошибка схемы (`inputIssues`, одна повторная попытка):
 *    число вариантов = запрошенному, у комментария `title=null`, у поста —
 *    заголовок;
 *  - находки (`inputFindings`, видят вход): общие (`source_outside_context`,
 *    `forbidden_promise` — critical; `number_not_in_context` — warning) и
 *    Reddit — `link_present` (по политике ссылок), `first_person_experience`
 *    (при `affiliation ≠ customer`), `disclosure_missing` — critical.
 */
import type { AiContext, PostCheckFinding } from '../../contracts/ai';
import {
  REDDIT_DRAFT_SCHEMA,
  type RedditDraftOutput,
} from '../../contracts/ai-schemas';
import type { FieldIssue } from '../../contracts/errors';
import {
  disclosureIssue,
  firstPersonMarkers,
  linkFindings,
} from '../../reddit/markers';
import * as instr from '../instructions/reddit-draft.v1';
import { commonPostCheck, escapeData, prompt, renderRequest } from './common';
import type { PubGeneratorSpec } from './spec';

export const REDDIT_DRAFT_TEMPLATES = [
  'helpful_answer',
  'educational_post',
  'comparison',
  'troubleshooting',
  'feedback_request',
] as const;
export type RedditDraftTemplate = (typeof REDDIT_DRAFT_TEMPLATES)[number];

export interface RedditDraftInput {
  template: RedditDraftTemplate;
  contentType: 'post' | 'comment';
  variants: 2 | 3;
  brief: {
    objective: string;
    audience: string | null;
    keyPoints: Array<{
      text: string;
      sourceIds: string[] | 'needs_verification';
    }>;
    affiliation: 'founder' | 'employee' | 'agency' | 'customer' | 'none';
    /** Имя продукта/бренда — должно стоять в раскрытии (Р-RD-65). */
    brand?: string | null;
    tone: string | null;
    language: string;
    constraints: string[];
    forbiddenClaims: string[];
    cta: string | null;
    linksAllowed: boolean;
  };
  community: {
    name: string;
    rules: {
      promotionPolicy: string;
      linksPolicy: string;
      flairRequired: boolean | null;
      conditions: string[];
    } | null;
  };
  thread: {
    title: string;
    excerpt: string | null;
    injectionFlag: string | null;
  } | null;
  /** Указание редактора (≤ 1000). */
  request: string | null;
  /** «Перегенерировать абзац»: текущий черновик и номер абзаца. */
  rewrite: { body: string; paragraph: number } | null;
}

const attr = (v: string): string => escapeData(v).replace(/"/g, '&quot;');

function renderBrief(i: RedditDraftInput): string {
  const b = i.brief;
  const lines = [
    `Шаблон: ${i.template}. Тип: ${i.contentType}. Варіантів: ${i.variants}.`,
    `objective: ${b.objective}`,
    `audience: ${b.audience ?? '—'}`,
    `affiliation: ${b.affiliation}`,
    `brand: ${b.brand ?? '—'}`,
    `language: ${b.language}`,
    `tone: ${b.tone ?? '—'}`,
    `linksAllowed: ${b.linksAllowed}`,
    `cta: ${b.cta ?? '—'}`,
    'keyPoints:',
    ...b.keyPoints.map(
      (k, n) =>
        `  ${n + 1}. ${k.text} [${Array.isArray(k.sourceIds) ? k.sourceIds.join(', ') : k.sourceIds}]`,
    ),
    'constraints:',
    ...b.constraints.map((c) => `  - ${c}`),
    'forbiddenClaims:',
    ...b.forbiddenClaims.map((c) => `  - ${c}`),
  ];
  return renderRequest('brief', lines.join('\n'));
}

/** Правила сообщества — недоверенные данные (условия вводит человек с сайта Reddit). */
export function renderCommunityRules(i: RedditDraftInput): string {
  const r = i.community.rules;
  const body = r
    ? [
        `promotionPolicy: ${r.promotionPolicy}`,
        `linksPolicy: ${r.linksPolicy}`,
        `flairRequired: ${r.flairRequired === null ? 'unknown' : r.flairRequired}`,
        'conditions:',
        ...r.conditions.map((c) => `  - ${c}`),
      ].join('\n')
    : 'правил немає';
  return `<community_rules name="${attr(`r/${i.community.name}`)}" trust="untrusted">\n${escapeData(body)}\n</community_rules>`;
}

/** Тред (заголовок и выдержка) — недоверенные данные; пометка команды не удаляет текст. */
export function renderThread(i: RedditDraftInput): string | null {
  if (!i.thread) return null;
  const attrs = [
    'trust="untrusted"',
    ...(i.thread.injectionFlag ? ['flag="possible_instruction"'] : []),
  ];
  return `<thread ${attrs.join(' ')}>\n${escapeData(i.thread.title)}\n\n${escapeData(i.thread.excerpt ?? '(витримки немає)')}\n</thread>`;
}

/** Тексты входа, которые дают «известные» числа (кроме выдержки треда). */
function inputTexts(i: RedditDraftInput): string[] {
  return [
    i.brief.objective,
    i.brief.audience ?? '',
    i.brief.cta ?? '',
    ...i.brief.keyPoints.map((k) => k.text),
    ...i.brief.constraints,
    i.request ?? '',
    i.rewrite?.body ?? '',
    ...(i.community.rules?.conditions ?? []),
  ];
}

/** Ссылки запрещены брифом или правилами (prohibited/unknown, правил нет). */
export function linksForbidden(i: RedditDraftInput): boolean {
  const p = i.community.rules?.linksPolicy;
  return !i.brief.linksAllowed || !p || p === 'prohibited' || p === 'unknown';
}

/** Находки Reddit по вариантам (код — один раз, варианты — в тексте). */
export function redditFindings(
  out: RedditDraftOutput,
  input: RedditDraftInput,
): PostCheckFinding[] {
  const hits = {
    link: [] as number[],
    first: [] as number[],
    disc: [] as number[],
  };
  out.variants.forEach((v, n) => {
    const text = `${v.title ?? ''}\n${v.body}`;
    // Подсказка AI строже проверки: и «похоже на ссылку» (markers@3).
    const lf = linkFindings(text);
    if (linksForbidden(input) && (lf.links.length || lf.suspect.length))
      hits.link.push(n + 1);
    if (
      input.brief.affiliation !== 'customer' &&
      firstPersonMarkers(text).length
    )
      hits.first.push(n + 1);
    if (
      input.brief.affiliation !== 'none' &&
      disclosureIssue(
        v.body,
        v.disclosure,
        input.brief.brand ?? null,
        input.brief.affiliation,
        input.contentType === 'post' ? v.title : null,
      ) !== null
    )
      hits.disc.push(n + 1);
  });
  const out2: PostCheckFinding[] = [];
  if (hits.link.length)
    out2.push({
      code: 'link_present',
      severity: 'critical',
      text: `Посилання там, де їх заборонено: варіанти ${hits.link.join(', ')}`,
    });
  if (hits.first.length)
    out2.push({
      code: 'first_person_experience',
      severity: 'critical',
      text: `Особистий досвід від першої особи: варіанти ${hits.first.join(', ')}`,
    });
  if (hits.disc.length)
    out2.push({
      code: 'disclosure_missing',
      severity: 'critical',
      text: `Немає розкриття в перших 300 знаках: варіанти ${hits.disc.join(', ')}`,
    });
  return out2;
}

export const REDDIT_DRAFT: PubGeneratorSpec<
  RedditDraftInput,
  RedditDraftOutput
> = {
  id: 'pub.reddit.draft',
  instructionVersion: instr.INSTRUCTION_VERSION,
  contextRulesVersion: 'ctx@1',
  schema: REDDIT_DRAFT_SCHEMA,
  // Р-RD-17: до живого eval 2.3 — выключен (кабинет: `disabled`).
  enabledInP0: false,
  maxOutputTokens: 6000,
  buildPrompt: (input, ctx: AiContext) =>
    prompt(instr.INSTRUCTION_TEXT, ctx, [
      renderBrief(input),
      renderCommunityRules(input),
      ...(renderThread(input) ? [renderThread(input)!] : []),
      ...(input.rewrite
        ? [
            renderRequest(
              'rewrite',
              `Абзац №${input.rewrite.paragraph + 1} (рахуючи з 1) чернетки:\n\n${input.rewrite.body}`,
            ),
          ]
        : []),
      ...(input.request ? [renderRequest('request', input.request)] : []),
    ]),
  inputIssues: (out, input): FieldIssue[] => {
    const issues: FieldIssue[] = [];
    if (out.variants.length !== input.variants)
      issues.push({ field: 'variants', code: 'count' });
    out.variants.forEach((v, n) => {
      if (input.contentType === 'comment' && v.title !== null)
        issues.push({ field: `variants[${n}].title`, code: 'comment_title' });
      if (input.contentType === 'post' && v.title === null)
        issues.push({ field: `variants[${n}].title`, code: 'required' });
    });
    return issues;
  },
  inputFindings: (out, input, ctx) => [
    ...commonPostCheck(out, ctx, inputTexts(input)),
    ...redditFindings(out, input),
  ],
};
