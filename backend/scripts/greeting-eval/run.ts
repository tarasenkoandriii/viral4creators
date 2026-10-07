/**
 * Замеры поздравления — `npm run eval:greeting` (TODO захода 8 C7; ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §8.1 стр. «Классификатор»
 * и §8.3 «Проверочный набор записей»).
 *
 *   npm run eval:greeting                     # сухой режим: проверка наборов, план, цена
 *   npm run eval:greeting -- --dry --limit=5  # то же для пробной части
 *   npm run eval:greeting -- --apply          # ЖИВОЙ прогон: Gemini и Soniox, деньги
 *   npm run eval:greeting -- --apply --part=classifier --max-usd=0.5
 *
 * Флаги: `--part=classifier,stt` · `--engines=gemini,soniox` ·
 * `--snr=clean,20,10` · `--voices=Maya,Adrian` · `--langs=ru,uk,en,de,es`
 * (описания повода) · `--speech-langs=ru,uk` · `--limit=N` (первые N
 * сюжетов и N фраз на язык) · `--max-usd=2` (потолок) · `--out=папка`
 * · `--verbose`.
 *
 * Без `--apply` ни одного платного вызова не бывает, даже если ключи
 * заданы. С `--apply` прогон не стартует, если оценка выше потолка, и
 * останавливается, если фактический расход упёрся в потолок (код 3,
 * частичный отчёт сохранён). Ключи — из окружения или `backend/.env`
 * (GEMINI_API_KEY, SONIOX_API_KEY); печатается только «задан / нет».
 * Синтез требует ffmpeg (mp3 → WAV 16 кГц).
 *
 * Коды выхода: 0 — всё прошло (или сухой режим без проблем в наборах);
 * 1 — проблемы в наборах или не прошли ворота приёмки; 2 — нельзя
 * запустить (нет ключа, ffmpeg, оценка выше потолка, неверный флаг);
 * 3 — остановлено потолком расходов.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { formatMicroUsd } from '../../src/common/ai-pricing';
import {
  EVAL_LANGUAGES,
  OCCASION_SET,
  type EvalLanguage,
} from './occasion-set';
import { SPEECH_SET, type SpeechLanguage } from './speech-set';
import { validateOccasionSet, validateSpeechSet } from './validate';
import {
  DEFAULT_OPTIONS,
  buildPlan,
  estimatePlan,
  formatEstimate,
  type Engine,
  type EvalOptions,
  type Part,
} from './plan';
import { Budget, runEval } from './runner';
import { summarize, summaryMarkdown } from './report';

const USD = 1_000_000;

export interface CliArgs {
  apply: boolean;
  verbose: boolean;
  out: string | null;
  options: EvalOptions;
}

function list<T extends string>(
  raw: string,
  allowed: readonly T[],
  flag: string,
): T[] {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const i of items) {
    if (!allowed.includes(i as T)) {
      throw new Error(`${flag}: «${i}» — допустимо ${allowed.join(', ')}`);
    }
  }
  if (!items.length) throw new Error(`${flag}: пустой список`);
  return items as T[];
}

/** Разбор флагов; неверный флаг — ошибка, а не тихое умолчание. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const options: EvalOptions = {
    ...DEFAULT_OPTIONS,
    parts: [...DEFAULT_OPTIONS.parts],
    engines: [...DEFAULT_OPTIONS.engines],
    snr: [...DEFAULT_OPTIONS.snr],
    voices: [...DEFAULT_OPTIONS.voices],
    occasionLangs: [...DEFAULT_OPTIONS.occasionLangs],
    speechLangs: [...DEFAULT_OPTIONS.speechLangs],
  };
  let apply = false;
  let dry = false;
  let verbose = false;
  let out: string | null = null;
  for (const a of argv) {
    const [flag, value = ''] = a.split(/=(.*)/s);
    switch (flag) {
      case '--apply':
        apply = true;
        break;
      case '--dry':
        dry = true;
        break;
      case '--verbose':
        verbose = true;
        break;
      case '--part':
        options.parts = list<Part>(value, ['classifier', 'stt'], flag);
        break;
      case '--engines':
        options.engines = list<Engine>(value, ['gemini', 'soniox'], flag);
        break;
      case '--snr':
        options.snr = value.split(',').map((s) => {
          const t = s.trim();
          if (t === 'clean') return null;
          const n = Number(t);
          if (!Number.isFinite(n) || n < -5 || n > 60) {
            throw new Error(`--snr: «${t}» — clean или число дБ`);
          }
          return n;
        });
        break;
      case '--voices':
        options.voices = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!options.voices.length) throw new Error('--voices: пустой список');
        break;
      case '--langs':
        options.occasionLangs = list<EvalLanguage>(value, EVAL_LANGUAGES, flag);
        break;
      case '--speech-langs':
        options.speechLangs = list<SpeechLanguage>(value, ['ru', 'uk'], flag);
        break;
      case '--limit': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error('--limit: целое ≥ 1');
        }
        options.limit = n;
        break;
      }
      case '--max-usd': {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error('--max-usd: число > 0');
        }
        options.maxUsd = n;
        break;
      }
      case '--out':
        if (!value) throw new Error('--out: нужен путь');
        out = value;
        break;
      default:
        throw new Error(`неизвестный флаг ${a}`);
    }
  }
  if (apply && dry) throw new Error('--apply и --dry вместе — выберите одно');
  return { apply, verbose, out, options };
}

/** Каких ключей не хватает для выбранных частей. */
export function missingForApply(
  options: EvalOptions,
  keys: { gemini: boolean; soniox: boolean; ffmpeg: boolean },
): string[] {
  const missing: string[] = [];
  const stt = options.parts.includes('stt');
  const needGemini =
    options.parts.includes('classifier') ||
    (stt && options.engines.includes('gemini'));
  if (needGemini && !keys.gemini) missing.push('GEMINI_API_KEY');
  // Синтез речи — Soniox TTS при любом движке распознавания.
  if (stt && !keys.soniox) missing.push('SONIOX_API_KEY');
  if (stt && !keys.ffmpeg) missing.push('ffmpeg в PATH');
  return missing;
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const { options } = args;

  const problems = [
    ...validateOccasionSet(OCCASION_SET).map((p) => `повод: ${p}`),
    ...validateSpeechSet(SPEECH_SET).map((p) => `речь: ${p}`),
  ];
  console.log(
    `Наборы: ${OCCASION_SET.length} сюжетов × ${EVAL_LANGUAGES.length} языков; ` +
      `${SPEECH_SET.filter((p) => p.lang === 'ru').length} фраз ru + ${SPEECH_SET.filter((p) => p.lang === 'uk').length} uk.`,
  );
  if (problems.length) {
    console.error(`Проблемы в наборах (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log('Наборы проверены: проблем нет.');

  const plan = buildPlan(options);
  const estimate = estimatePlan(plan);
  const capMicro = Math.round(options.maxUsd * USD);
  console.log(
    [
      '',
      `План: классификатор ${plan.classify.length} описаний; синтез ${plan.synth.length} фраз × голос; ` +
        `распознавание ${plan.stt.length} записей (движки ${options.engines.join(', ')}; ` +
        `звук ${options.snr.map((s) => (s === null ? 'чисто' : `${s} дБ`)).join(', ')}).`,
      'Оценка стоимости (прайс продукта, с запасом):',
      formatEstimate(estimate),
      `Потолок: ${formatMicroUsd(capMicro)}${estimate.totalMicro > capMicro ? ' — ОЦЕНКА ВЫШЕ ПОТОЛКА' : ''}.`,
    ].join('\n'),
  );

  // Ключи читаются из .env только здесь: сухому режиму они не нужны.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config({ quiet: true });
  const { keyStatus } = await import('./providers');
  const keys = keyStatus();
  console.log(
    `Ключи: GEMINI_API_KEY ${keys.gemini ? 'задан' : 'нет'}, SONIOX_API_KEY ${keys.soniox ? 'задан' : 'нет'}, ffmpeg ${keys.ffmpeg ? 'есть' : 'нет'}.`,
  );
  const missing = missingForApply(options, keys);

  if (!args.apply) {
    console.log(
      missing.length
        ? `Сухой режим. Для --apply не хватает: ${missing.join(', ')}.`
        : 'Сухой режим. Живой прогон — флагом --apply (платно, в пределах --max-usd).',
    );
    return 0;
  }

  if (missing.length) {
    console.error(`--apply невозможен: нет ${missing.join(', ')}.`);
    return 2;
  }
  if (estimate.totalMicro > capMicro) {
    console.error(
      `--apply отменён: оценка ${formatMicroUsd(estimate.totalMicro)} выше потолка ${formatMicroUsd(capMicro)}. ` +
        'Поднимите --max-usd или сузьте прогон (--limit, --part, --engines, --snr).',
    );
    return 2;
  }

  const startedAt = new Date().toISOString();
  const outDir = resolve(
    args.out ??
      join(tmpdir(), `greeting-eval-${startedAt.replace(/[:.]/g, '-')}`),
  );
  mkdirSync(outDir, { recursive: true });
  const { liveProviders } = await import('./providers');
  const budget = new Budget(capMicro);
  const result = await runEval(
    plan,
    await liveProviders(),
    budget,
    args.verbose ? (l) => console.log(l) : undefined,
  );
  const summary = summarize(result);
  const md = summaryMarkdown(summary, result, {
    estimateMicro: estimate.totalMicro,
    capMicro,
    startedAt,
  });
  writeFileSync(
    join(outDir, 'rows.json'),
    JSON.stringify(
      { classRows: result.classRows, sttRows: result.sttRows },
      null,
      2,
    ),
  );
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, 'summary.md'), md);
  console.log(`\n${md}\n\nОтчёт: ${outDir}`);
  if (result.stopped) return 3;
  return summary.gates.every((g) => g.ok) ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exit(1);
    },
  );
}
