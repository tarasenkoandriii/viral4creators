/**
 * AI Publisher — закрытый (аудиторский) набор задач из файла вне
 * репозитория: `npm run eval:publisher -- --tasks-file=<json>` (внутренний
 * аудит D2 §6 «что добавить», Р-IA-FXB-4).
 *
 * Задачи файла идут через ТОТ ЖЕ шлюз, схемы, контекст `ctx@1`, маску и
 * журнал вызовов (`pub_ai_calls`, `system:eval`), что и набор 2.2/2.3, но
 * НЕ пишутся в `pub_ai_eval_runs/results`: закрытый набор — измерение для
 * аудитора, основанием `passed` он не является (триггер набора принимает
 * только AI-01…AI-42). Протокол — только в файлы `--out/--json`.
 *
 * Формат файла (версия 1):
 *
 *   {
 *     "version": 1,
 *     "name": "ia-d2-extra-set-v2",
 *     "sources": [                       // необязательно: свои источники
 *       { "code": "Y19", "title": "…", "fragment": "…",
 *         "usage": "allowed", "visibility": "public" }
 *     ],
 *     "tasks": [
 *       { "code": "Y-19", "generator": "pub.helper.answer",
 *         "mode": "internal", "language": "uk",
 *         "allowedSources": ["S1", "Y19"],
 *         "input": { "prompt": "…" },          // + format/parentVersion/reddit
 *         "hard":  [ { "code": "…", "text": "…", "pattern": "…", "when": "present" } ],
 *         "flags": [ { "code": "…", "text": "…", "pattern": "…", "when": "absent" } ],
 *         "fakeAnswer": { … } }          // необязательно: ответ режима fake
 *     ]
 *   }
 *
 * Проверки — регулярные выражения (флаги `u` и `i` по умолчанию) по тексту
 * ответа без id источников и меток версий (`checkText`, IA-D2-01):
 * `present` — признак сработал, если совпадение есть; `absent` — если нет.
 * Общие жёсткие провалы (схема, источники вне разрешённых, канарейки, язык)
 * — те же, что у набора (`autoCheck`). Свои источники сеются в eval-продукт
 * как синтетика (`externalRef = eval-audit:<sha12>:<code>`, sha — от
 * содержимого), повторный запуск их переиспользует.
 *
 * Чистый модуль.
 */
import { createHash } from 'crypto';
import {
  EVAL_SET_GENERATORS,
  type EvalSetVersion,
  type GeneratorId,
} from '../../contracts/ai';
import { EVAL_SCHEMA_OF } from '../../contracts/ai-schemas';
import type { AiCallParams } from '../config';
import type { AdaptationFormat } from '../generators/adaptation-make.generator';
import { EVAL_FIXTURES, type FixtureCode } from './fixtures';
import type { EvalCheck, EvalTask, RedditEvalInput } from './tasks';

export interface AuditSource {
  code: string;
  title: string | null;
  fragment: string;
  usage: 'allowed' | 'restricted';
  visibility: 'public' | 'private';
  kind: 'document' | 'experiment_record' | 'discussion';
}

export interface AuditTaskSet {
  name: string;
  /** sha256 содержимого файла (фиксация набора до прогона). */
  sha256: string;
  sources: AuditSource[];
  tasks: EvalTask[];
  /**
   * Ответы режима `fake` по коду задачи (JSON-строка, `{{S1}}`/`{{Y19}}` —
   * id источника): механика проверок без сети. В `live` не используются.
   */
  fakeAnswers: Record<string, string>;
}

/** Ответ `fake` закрытого набора с подставленными id источников. */
export function auditFakeAnswer(
  set: Pick<AuditTaskSet, 'fakeAnswers'>,
  code: string,
  ids: Readonly<Record<string, string>>,
): string | null {
  const a = set.fakeAnswers[code];
  if (a === undefined) return null;
  return a.replace(
    /\{\{([A-Z][A-Z0-9]{0,7})\}\}/g,
    (m, c: string) => ids[c] ?? m,
  );
}

const MAX_TASKS = 200;
const MAX_SOURCES = 50;
const CODE_RE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const SOURCE_CODE_RE = /^[A-Z][A-Z0-9]{0,7}$/;
const FORMATS: readonly AdaptationFormat[] = [
  'post',
  'cards',
  'checklist',
  'video_script',
];

/** Ссылка своего источника набора в eval-продукте (`pub_sources.externalRef`). */
export function auditSourceRef(s: AuditSource): string {
  const h = createHash('sha256')
    .update(
      JSON.stringify([s.title, s.fragment, s.usage, s.visibility, s.kind]),
    )
    .digest('hex')
    .slice(0, 12);
  return `eval-audit:${h}:${s.code}`;
}

class TasksFileError extends Error {}
const fail = (where: string, what: string): never => {
  throw new TasksFileError(`--tasks-file: ${where}: ${what}`);
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, where: string, max: number): string =>
  typeof v === 'string' && v.length > 0 && v.length <= max
    ? v
    : fail(where, `строка 1…${max}`);
const oneOf = <T extends string>(
  v: unknown,
  allowed: readonly T[],
  where: string,
): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fail(where, `одно из ${allowed.join('|')}`);

function checksOf(v: unknown, where: string): EvalCheck[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50) fail(where, 'массив ≤ 50');
  return (v as unknown[]).map((c, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(c)) return fail(w, 'объект');
    const code = str(c.code, `${w}.code`, 64);
    const text = str(c.text ?? code, `${w}.text`, 300);
    const pattern = str(c.pattern, `${w}.pattern`, 2000);
    const when = oneOf(c.when ?? 'present', ['present', 'absent'], `${w}.when`);
    const reFlags = typeof c.flags === 'string' ? c.flags : 'iu';
    if (!/^[imsu]*$/.test(reFlags)) fail(`${w}.flags`, 'только i m s u');
    let re: RegExp;
    try {
      re = new RegExp(pattern, reFlags);
    } catch (e) {
      return fail(`${w}.pattern`, (e as Error).message);
    }
    return {
      code,
      text,
      test: (a) => (when === 'present' ? re.test(a.text) : !re.test(a.text)),
    };
  });
}

/**
 * Разбор и проверка файла закрытого набора. `set` — версия набора
 * конфигурации прогона: генераторы задач — только из неё.
 */
export function parseTasksFile(
  content: string,
  set: EvalSetVersion,
): AuditTaskSet {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    return fail('файл', `не JSON (${(e as Error).message})`);
  }
  if (!isObj(raw)) return fail('файл', 'объект');
  if (raw.version !== 1) fail('version', 'должна быть 1');
  const name = str(raw.name ?? 'closed-set', 'name', 100);
  const fixtureCodes = new Set<string>(EVAL_FIXTURES.map((f) => f.code));

  const rawSources = raw.sources ?? [];
  if (!Array.isArray(rawSources) || rawSources.length > MAX_SOURCES)
    fail('sources', `массив ≤ ${MAX_SOURCES}`);
  const sources: AuditSource[] = (rawSources as unknown[]).map((s, i) => {
    const w = `sources[${i}]`;
    if (!isObj(s)) return fail(w, 'объект');
    const code = str(s.code, `${w}.code`, 8);
    if (!SOURCE_CODE_RE.test(code)) fail(`${w}.code`, 'A-Z0-9, до 8, с буквы');
    if (fixtureCodes.has(code))
      fail(`${w}.code`, `${code} — код синтетики набора`);
    return {
      code,
      title:
        s.title === undefined || s.title === null
          ? null
          : str(s.title, `${w}.title`, 300),
      fragment: str(s.fragment, `${w}.fragment`, 20_000),
      usage: oneOf(
        s.usage ?? 'allowed',
        ['allowed', 'restricted'],
        `${w}.usage`,
      ),
      visibility: oneOf(
        s.visibility ?? 'public',
        ['public', 'private'],
        `${w}.visibility`,
      ),
      kind: oneOf(
        s.kind ?? 'document',
        ['document', 'experiment_record', 'discussion'],
        `${w}.kind`,
      ),
    };
  });
  const sourceCodes = new Set(sources.map((s) => s.code));
  if (sourceCodes.size !== sources.length) fail('sources', 'коды повторяются');

  const rawTasks = raw.tasks;
  if (
    !Array.isArray(rawTasks) ||
    !rawTasks.length ||
    rawTasks.length > MAX_TASKS
  )
    fail('tasks', `массив 1…${MAX_TASKS}`);
  const generators = EVAL_SET_GENERATORS[set] as readonly string[];
  const tasks: EvalTask[] = (rawTasks as unknown[]).map((t, i) => {
    const w = `tasks[${i}]`;
    if (!isObj(t)) return fail(w, 'объект');
    const code = str(t.code, `${w}.code`, 32);
    if (!CODE_RE.test(code)) fail(`${w}.code`, 'буквы/цифры/дефис, с буквы');
    if (/^AI-\d+$/.test(code))
      fail(`${w}.code`, 'AI-NN — коды набора допуска, у закрытого набора свои');
    const generator = str(t.generator, `${w}.generator`, 64);
    if (!generators.includes(generator))
      fail(`${w}.generator`, `не из набора ${set}: ${generators.join(', ')}`);
    const schema = EVAL_SCHEMA_OF[generator as GeneratorId];
    if (!schema) return fail(`${w}.generator`, 'без схемы набора');
    const allowed = t.allowedSources ?? [];
    if (!Array.isArray(allowed) || allowed.length > 60)
      fail(`${w}.allowedSources`, 'массив ≤ 60');
    for (const c of allowed as unknown[])
      if (
        typeof c !== 'string' ||
        (!fixtureCodes.has(c) && !sourceCodes.has(c))
      )
        fail(`${w}.allowedSources`, `неизвестный код ${String(c)}`);
    if (!isObj(t.input)) return fail(`${w}.input`, 'объект');
    const input: EvalTask['input'] = {
      prompt: str(t.input.prompt, `${w}.input.prompt`, 8000),
    };
    if (schema === 'adaptation') {
      input.format = oneOf(t.input.format, FORMATS, `${w}.input.format`);
      input.parentVersion = str(
        t.input.parentVersion,
        `${w}.input.parentVersion`,
        100,
      );
    }
    if (schema === 'reddit') {
      if (!isObj(t.input.reddit)) return fail(`${w}.input.reddit`, 'объект');
      input.reddit = t.input.reddit as unknown as RedditEvalInput;
    }
    return {
      code,
      group: schema === 'reddit' ? 'reddit' : 'facts',
      schema,
      generator: generator as GeneratorId,
      mode: oneOf(t.mode ?? 'internal', ['internal', 'public'], `${w}.mode`),
      language: oneOf(
        t.language ?? (schema === 'reddit' ? 'en' : 'uk'),
        ['uk', 'en'],
        `${w}.language`,
      ),
      allowedSources: allowed as FixtureCode[],
      input,
      hard: checksOf(t.hard, `${w}.hard`),
      flags: checksOf(t.flags, `${w}.flags`),
    };
  });
  const codes = new Set(tasks.map((t) => t.code));
  if (codes.size !== tasks.length) fail('tasks', 'коды задач повторяются');
  const fakeAnswers: Record<string, string> = {};
  (rawTasks as Array<Record<string, unknown>>).forEach((t, i) => {
    if (t.fakeAnswer === undefined) return;
    if (!isObj(t.fakeAnswer)) fail(`tasks[${i}].fakeAnswer`, 'объект');
    fakeAnswers[tasks[i].code] = JSON.stringify(t.fakeAnswer);
  });
  return {
    name,
    sha256: createHash('sha256').update(content).digest('hex'),
    sources,
    tasks,
    fakeAnswers,
  };
}

/** Строка протокола закрытого набора (без записи в `pub_ai_eval_results`). */
export interface AuditTaskResult {
  code: string;
  generator: string;
  mode: 'internal' | 'public';
  allowedSources: string[];
  /** Статус первой попытки вызова или `not_run:<причина>`. */
  status: string;
  aiCallId: string | null;
  hardFails: Array<{ code: string; text: string }>;
  flags: Array<{ id: string; code: string; text: string }>;
  /** Первый ответ — с маской контактов (как протокол набора). */
  firstAnswer: unknown;
  firstAnswerRaw: string | null;
  costStatus: 'priced' | 'unpriced' | 'unknown';
  costMicroUsd: string | null;
}

/** Протокол закрытого набора (`--tasks-file`): измерение, не допуск. */
export interface AuditProtocol {
  kind: 'closed_set';
  /** Всегда false: основанием `passed` закрытый набор не является. */
  admission: false;
  set: { name: string; sha256: string; tasks: number; sources: number };
  mode: 'fake' | 'live';
  startedAt: string;
  finishedAt: string;
  config: {
    id: string;
    configHash: string;
    provider: string;
    model: string;
    instructionVersions: Record<string, string>;
    contextRulesVersion: string;
    schemaSetVersion: string;
    evalSetVersion: string;
  };
  callParams: AiCallParams;
  fixtureSetHash: string;
  totals: {
    tasks: number;
    run: number;
    notRun: number;
    hardFailed: number;
    flagged: number;
    costMicroUsd: string;
    costUnknown: number;
    maxUsd: number | null;
  };
  tasks: AuditTaskResult[];
}

const cellOf = (s: string): string =>
  s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Протокол закрытого набора в Markdown (`--out`). */
export function auditProtocolMarkdown(p: AuditProtocol): string {
  const t = p.totals;
  const lines = [
    `# Закритий набір «${p.set.name}» — протокол (не допуск)`,
    '',
    `- Набір: sha256 \`${p.set.sha256}\`, задач ${p.set.tasks}, власних джерел ${p.set.sources}`,
    `- Режим **${p.mode}**; ${p.startedAt} → ${p.finishedAt}`,
    `- Конфігурація \`${p.config.configHash}\` — ${p.config.provider} / ${p.config.model}; контекст ${p.config.contextRulesVersion}, схеми ${p.config.schemaSetVersion}, набір ${p.config.evalSetVersion}`,
    `- Інструкції: ${Object.entries(p.config.instructionVersions)
      .map(([g, v]) => `${g} ${v}`)
      .join(', ')}`,
    `- Параметри виклику: temperature ${p.callParams.temperature}, json, потолки ${Object.entries(
      p.callParams.maxOutputTokens,
    )
      .map(([g, n]) => `${g} ${n}`)
      .join(
        ', ',
      )}, запас ${p.callParams.thinkingHeadroom}, thinking ${p.callParams.thinkingBudget}`,
    `- Запущено ${t.run}/${t.tasks}, не запускались ${t.notRun}; жорстких провалів ${t.hardFailed}; з прапорцями ${t.flagged}`,
    `- Витрати ${t.costMicroUsd} мкд USD${t.costUnknown ? `, невідомих ${t.costUnknown}` : ''}; ліміт ${t.maxUsd === null ? '—' : `$${t.maxUsd}`}`,
    '- Основою `passed` закритий набір не є: рядків прогону набору допуску немає.',
    '',
    '| Задача | Генератор | Статус | Жорсткі провали | Прапорці | Вартість, мкд USD |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of p.tasks) {
    lines.push(
      `| ${r.code} | ${r.generator} | ${r.status} | ${cellOf(r.hardFails.map((h) => h.code).join(', ') || '—')} | ${cellOf(r.flags.map((f) => f.code).join(', ') || '—')} | ${r.costMicroUsd ?? r.costStatus} |`,
    );
  }
  lines.push('', '## Перші відповіді (з маскою контактів)', '');
  for (const r of p.tasks) {
    lines.push(
      `### ${r.code}`,
      '',
      '```json',
      r.firstAnswer === null
        ? (r.firstAnswerRaw ?? '(немає відповіді)')
        : JSON.stringify(r.firstAnswer, null, 2),
      '```',
      '',
    );
  }
  return lines.join('\n');
}

export { TasksFileError };
