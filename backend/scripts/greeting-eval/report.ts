/**
 * Сводка замеров и ворота приёмки — из строк прогона (`runner.ts`).
 *
 * Ворота (то, что ТЗ называет без порога-по-базе):
 * - §8.1: ни одного траурного описания, определённого как праздничное;
 * - §8.3: ни одного ответа латиницей для кириллической речи (после
 *   продуктового повтора);
 * - §8.3: язык ответа совпадает с языком фразы во всех записях без
 *   суржика (там, где язык ответа удалось определить).
 * WER и точность имён ворот не имеют: порог задаётся по базовой цифре
 * Devil's Advocate на том же наборе (§8.3), здесь она только измеряется.
 */
import { formatMicroUsd } from '../../src/common/ai-pricing';
import { GREETING_REGISTERS } from '../../src/common/types/greeting.types';
import {
  classifierReport,
  corpusWer,
  isLatinAnswer,
  latinShare,
  matrixMarkdown,
  namesFound,
  type ClassifierReport,
} from './metrics';
import type { ClassRow, RunResult, SttRow } from './runner';

export interface SttGroupSummary {
  engine: string;
  snr: string;
  lang: string;
  files: number;
  wer: number;
  words: number;
  edits: number;
  namesTotal: number;
  namesFound: number;
  latinAnswers: number;
  latinFirstPass: number;
  meanLatinShare: number;
  retried: number;
  empty: number;
  languageChecked: number;
  languageMismatch: string[];
  languageUnknown: number;
}

export interface Gate {
  name: string;
  ok: boolean;
  /**
   * Проверить было не на чем: прогон остановлен или ответов нет. Такие
   * ворота не «пройдены» — в отчёте «—», код выхода не 0.
   */
  unchecked?: boolean;
  detail: string;
}

/** Ворота, которые не на чем проверить. */
function uncheckedGate(name: string, why: string): Gate {
  return { name, ok: false, unchecked: true, detail: `не проверено: ${why}` };
}

/** Ворота пройдены по-настоящему (а не «не на чем проверить»). */
export function gatePassed(g: Gate): boolean {
  return g.ok && !g.unchecked;
}

export interface EvalSummary {
  classifier:
    | (ClassifierReport & {
        keywordHitsMourning: number;
        mourningTotal: number;
        keywordFalsePositives: string[];
        pipelineSofter: string[];
      })
    | null;
  stt: SttGroupSummary[];
  gates: Gate[];
}

const strictness = (r: string) =>
  GREETING_REGISTERS.indexOf(r as (typeof GREETING_REGISTERS)[number]);

function summarizeClassifier(rows: ClassRow[]): EvalSummary['classifier'] {
  if (!rows.length) return null;
  const base = classifierReport(rows);
  const mourning = rows.filter((r) => r.label === 'MOURNING');
  return {
    ...base,
    mourningTotal: mourning.length,
    keywordHitsMourning: mourning.filter((r) => r.keyword).length,
    keywordFalsePositives: rows
      .filter((r) => r.label !== 'MOURNING' && r.keyword)
      .map((r) => `${r.id}.${r.lang} («${r.keyword}»)`),
    pipelineSofter: rows
      .filter((r) => strictness(r.pipeline) < strictness(r.label))
      .map((r) => `${r.id}.${r.lang}: ${r.label} → ${r.pipeline}`),
  };
}

function summarizeStt(rows: SttRow[]): SttGroupSummary[] {
  const groups = new Map<string, SttRow[]>();
  for (const r of rows) {
    const snr = r.snr === null ? 'чисто' : `${r.snr} дБ`;
    for (const lang of [r.lang, 'все']) {
      const key = `${r.engine}|${snr}|${lang}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
  }
  return [...groups.entries()].map(([key, list]) => {
    const [engine, snr, lang] = key.split('|');
    const wer = corpusWer(
      list.map((r) => ({ id: r.id, refs: r.refs, hypothesis: r.hypothesis })),
    );
    let namesTotal = 0;
    let namesHit = 0;
    for (const r of list) {
      const n = namesFound(r.names, r.hypothesis);
      namesTotal += n.total;
      namesHit += n.found;
    }
    const checkable = list.filter((r) => !r.tags.includes('surzhyk'));
    const known = checkable.filter((r) => r.language);
    return {
      engine,
      snr,
      lang,
      files: list.length,
      wer: wer.wer,
      words: wer.words,
      edits: wer.edits,
      namesTotal,
      namesFound: namesHit,
      latinAnswers: list.filter((r) => isLatinAnswer(r.hypothesis)).length,
      latinFirstPass: list.filter((r) => isLatinAnswer(r.first)).length,
      meanLatinShare:
        list.reduce((a, r) => a + latinShare(r.hypothesis ?? ''), 0) /
        list.length,
      retried: list.filter((r) => r.retried).length,
      empty: list.filter((r) => !r.hypothesis).length,
      languageChecked: known.length,
      languageMismatch: known
        .filter((r) => r.language !== r.lang)
        .map((r) => `${r.id} (${r.language}, ${r.languageSource})`),
      languageUnknown: checkable.length - known.length,
    };
  });
}

export function summarize(result: RunResult): EvalSummary {
  const classifier = summarizeClassifier(result.classRows);
  const stt = summarizeStt(result.sttRows);
  const gates: Gate[] = [];
  const stopped = result.stopped ? 'прогон остановлен раньше' : null;
  if (classifier) {
    const name = '§8.1 траурный не определён праздничным';
    const answeredMourning = result.classRows.filter(
      (r) => r.label === 'MOURNING' && r.predicted !== null,
    ).length;
    if (stopped) gates.push(uncheckedGate(name, stopped));
    else if (answeredMourning === 0)
      gates.push(
        uncheckedGate(name, 'классификатор не ответил ни на одно траурное'),
      );
    else
      gates.push({
        name,
        ok: classifier.mourningAsCelebratory.length === 0,
        detail: classifier.mourningAsCelebratory.join(', ') || 'нет',
      });
  }
  const totals = stt.filter((g) => g.lang === 'все');
  if (totals.length) {
    const latinName = '§8.3 ни одного ответа латиницей';
    const langName = '§8.3 язык ответа = язык фразы (без суржика)';
    const answered = result.sttRows.some((r) => !!r.hypothesis);
    const why =
      stopped ??
      (answered ? null : 'распознавание не вернуло ни одного ответа');
    if (why) {
      gates.push(uncheckedGate(latinName, why), uncheckedGate(langName, why));
    } else {
      const latin = totals.reduce((a, g) => a + g.latinAnswers, 0);
      gates.push({
        name: latinName,
        ok: latin === 0,
        detail: `${latin} ответов латиницей`,
      });
      const mismatch = totals.flatMap((g) =>
        g.languageMismatch.map((m) => `${g.engine}/${g.snr}: ${m}`),
      );
      gates.push({
        name: langName,
        ok: mismatch.length === 0,
        detail: mismatch.slice(0, 20).join('; ') || 'расхождений нет',
      });
    }
  }
  return { classifier, stt, gates };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function summaryMarkdown(
  s: EvalSummary,
  result: RunResult,
  meta: { estimateMicro: number; capMicro: number; startedAt: string },
): string {
  const out: string[] = [
    '# Замеры поздравления: классификатор и распознавание',
    '',
    `Начало: ${meta.startedAt}. Оценка ${formatMicroUsd(meta.estimateMicro)}, потолок ${formatMicroUsd(meta.capMicro)}, потрачено ≈ ${formatMicroUsd(result.spentMicro)}.`,
    result.stopped ? `**Остановлено раньше:** ${result.stopped}.` : '',
    '',
    '## Ворота приёмки',
    '',
    ...s.gates.map(
      (g) =>
        `- ${g.unchecked ? '—' : g.ok ? '✓' : '✗'} ${g.name} — ${g.detail}`,
    ),
  ];
  if (s.classifier) {
    const c = s.classifier;
    out.push(
      '',
      '## Классификатор регистра «Особого повода» (§8.1)',
      '',
      `Описаний ${c.total}, верно ${c.correct} (${pct(c.accuracy)}). Без ответа: ${c.none.length}. Мягче эталона: ${c.softer.length}.`,
      '',
      ...Object.entries(c.byLanguage).map(
        ([lang, v]) =>
          `- ${lang}: ${v.correct}/${v.total} (${pct(v.total ? v.correct / v.total : 0)})`,
      ),
      '',
      matrixMarkdown(c.matrix),
      '',
      `Ключевые слова траура: ${c.keywordHitsMourning}/${c.mourningTotal} траурных; ложных срабатываний ${c.keywordFalsePositives.length}${c.keywordFalsePositives.length ? ` (${c.keywordFalsePositives.join(', ')})` : ''}.`,
      `Цепочка без ответа человека (слова + классификатор) мягче эталона: ${c.pipelineSofter.length}${c.pipelineSofter.length ? ` — ${c.pipelineSofter.join('; ')}` : ''}.`,
      c.softer.length
        ? `Мягче эталона (классификатор): ${c.softer.join(', ')}.`
        : '',
    );
  }
  if (s.stt.length) {
    out.push(
      '',
      '## Распознавание (§8.3)',
      '',
      '| движок | звук | язык | файлов | WER | имена | латиница (итог/1-я) | повторов | пусто | язык не совпал | язык не определён |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...s.stt.map(
        (g) =>
          `| ${g.engine} | ${g.snr} | ${g.lang} | ${g.files} | ${pct(g.wer)} | ${g.namesFound}/${g.namesTotal} | ${g.latinAnswers}/${g.latinFirstPass} | ${g.retried} | ${g.empty} | ${g.languageMismatch.length}/${g.languageChecked} | ${g.languageUnknown} |`,
      ),
    );
  }
  return out.filter((l) => l !== undefined).join('\n');
}
