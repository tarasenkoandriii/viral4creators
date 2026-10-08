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
import { resolveSpeechRecognitionProvider } from '../../src/common/speech-recognition-provider';
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
  /**
   * Справочные ворота — движок не тот, что работает в продукте по
   * умолчанию: показываются, но на код выхода не влияют.
   */
  informational?: boolean;
  detail: string;
}

/**
 * Пороги §8.3 (Р-З8-15). ТЗ велит брать их по базовой цифре на том же
 * наборе; базовая цифра — замер 07.10.2026: Soniox WER 2,8–3,2 % на всех
 * уровнях шума, имена 69/69. Порог — с запасом на разброс синтеза.
 */
export const STT_MAX_WER = 0.05;
export const STT_MIN_NAMES = 0.97;

/** Ворота, которые не на чем проверить. */
function uncheckedGate(name: string, why: string): Gate {
  return { name, ok: false, unchecked: true, detail: `не проверено: ${why}` };
}

/**
 * Ворота пройдены по-настоящему (а не «не на чем проверить»). Справочные
 * не роняют прогон: их провал — довод против того движка, а не против
 * продукта.
 */
export function gatePassed(g: Gate): boolean {
  if (g.informational) return true;
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
  gates.push(...sttGates(result, stt, stopped));
  return { classifier, stt, gates };
}

/** Пустые ответы классификатора, сгруппированные по причине. */
function emptyReasons(rows: RunResult['classRows']): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.predicted !== null) continue;
    const key = r.why ?? 'причина не записана';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!counts.size) return [];
  return [
    '',
    'Пустые ответы по причинам:',
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `- ${n} × ${k}`),
  ];
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
        `- ${g.unchecked ? '—' : g.ok ? '✓' : g.informational ? 'ℹ' : '✗'} ${g.name} — ${g.detail}`,
    ),
  ];
  if (s.classifier) {
    const c = s.classifier;
    out.push(
      '',
      '## Классификатор регистра «Особого повода» (§8.1)',
      '',
      `Описаний ${c.total}, верно ${c.correct} (${pct(c.accuracy)}). Без ответа: ${c.none.length}. Мягче эталона: ${c.softer.length}.`,
      ...emptyReasons(result.classRows),
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

/**
 * Ворота §8.3 — по каждому движку отдельно: смешанные ворота роняли
 * Soniox за ответы Gemini. Приёмочные — у движка продукта по умолчанию
 * (`resolveSpeechRecognitionProvider(null)`), у остальных — справочные.
 */
function sttGates(
  result: RunResult,
  stt: SttGroupSummary[],
  stopped: string | null,
): Gate[] {
  const gates: Gate[] = [];
  const productEngine = resolveSpeechRecognitionProvider(null);
  const engines = [...new Set(stt.map((g) => g.engine))].sort((a, b) =>
    a === productEngine ? -1 : b === productEngine ? 1 : a.localeCompare(b),
  );
  for (const engine of engines) {
    const totals = stt.filter((g) => g.engine === engine && g.lang === 'все');
    const informational = engine !== productEngine;
    const tag = informational ? `${engine}, справочно` : engine;
    const names = {
      latin: `§8.3 [${tag}] ни одного ответа латиницей`,
      lang: `§8.3 [${tag}] язык ответа = язык фразы (без суржика)`,
      wer: `§8.3 [${tag}] WER ≤ ${pct(STT_MAX_WER)} на каждом уровне шума`,
      names: `§8.3 [${tag}] имена ≥ ${pct(STT_MIN_NAMES)} на каждом уровне шума`,
    };
    const extra = informational ? { informational: true } : {};
    const answered = result.sttRows.some(
      (r) => r.engine === engine && !!r.hypothesis,
    );
    const why =
      stopped ??
      (answered ? null : 'распознавание не вернуло ни одного ответа');
    if (why) {
      for (const n of Object.values(names))
        gates.push({ ...uncheckedGate(n, why), ...extra });
      continue;
    }
    const latin = totals.reduce((a, g) => a + g.latinAnswers, 0);
    gates.push({
      name: names.latin,
      ok: latin === 0,
      detail: `${latin} ответов латиницей`,
      ...extra,
    });
    const mismatch = totals.flatMap((g) =>
      g.languageMismatch.map((m) => `${g.snr}: ${m}`),
    );
    gates.push({
      name: names.lang,
      ok: mismatch.length === 0,
      detail: mismatch.slice(0, 20).join('; ') || 'расхождений нет',
      ...extra,
    });
    const worstWer = Math.max(...totals.map((g) => g.wer));
    gates.push({
      name: names.wer,
      ok: worstWer <= STT_MAX_WER,
      detail: totals.map((g) => `${g.snr} ${pct(g.wer)}`).join(', '),
      ...extra,
    });
    const share = (g: SttGroupSummary) =>
      g.namesTotal ? g.namesFound / g.namesTotal : 1;
    gates.push({
      name: names.names,
      ok: totals.every((g) => share(g) >= STT_MIN_NAMES),
      detail: totals
        .map((g) => `${g.snr} ${g.namesFound}/${g.namesTotal}`)
        .join(', '),
      ...extra,
    });
  }
  return gates;
}
