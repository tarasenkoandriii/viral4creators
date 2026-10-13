/**
 * AI Publisher — протокол прогона набора 30 задач и подсчёт порогов (P-B2,
 * проектный документ §12.6, §18.2; `pilot-ai-eval-v2.md`, «Протокол
 * будущего запуска»).
 *
 * На каждую задачу: model/provider, версия инструкции, вход, разрешённые
 * источники, фактический (ПЕРВЫЙ) ответ, источник каждой проверяемой
 * фразы, жёсткие провалы, флаги и их разбор, `critical_pass`,
 * `usefulness_pass`, объяснение оценки, затраты и дата. Повтор задачи —
 * отдельная строка со ссылкой (`retryOfResultId`): первый результат в
 * протоколе остаётся.
 *
 * Порог применения (§12.6, ≡ триггер `pub_eval_guard`; аудит S1-1): по
 * ПЕРВОМУ ответу каждой задачи (самая ранняя строка, где модель ответила:
 * всё, кроме `not_run:*`/`no_answer:*`, предаудит D2-01) — все 30
 * оценены человеком, 30 `criticalPass` и `usefulnessPass` ≥ 24; плюс НИ ОДНОЙ строки с ответом (включая повторы)
 * с жёстким автопровалом или `criticalPass ≠ true`: повтор не заменяет
 * первый ответ и не скрывает провал. Строка без ответа (модель не
 * вызывалась; таймаут/недоступность без расхода) ответом не считается —
 * её повтор и есть первый ответ; обрезанный или пустой оплаченный ответ —
 * ответ и провал. Прогон `fake` порог не открывает никогда.
 *
 * Чистый модуль.
 */
import type { AiCallParams } from '../config';
import { EVAL_TASKS } from './tasks';

export const EVAL_TASK_COUNT = 30;
export const USEFULNESS_THRESHOLD = 24;

export interface FlagResolution {
  flagId: string;
  resolution: 'confirmed' | 'dismissed';
  explanation: string;
  by: string;
  at: string;
}

export interface ResultRow {
  id: string;
  taskCode: string;
  schema: string;
  input: unknown;
  allowedSourceIds: string[];
  firstAnswer: unknown;
  firstAnswerRaw: string | null;
  claimSources: unknown;
  autoHardFail: Array<{ code: string; text: string }>;
  autoFlags: Array<{ id: string; code: string; text: string }>;
  flagResolutions: FlagResolution[];
  criticalPass: boolean | null;
  usefulnessPass: boolean | null;
  explanation: string | null;
  reviewerMemberId: string | null;
  secondReviewerMemberId: string | null;
  costMicroUsd: string | null;
  costStatus: string;
  retryOfResultId: string | null;
  createdAt: string;
}

export interface RunInfo {
  id: string;
  mode: 'fake' | 'live';
  startedAt: string;
  finishedAt: string | null;
  config: {
    id: string;
    provider: string;
    model: string;
    configHash: string;
    instructionVersions: Record<string, string>;
    contextRulesVersion: string;
    schemaSetVersion: string;
    evalSetVersion: string;
    evalStatus: string;
  };
}

export interface Totals {
  mode: 'fake' | 'live';
  tasks: number;
  results: number;
  hardFailed: number;
  flagged: number;
  flagsOpen: number;
  graded: number;
  criticalPass: number;
  usefulnessPass: number;
  /** Строк (в т. ч. повторов) с провалом или без оценки — блокируют допуск. */
  blocking: number;
  /** Порог §12.6 по первым ответам; у `fake` — всегда false. */
  thresholdsMet: boolean;
  /** Сумма известных затрат (микродоллары строкой) и число неизвестных. */
  costMicroUsd: string;
  costUnknown: number;
  /** Hash синтетики S1–S7 прогона (итоги CLI; аудит S3-10). */
  fixtureSetHash?: string;
  /** Параметры вызова модели прогона (итоги CLI; предаудит D2-04). */
  callParams?: AiCallParams;
}

/** Решения по флагам: последнее по каждому `flagId`. */
export function latestResolutions(
  r: Pick<ResultRow, 'flagResolutions'>,
): Map<string, FlagResolution> {
  const out = new Map<string, FlagResolution>();
  for (const x of r.flagResolutions) out.set(x.flagId, x);
  return out;
}

/** Флаги без решения человека. */
export function openFlags(
  r: Pick<ResultRow, 'autoFlags' | 'flagResolutions'>,
): string[] {
  const done = latestResolutions(r);
  return r.autoFlags.filter((f) => !done.has(f.id)).map((f) => f.id);
}

/**
 * Строка — ответ модели (предаудит D2-01, ≡ триггер `pub_eval_guard`):
 * всё, кроме строк «модель не вызывалась» (`not_run:*`) и «провайдер не
 * вернул ответа, расхода нет» (`no_answer:*`). Обрезанный, пустой,
 * не-JSON ответ — ответ (и провал).
 */
export const NO_ANSWER_RE = /^(not_run|no_answer):/;

export const isAnswered = (r: Pick<ResultRow, 'autoHardFail'>): boolean =>
  !r.autoHardFail.some((h) => NO_ANSWER_RE.test(h.code));

/**
 * Первый ответ каждой задачи (аудит S1-1): самая ранняя строка с ответом
 * (`createdAt`, затем `id` — как `ORDER BY` триггера). Повтор — отдельная
 * строка и первую не заменяет.
 */
export function firstByTask(
  results: readonly ResultRow[],
): Map<string, ResultRow> {
  const out = new Map<string, ResultRow>();
  const sorted = results.filter(isAnswered).sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (const r of sorted) if (!out.has(r.taskCode)) out.set(r.taskCode, r);
  return out;
}

/** Строка с ответом блокирует допуск: жёсткий автопровал или `criticalPass ≠ true`. */
export function isBlocking(
  r: Pick<ResultRow, 'criticalPass' | 'autoHardFail'>,
): boolean {
  return (
    isAnswered(r) && (r.criticalPass !== true || r.autoHardFail.length > 0)
  );
}

export function totalsOf(
  mode: 'fake' | 'live',
  results: readonly ResultRow[],
): Totals {
  const first = [...firstByTask(results).values()];
  const blocking = results.filter(isBlocking).length;
  const graded = first.filter(
    (r) => r.criticalPass !== null && r.usefulnessPass !== null,
  );
  const critical = graded.filter((r) => r.criticalPass === true).length;
  const useful = graded.filter((r) => r.usefulnessPass === true).length;
  let cost = 0n;
  let unknown = 0;
  for (const r of results) {
    if (r.costStatus === 'priced' && r.costMicroUsd !== null)
      cost += BigInt(r.costMicroUsd);
    else unknown++;
  }
  return {
    mode,
    tasks: new Set(results.map((r) => r.taskCode)).size,
    results: results.length,
    hardFailed: results.filter((r) => r.autoHardFail.length > 0).length,
    flagged: results.filter((r) => r.autoFlags.length > 0).length,
    flagsOpen: results.reduce((n, r) => n + openFlags(r).length, 0),
    graded: graded.length,
    criticalPass: critical,
    usefulnessPass: useful,
    blocking,
    thresholdsMet:
      mode === 'live' &&
      graded.length === EVAL_TASK_COUNT &&
      critical === EVAL_TASK_COUNT &&
      useful >= USEFULNESS_THRESHOLD &&
      blocking === 0,
    costMicroUsd: cost.toString(),
    costUnknown: unknown,
  };
}

export interface Protocol {
  evalSetVersion: string;
  run: RunInfo;
  totals: Totals;
  tasks: Array<{
    code: string;
    group: string;
    schema: string;
    generator: string;
    mode: string;
    instructionVersion: string | null;
    results: ResultRow[];
  }>;
}

export function protocolOf(
  run: RunInfo,
  results: readonly ResultRow[],
): Protocol {
  return {
    evalSetVersion: run.config.evalSetVersion,
    run,
    totals: totalsOf(run.mode, results),
    tasks: EVAL_TASKS.map((t) => ({
      code: t.code,
      group: t.group,
      schema: t.schema,
      generator: t.generator,
      mode: t.mode,
      instructionVersion: run.config.instructionVersions[t.generator] ?? null,
      results: results
        .filter((r) => r.taskCode === t.code)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    })),
  };
}

const yesNo = (v: boolean | null): string =>
  v === null ? '—' : v ? 'так' : 'ні';
const cell = (s: string): string =>
  s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

function callParamsLine(c: AiCallParams | undefined): string {
  if (!c) return 'не записані';
  const out = Object.entries(c.maxOutputTokens)
    .map(([g, n]) => `${g} ${n}`)
    .join(', ');
  return `temperature ${c.temperature}, json ${c.json}, maxOutputTokens {${out}}, запас на роздуми +${c.thinkingHeadroom}, бюджет роздумів ${c.thinkingBudget}`;
}

/** Протокол в Markdown (для человека; без контактов — их в наборе нет). */
export function protocolMarkdown(p: Protocol): string {
  const t = p.totals;
  const lines: string[] = [
    `# Протокол набору AI ${p.evalSetVersion}`,
    '',
    `- Прогін: \`${p.run.id}\`, режим **${p.run.mode}**${p.run.mode === 'fake' ? ' (механіка CI — не проходження набору)' : ''}`,
    `- Конфігурація: \`${p.run.config.configHash.slice(0, 16)}…\` — ${p.run.config.provider} / ${p.run.config.model}, статус ${p.run.config.evalStatus}`,
    `- Правила контексту ${p.run.config.contextRulesVersion}, схеми ${p.run.config.schemaSetVersion}`,
    `- Параметри виклику: ${callParamsLine(t.callParams)}`,
    `- Почато ${p.run.startedAt}${p.run.finishedAt ? `, завершено ${p.run.finishedAt}` : ''}`,
    `- Оцінено ${t.graded}/${EVAL_TASK_COUNT} (за першою відповіддю); critical_pass ${t.criticalPass}/${EVAL_TASK_COUNT}; usefulness_pass ${t.usefulnessPass} (поріг ${USEFULNESS_THRESHOLD}); жорстких провалів ${t.hardFailed}; відкритих прапорців ${t.flagsOpen}`,
    `- Рядків, що блокують допуск (провал або без оцінки, разом із повторами): ${t.blocking ?? 0}`,
    `- Поріг застосування: **${t.thresholdsMet ? 'досягнуто' : 'не досягнуто'}**; витрати ${t.costMicroUsd} мкд USD${t.costUnknown ? `, невідомих ${t.costUnknown}` : ''}`,
    '',
    '| Задача | Схема | Інструкція | Жорсткі провали | Прапорці (розбір) | critical | usefulness | Пояснення |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const task of p.tasks) {
    if (task.results.length === 0) {
      lines.push(
        `| ${task.code} | ${task.schema} | ${task.instructionVersion ?? '—'} | не запускалась | — | — | — | — |`,
      );
      continue;
    }
    for (const r of task.results) {
      const res = latestResolutions(r);
      const flags = r.autoFlags.length
        ? r.autoFlags
            .map((f) => `${f.code}: ${res.get(f.id)?.resolution ?? 'відкрито'}`)
            .join('; ')
        : '—';
      lines.push(
        `| ${task.code}${r.retryOfResultId ? ' (повтор — не замінює першу)' : ' (перша відповідь)'} | ${task.schema} | ${task.instructionVersion ?? '—'} | ${
          r.autoHardFail.length
            ? cell(r.autoHardFail.map((h) => h.code).join(', '))
            : '—'
        } | ${cell(flags)} | ${yesNo(r.criticalPass)} | ${yesNo(r.usefulnessPass)} | ${cell(r.explanation ?? '—')} |`,
      );
    }
  }
  lines.push('', '## Відповіді (перші)', '');
  for (const task of p.tasks) {
    for (const r of task.results) {
      lines.push(
        `### ${task.code}${r.retryOfResultId ? ' (повтор)' : ''}`,
        '',
        `Вхід: ${cell(String((r.input as { prompt?: unknown } | null)?.prompt ?? ''))}`,
        '',
        '```json',
        r.firstAnswer === null || r.firstAnswer === undefined
          ? (r.firstAnswerRaw ?? '(немає відповіді)')
          : JSON.stringify(r.firstAnswer, null, 2),
        '```',
        '',
      );
    }
  }
  return lines.join('\n');
}
