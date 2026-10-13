/**
 * AI Publisher — отчёт приёмки для qa-catalog из JSON-результатов jest
 * (P-E, проектный документ §16.0, §16.7, §17.2–17.3). Тесты помечают
 * сценарий меткой `[AT-CORE-14]` в `describe`/`it`; отчёт собирает по
 * каждому из 44 кейсов каталога статус автоматизированной части:
 *  - `failed` — хоть один помеченный тест упал;
 *  - `passed` — есть пройденные помеченные тесты и нет упавших;
 *  - `skipped` — помеченные тесты есть, но все пропущены (нет базы и т. п.);
 *  - `blocked` — в прогоне нет ни одного помеченного теста (пакет ещё не
 *    влит, тесты стенда — e2e/ui — идут в другом прогоне). Не `passed`:
 *    отсутствие входных данных обязательного сценария — blocked (план
 *    приёмки «Правила выполнения»);
 *  - у кейса есть части ВНЕ jest (`e2e`, `ui`, `eval`) или ручной остаток
 *    (`AtCase.manual`), а jest-часть прошла — тоже `blocked` (qa-catalog
 *    знает только passed/failed/blocked/skipped), в сводке — `partial`:
 *    jest-отчёт не объявляет пройденным сценарий, чьи другие части не
 *    выполнялись (аудит P-E S2-2). Упавшая jest-часть — `failed`.
 *
 * Формат — `schemaVersion: 1` qa-catalog (`modules/qa-catalog/qa-report-input.ts`):
 * `cases[]` (id, version, type, projects), `results[]` (caseId, project,
 * caseVersion, origin, attempt, durationMs, status), `unknownTests`,
 * `runnerStatus`, `metadata`. Метки, которых нет в каталоге, считаются в
 * `unknownTests` (qa-catalog такой отчёт отвергнет — опечатка в метке видна).
 *
 * Запуск: `npx jest … --json --outputFile=jest.json`, затем
 * `npx ts-node src/modules/publisher/reports/qa/at-report.ts jest.json > at-report.json`.
 * Чистая функция `buildAtReport` (+ блок CLI внизу).
 */
import { readFileSync } from 'fs';
import { AT_CATALOG, AT_CATALOG_VERSION, type AtCase } from './at-catalog';

/** Подмножество формата `jest --json`, которое читает отчёт. */
export interface JestJson {
  success?: boolean;
  startTime?: number;
  testResults: Array<{
    name: string;
    assertionResults: Array<{
      ancestorTitles: string[];
      title: string;
      status:
        | 'passed'
        | 'failed'
        | 'pending'
        | 'skipped'
        | 'todo'
        | 'disabled'
        | 'focused';
      duration?: number | null;
    }>;
  }>;
}

export type AtStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

/** Виды тестов, которые выполняет jest-прогон (остальные — стенд/ручные). */
export const JEST_TEST_TYPES: readonly AtCase['types'][number][] = [
  'unit',
  'db',
  'http',
];

/** Кейс закрывается не только jest: e2e/ui/eval или ручной остаток. */
export function hasPartsOutsideJest(c: AtCase): boolean {
  return c.manual !== null || c.types.some((t) => !JEST_TEST_TYPES.includes(t));
}

export interface AtReport {
  schemaVersion: 1;
  runnerStatus: 'passed' | 'failed';
  unknownTests: number;
  cases: Array<{
    id: string;
    version: number;
    type: 'automated';
    projects: string[];
  }>;
  results: Array<{
    caseId: string;
    project: string;
    caseVersion: number;
    origin: 'automated';
    attempt: number;
    durationMs: number;
    status: AtStatus;
  }>;
  metadata: {
    source: string;
    startedAt: string;
    testSourceSha: string | null;
    deployedSha: string | null;
  };
  /** Сводка для людей (qa-catalog лишние поля не читает). */
  summary: Record<AtStatus, string[]> & {
    unknownLabels: string[];
    /** jest-часть прошла, но есть e2e/ui/eval/ручные части — статус blocked. */
    partial: string[];
  };
}

const LABEL_RE = /\[(AT-[A-Z0-9-]+)\]/g;

/** Метки `[AT-…]` теста: из заголовков describe и самого it. */
export function labelsOf(t: {
  ancestorTitles: string[];
  title: string;
}): string[] {
  const out = new Set<string>();
  for (const s of [...t.ancestorTitles, t.title]) {
    for (const m of s.matchAll(LABEL_RE)) out.add(m[1]);
  }
  return [...out];
}

export function buildAtReport(
  jest: JestJson,
  opts: {
    project?: string;
    source?: string;
    catalog?: readonly AtCase[];
    testSourceSha?: string | null;
    deployedSha?: string | null;
  } = {},
): AtReport {
  const project = opts.project ?? 'jest';
  const catalog = opts.catalog ?? AT_CATALOG;
  const known = new Set(catalog.map((c) => c.id));
  const agg = new Map<
    string,
    { passed: number; failed: number; skipped: number; ms: number }
  >();
  const unknown = new Set<string>();
  let unknownTests = 0;
  for (const file of jest.testResults) {
    for (const t of file.assertionResults) {
      const labels = labelsOf(t);
      if (labels.some((l) => !known.has(l))) {
        unknownTests++;
        labels.filter((l) => !known.has(l)).forEach((l) => unknown.add(l));
      }
      for (const l of labels.filter((x) => known.has(x))) {
        const a = agg.get(l) ?? { passed: 0, failed: 0, skipped: 0, ms: 0 };
        if (t.status === 'passed') a.passed++;
        else if (t.status === 'failed') a.failed++;
        else a.skipped++;
        a.ms += Math.max(0, t.duration ?? 0);
        agg.set(l, a);
      }
    }
  }
  const summary: AtReport['summary'] = {
    passed: [],
    failed: [],
    blocked: [],
    skipped: [],
    unknownLabels: [...unknown].sort(),
    partial: [],
  };
  const results: AtReport['results'] = catalog.map((c) => {
    const a = agg.get(c.id);
    let status: AtStatus = !a
      ? 'blocked'
      : a.failed > 0
        ? 'failed'
        : a.passed > 0
          ? 'passed'
          : 'skipped';
    if (status === 'passed' && hasPartsOutsideJest(c)) {
      status = 'blocked';
      summary.partial.push(c.id);
    }
    summary[status].push(c.id);
    return {
      caseId: c.id,
      project,
      caseVersion: AT_CATALOG_VERSION,
      origin: 'automated',
      attempt: 0,
      durationMs: a ? Math.round(a.ms) : 0,
      status,
    };
  });
  const anyFailed =
    jest.success === false || results.some((r) => r.status === 'failed');
  return {
    schemaVersion: 1,
    runnerStatus: anyFailed ? 'failed' : 'passed',
    unknownTests,
    cases: catalog.map((c) => ({
      id: c.id,
      version: AT_CATALOG_VERSION,
      type: 'automated',
      projects: [project],
    })),
    results,
    metadata: {
      // qa-catalog принимает `jest` (интеграция Z-1, Р-PUB-Z1-5).
      source: opts.source ?? 'jest',
      startedAt: new Date(jest.startTime ?? Date.now()).toISOString(),
      testSourceSha: opts.testSourceSha ?? null,
      deployedSha: opts.deployedSha ?? null,
    },
    summary,
  };
}

/* istanbul ignore next — CLI */
if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: at-report <jest.json>\n');
    process.exit(2);
  }
  const report = buildAtReport(
    JSON.parse(readFileSync(file, 'utf8')) as JestJson,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
