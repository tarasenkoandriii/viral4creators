/**
 * Замеры поздравления (`backend/scripts/greeting-eval`, `npm run
 * eval:greeting`) — детерминированная часть: наборы, метрики, план и цена,
 * потолок расходов и повтор при латинице на двойниках провайдеров. Живые
 * цифры даёт только прогон с ключами (`--apply`); здесь — что считаются
 * они правильно и что набор отвечает §8.1 и §8.3 ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md.
 */
jest.mock('../modules/ai-usage/ai-usage.service', () => ({
  AiUsageService: class {},
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { buildRegisterPrompt } from '../modules/greeting-brief/greeting-register-classifier.service';
import { mourningKeyword } from './greeting-policy';
import { GREETING_REGISTERS } from './types/greeting.types';
import {
  EVAL_LANGUAGES,
  OCCASION_SET,
  type OccasionScenario,
} from '../../scripts/greeting-eval/occasion-set';
import {
  SPEECH_SET,
  type SpeechPhrase,
} from '../../scripts/greeting-eval/speech-set';
import {
  validateOccasionSet,
  validateSpeechSet,
} from '../../scripts/greeting-eval/validate';
import {
  bestEdits,
  classifierReport,
  corpusWer,
  guessCyrillicLanguage,
  isLatinAnswer,
  namesFound,
  normalizeWords,
  wordEdits,
} from '../../scripts/greeting-eval/metrics';
import {
  CLASSIFIER_PROMPT_OVERHEAD_CHARS,
  DEFAULT_OPTIONS,
  buildPlan,
  classifyCostMicro,
  estimatePlan,
  sttCostMicro,
} from '../../scripts/greeting-eval/plan';
import {
  Budget,
  runEval,
  CLASSIFIER_SILENT_LIMIT,
  type Providers,
  type RunResult,
  type SttRow,
} from '../../scripts/greeting-eval/runner';
import {
  gatePassed,
  summarize,
  summaryMarkdown,
} from '../../scripts/greeting-eval/report';
import {
  consoleHooks,
  progressLine,
} from '../../scripts/greeting-eval/progress';
import {
  RATE,
  decodeWav,
  encodeWav,
  noise,
  noisyFramed,
  snrDb,
} from '../../scripts/greeting-eval/audio';
import { missingForApply, parseArgs } from '../../scripts/greeting-eval/run';

// ── Наборы ──────────────────────────────────────────────────────────────

describe('набор описаний «Особого повода» (§8.1)', () => {
  it('50 сюжетов × 5 языков, метки из закрытых списков, проблем нет', () => {
    expect(validateOccasionSet(OCCASION_SET)).toEqual([]);
    expect(OCCASION_SET).toHaveLength(50);
    expect(EVAL_LANGUAGES).toEqual(['ru', 'uk', 'en', 'de', 'es']);
    const n = OCCASION_SET.length * EVAL_LANGUAGES.length;
    expect(n).toBe(250);
    for (const r of GREETING_REGISTERS) {
      expect(OCCASION_SET.some((s) => s.register === r)).toBe(true);
    }
  });

  it('ловушки настоящие: «траур без ключевых слов» слов не содержит, «похоронили склад» их содержит', () => {
    const m02 = OCCASION_SET.find((s) => s.id === 'm02')!;
    for (const lang of EVAL_LANGUAGES) {
      expect({ lang, kw: mourningKeyword(m02.text[lang]) }).toEqual({
        lang,
        kw: null,
      });
    }
    const c10 = OCCASION_SET.find((s) => s.id === 'c10')!;
    expect(mourningKeyword(c10.text.ru)).not.toBeNull();
  });

  it('валидатор ловит порчу набора', () => {
    const bad: OccasionScenario[] = OCCASION_SET.slice(0, 49).map((s) => ({
      ...s,
      text: { ...s.text },
    }));
    bad[0] = { ...bad[0], register: 'PARTY' as never };
    bad[1] = {
      ...bad[1],
      text: { ...bad[1].text, ru: 'Funeral бабушки завтра' },
    };
    bad[2] = { ...bad[2], text: { ...bad[2].text, uk: '' } };
    bad[3] = { ...bad[3], id: bad[4].id };
    bad[5] = { ...bad[5], text: { ...bad[5].text, ru: 'Дідусь їде' } };
    const problems = validateOccasionSet(bad).join('\n');
    expect(problems).toMatch(/сюжетов 49/);
    expect(problems).toMatch(/PARTY.*не из закрытого списка/);
    expect(problems).toMatch(/латиница в кириллическом/);
    expect(problems).toMatch(/\.uk: пусто/);
    expect(problems).toMatch(/повтор id/);
    expect(problems).toMatch(/украинские буквы в ru/);
  });
});

describe('набор фраз распознавания (§8.3)', () => {
  it('100 ru + 100 uk с именами, датами, возрастом и суржиком; проблем нет', () => {
    expect(validateSpeechSet(SPEECH_SET)).toEqual([]);
    for (const lang of ['ru', 'uk'] as const) {
      const list = SPEECH_SET.filter((p) => p.lang === lang);
      expect(list).toHaveLength(100);
      for (const tag of ['name', 'date', 'age', 'surzhyk'] as const) {
        expect(list.some((p) => p.tags.includes(tag))).toBe(true);
      }
    }
  });

  it('валидатор ловит порчу фраз', () => {
    const base = SPEECH_SET.filter((p) => p.lang === 'ru').slice(0, 99);
    const bad: SpeechPhrase[] = [
      ...base,
      {
        id: 'ru-900',
        lang: 'ru',
        text: 'Получатель 12 лет Марина',
        tags: ['name', 'age'],
        names: ['Мариной'],
      },
      {
        id: 'ru-901',
        lang: 'ru',
        text: 'Дата двадцать пятое',
        tags: ['date'],
      },
      {
        id: 'ru-902',
        lang: 'ru',
        text: 'Привіт усім друзям',
        tags: ['command'],
      },
    ];
    const problems = validateSpeechSet(bad).join('\n');
    expect(problems).toMatch(/ru-900: цифры в произносимом тексте/);
    expect(problems).toMatch(/ru-900: имени «Мариной» нет в тексте/);
    expect(problems).toMatch(/ru-901: число словами без записи цифрами/);
    expect(problems).toMatch(/ru-902: украинские буквы в ru/);
    expect(problems).toMatch(/uk: фраз 0/);
  });
});

// ── Метрики ─────────────────────────────────────────────────────────────

describe('WER', () => {
  it('нормализация: регистр, пунктуация, апостроф, ё, дефис', () => {
    expect(normalizeWords('Мар’ЯНА, Лёша — «17-го»!')).toEqual([
      "мар'яна",
      'леша',
      '17',
      'го',
    ]);
  });

  it('правки по словам: замена, вставка, удаление', () => {
    expect(wordEdits(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1);
    expect(wordEdits(['a', 'b', 'c'], ['a', 'c'])).toBe(1);
    expect(wordEdits(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(2);
    expect(wordEdits(['a'], [])).toBe(1);
  });

  it('допустимая запись цифрами: «12 марта» не ошибка; считается по ближайшей', () => {
    const refs = [
      'Дата праздника двенадцатое марта',
      'Дата праздника 12 марта',
    ];
    expect(bestEdits(refs, 'дата праздника 12 марта').edits).toBe(0);
    expect(bestEdits(refs, 'Дата праздника двенадцатое марта.').edits).toBe(0);
    const near = bestEdits(refs, 'дата праздника 12 марту');
    expect(near.edits).toBe(1);
    expect(near.ref).toBe(refs[1]);
  });

  it('WER по набору — сумма правок / сумма слов; пустое распознавание — все слова удалены', () => {
    const r = corpusWer([
      {
        id: '1',
        refs: ['Скільки коштує доставка'],
        hypothesis: 'скільки коштує доставка',
      },
      {
        id: '2',
        refs: ['Яка гарантія на чайник'],
        hypothesis: 'яка гарантія на чайнік',
      },
      { id: '3', refs: ['Покличте оператора'], hypothesis: null },
    ]);
    expect(r.words).toBe(9);
    expect(r.edits).toBe(3);
    expect(r.wer).toBeCloseTo(3 / 9);
  });
});

describe('точность имён', () => {
  it('имя — словом в слово, падеж важен, регистр и ё — нет; имя из двух слов — подряд', () => {
    expect(
      namesFound(['Марины', 'Андрея'], 'поздравление для марины от андрея'),
    ).toEqual({
      total: 2,
      found: 2,
      missed: [],
    });
    expect(namesFound(['Марины'], 'для Марина').missed).toEqual(['Марины']);
    expect(namesFound(['Лёша'], 'обнимаем, леша').found).toBe(1);
    expect(namesFound(["Мар'яна"], 'не Марія, а Мар’яна').found).toBe(1);
    expect(namesFound(['Тимофей Петрович'], 'Тимофей, Петрович').found).toBe(1);
    expect(namesFound(['Тимофей Петрович'], 'Петрович Тимофей').found).toBe(0);
    expect(namesFound(['Нестор'], null)).toEqual({
      total: 1,
      found: 0,
      missed: ['Нестор'],
    });
  });
});

describe('латиница и язык', () => {
  it('ответ латиницей — по продуктовой границе (половина букв)', () => {
    expect(isLatinAnswer('Pozdravlenie dlya Mariny')).toBe(true);
    expect(isLatinAnswer('Поздравь Ксюшу с iPhone')).toBe(false);
    expect(isLatinAnswer('25 лет')).toBe(false);
    expect(isLatinAnswer(null)).toBe(false);
  });

  it('русский или украинский — по буквам и служебным словам; общий текст — не определить', () => {
    expect(guessCyrillicLanguage('Привітання для Мирослави від Тараса')).toBe(
      'uk',
    );
    expect(guessCyrillicLanguage('Скажи Мирону, что мы его очень ждём')).toBe(
      'ru',
    );
    expect(guessCyrillicLanguage('Сделай тон серьёзнее')).toBe('ru');
    expect(guessCyrillicLanguage('Получатель Нестор')).toBe('ru');
    expect(guessCyrillicLanguage('Нестор, Устим')).toBeNull();
    expect(guessCyrillicLanguage(null)).toBeNull();
  });
});

describe('классификатор: точность и матрица ошибок', () => {
  it('траурный как праздничный, мягче эталона и «нет ответа» считаются отдельно', () => {
    const r = classifierReport([
      { id: 'm1', lang: 'ru', label: 'MOURNING', predicted: 'MOURNING' },
      { id: 'm2', lang: 'en', label: 'MOURNING', predicted: 'CELEBRATORY' },
      { id: 'm3', lang: 'de', label: 'MOURNING', predicted: 'SENSITIVE' },
      { id: 's1', lang: 'ru', label: 'SENSITIVE', predicted: 'MOURNING' },
      { id: 'c1', lang: 'es', label: 'CELEBRATORY', predicted: null },
    ]);
    expect(r.total).toBe(5);
    expect(r.correct).toBe(1);
    expect(r.accuracy).toBeCloseTo(0.2);
    expect(r.mourningAsCelebratory).toEqual(['m2.en']);
    expect(r.softer).toEqual(['m2.en', 'm3.de']);
    expect(r.none).toEqual(['c1.es']);
    expect(r.matrix.MOURNING).toMatchObject({
      MOURNING: 1,
      CELEBRATORY: 1,
      SENSITIVE: 1,
      NONE: 0,
    });
    expect(r.matrix.CELEBRATORY.NONE).toBe(1);
    expect(r.byLanguage.ru).toEqual({ total: 2, correct: 1 });
  });
});

// ── Звук ────────────────────────────────────────────────────────────────

describe('звук: WAV и шум', () => {
  it('WAV туда и обратно; шум при заданном SNR — по мощности речи, без пауз', () => {
    const speech = new Float32Array(RATE).map(
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE),
    );
    const back = decodeWav(encodeWav(speech));
    expect(back.rate).toBe(RATE);
    expect(back.samples.length).toBe(speech.length);
    const mixed = noisyFramed(speech, 'pink', 10, 7);
    // Обёртка: 0.5 с до и 1 с после.
    expect(mixed.length).toBe(speech.length + 1.5 * RATE);
    const start = 0.5 * RATE;
    const noisePart = new Float32Array(speech.length).map(
      (_, i) => mixed[start + i] - speech[i],
    );
    expect(snrDb(speech, noisePart)).toBeCloseTo(10, 0);
    // Детерминизм: тот же seed — те же байты.
    expect(noisyFramed(speech, 'pink', 10, 7)).toEqual(mixed);
    expect(noise('cafe', 0.1, 1)).not.toEqual(noise('cafe', 0.1, 2));
  });
});

// ── План, цена, потолок ─────────────────────────────────────────────────

describe('план и оценка стоимости', () => {
  it('по умолчанию: 250 описаний, 200 синтезов, 200 × 3 звука × 2 движка распознаваний', () => {
    const plan = buildPlan(DEFAULT_OPTIONS);
    expect(plan.classify).toHaveLength(250);
    expect(plan.synth).toHaveLength(200);
    expect(plan.stt).toHaveLength(1200);
    const noisy = plan.stt.filter((t) => t.snr !== null);
    expect(new Set(noisy.map((t) => t.noise))).toEqual(
      new Set(['cafe', 'tv', 'pink']),
    );
    const limited = buildPlan({ ...DEFAULT_OPTIONS, limit: 3 });
    expect(limited.classify).toHaveLength(15);
    expect(limited.synth).toHaveLength(6);
  });

  it('запас на запрос классификатора не меньше настоящего запроса', () => {
    expect(buildRegisterPrompt('').length).toBeLessThanOrEqual(
      CLASSIFIER_PROMPT_OVERHEAD_CHARS,
    );
  });

  it('оценка положительна у каждой строки и растёт с объёмом', () => {
    const full = estimatePlan(buildPlan(DEFAULT_OPTIONS));
    expect(full.lines.every((l) => l.micro > 0)).toBe(true);
    const small = estimatePlan(buildPlan({ ...DEFAULT_OPTIONS, limit: 5 }));
    expect(small.totalMicro).toBeLessThan(full.totalMicro);
    expect(classifyCostMicro('x'.repeat(200))).toBeGreaterThan(
      classifyCostMicro('x'),
    );
  });
});

function fakeProviders(over: Partial<Providers> = {}): Providers & {
  calls: { classify: number; synth: number; recognize: number };
} {
  const calls = { classify: 0, synth: 0, recognize: 0 };
  return {
    calls,
    async classify(text) {
      calls.classify++;
      return {
        register: /funeral|похорон/i.test(text) ? 'MOURNING' : 'CELEBRATORY',
        micro: classifyCostMicro(text),
      };
    },
    async synthesize() {
      calls.synth++;
      return { pcm: new Float32Array(RATE / 2).fill(0.1), micro: 10 };
    },
    async recognize(engine) {
      calls.recognize++;
      return {
        text: 'Поздравление для Марины от Андрея',
        micro: engine === 'gemini' ? 300 : 30,
      };
    },
    ...over,
  };
}

describe('прогон на двойниках', () => {
  const tiny = {
    ...DEFAULT_OPTIONS,
    limit: 2,
    snr: [null],
    speechLangs: ['ru' as const],
  };

  it('потолок: прогон останавливается ДО вызова, который за него вышел бы', async () => {
    const plan = buildPlan(tiny);
    const providers = fakeProviders();
    const cap = classifyCostMicro(plan.classify[0].text) * 3;
    const r = await runEval(plan, providers, new Budget(cap));
    expect(r.stopped).toMatch(/потолок/);
    expect(r.spentMicro).toBeLessThanOrEqual(cap);
    expect(providers.calls.classify).toBeLessThanOrEqual(3);
    expect(providers.calls.recognize).toBe(0);
  });

  it('модель молчит (неверный ключ) — стоп после 5 пустых ответов без расхода', async () => {
    const plan = buildPlan({ ...tiny, limit: 10, parts: ['classifier'] });
    let n = 0;
    const providers = fakeProviders({
      classify: async () => (n++, { register: null, micro: 0 }),
    });
    const r = await runEval(plan, providers, new Budget(10_000_000));
    expect(r.stopped).toMatch(/GEMINI_API_KEY/);
    expect(n).toBe(CLASSIFIER_SILENT_LIMIT);
  });

  it('редкий пустой ответ с расходом — не стоп', async () => {
    const plan = buildPlan({ ...tiny, limit: 10, parts: ['classifier'] });
    const providers = fakeProviders({
      classify: async () => ({ register: null, micro: 5 }),
    });
    const r = await runEval(plan, providers, new Budget(10_000_000));
    expect(r.stopped).toBeFalsy();
  });

  it('ответ латиницей — ровно один строгий повтор, как в продукте', async () => {
    const reqs: boolean[] = [];
    const providers = fakeProviders({
      async recognize(_engine, _wav, req) {
        reqs.push(req.strict);
        return {
          text: req.strict
            ? 'Поздравление для Марины'
            : 'Pozdravlenie dlya Mariny',
          micro: 1,
        };
      },
    });
    const plan = buildPlan({
      ...tiny,
      parts: ['stt'],
      engines: ['gemini'],
      limit: 1,
    });
    const r = await runEval(plan, providers, new Budget(1_000_000));
    expect(reqs).toEqual([false, true]);
    expect(r.sttRows[0]).toMatchObject({
      retried: true,
      first: 'Pozdravlenie dlya Mariny',
      hypothesis: 'Поздравление для Марины',
    });
  });

  it('язык: от провайдера по звуку, иначе по буквам; подсказки — оба кириллических, имена брифа', async () => {
    const seen: Array<{ hints: string[]; names: string[] }> = [];
    const providers = fakeProviders({
      async recognize(engine, _wav, req) {
        seen.push({ hints: req.hints, names: req.names });
        return engine === 'soniox'
          ? { text: 'Привітання для Мирослави', language: 'uk', micro: 1 }
          : { text: 'Поздравление для Марины от Андрея', micro: 1 };
      },
    });
    const plan = buildPlan({ ...tiny, parts: ['stt'], limit: 1 });
    const r = await runEval(plan, providers, new Budget(1_000_000));
    const gemini = r.sttRows.find((x) => x.engine === 'gemini')!;
    const soniox = r.sttRows.find((x) => x.engine === 'soniox')!;
    expect(gemini).toMatchObject({ language: 'ru', languageSource: 'letters' });
    expect(soniox).toMatchObject({
      language: 'uk',
      languageSource: 'provider',
    });
    expect(seen[0]).toEqual({
      hints: ['ru', 'uk'],
      names: ['Марина', 'Андрей'],
    });
    // Сводка: язык soniox (движок продукта) не совпал — приёмочные ворота
    // §8.3 не пройдены; у gemini ворота свои и справочные.
    const s = summarize(r);
    const gate = s.gates.find(
      (g) => g.name.includes('[soniox]') && g.name.includes('язык'),
    )!;
    expect(gate.ok).toBe(false);
    expect(gatePassed(gate)).toBe(false);
    expect(
      s.gates.find(
        (g) => g.name.includes('[soniox]') && g.name.includes('латиницей'),
      )!.ok,
    ).toBe(true);
    const gem = s.gates.filter((g) => g.name.includes('gemini, справочно'));
    expect(gem).toHaveLength(4);
    expect(gem.every((g) => g.informational)).toBe(true);
  });

  it('§8.3 ворота по движкам: провал справочного движка не роняет прогон, пороги WER и имён — по каждому шуму', () => {
    const row = (
      engine: 'gemini' | 'soniox',
      snr: number | null,
      hypothesis: string,
      language: string,
    ): SttRow => ({
      id: 'ru-001',
      lang: 'ru',
      voice: 'v',
      snr,
      noise: snr === null ? null : 'cafe',
      engine,
      refs: ['Поздравляем, Марина'],
      names: ['Марина'],
      tags: ['field'],
      hypothesis,
      first: hypothesis,
      retried: false,
      language,
      languageSource: engine === 'soniox' ? 'provider' : 'letters',
    });
    const r: RunResult = {
      classRows: [],
      stopped: null,
      spentMicro: 0,
      sttRows: [null, 20, 10].flatMap((snr) => [
        // soniox — дословно; gemini — по-украински и без имени.
        row('soniox', snr, 'Поздравляем, Марина', 'ru'),
        row('gemini', snr, 'Привітання для когось', 'uk'),
      ]),
    };
    const s = summarize(r);
    const soniox = s.gates.filter((g) => g.name.includes('[soniox]'));
    expect(soniox.map((g) => g.name)).toEqual([
      expect.stringMatching(/латиницей/),
      expect.stringMatching(/язык ответа/),
      expect.stringMatching(/WER ≤ 5\.0%/),
      expect.stringMatching(/имена ≥ 97\.0%/),
    ]);
    expect(soniox.every(gatePassed)).toBe(true);
    const gemini = s.gates.filter((g) => g.name.includes('gemini, справочно'));
    expect(gemini.find((g) => /WER/.test(g.name))!.ok).toBe(false);
    expect(gemini.every(gatePassed)).toBe(true);
    // Приёмочные ворота идут первыми, справочные помечены ℹ.
    expect(s.gates.findIndex((g) => g.name.includes('[soniox]'))).toBeLessThan(
      s.gates.findIndex((g) => g.name.includes('gemini')),
    );
    const md = summaryMarkdown(s, r, {
      estimateMicro: 0,
      capMicro: 0,
      startedAt: 'x',
    });
    expect(md).toMatch(/- ℹ §8\.3 \[gemini, справочно\] WER/);
  });

  it('остановленный прогон: ворота «не проверено», а не ✓ (и не проходят в коде выхода)', async () => {
    const plan = buildPlan({ ...tiny, limit: 10, parts: ['classifier'] });
    const providers = fakeProviders({
      classify: async () => ({ register: null, micro: 0 }),
    });
    const r = await runEval(plan, providers, new Budget(10_000_000));
    const s = summarize(r);
    expect(s.gates[0]).toMatchObject({ unchecked: true, ok: false });
    expect(gatePassed(s.gates[0])).toBe(false);
    const md = summaryMarkdown(s, r, {
      estimateMicro: 0,
      capMicro: 0,
      startedAt: 'x',
    });
    expect(md).toMatch(/- — §8\.1 .*не проверено/);
    expect(md).not.toMatch(/✓ §8\.1/);
    expect(r.stopped).toMatch(/402/);
  });

  it('классификатор не ответил ни на одно траурное (без остановки) — «не проверено»', async () => {
    const plan = buildPlan({ ...tiny, parts: ['classifier'], limit: 50 });
    const mourning = new Set(
      plan.classify.filter((t) => t.label === 'MOURNING').map((t) => t.text),
    );
    const r = await runEval(
      plan,
      fakeProviders({
        classify: async (text) => ({
          register: mourning.has(text) ? null : 'CELEBRATORY',
          micro: 5,
        }),
      }),
      new Budget(10_000_000),
    );
    expect(r.stopped).toBeFalsy();
    const s = summarize(r);
    expect(s.gates[0]).toMatchObject({ unchecked: true, ok: false });
    expect(s.gates[0].detail).toMatch(/ни на одно траурное/);
  });

  it('сводка классификатора: траурный как праздничный роняет ворота §8.1; цепочка со словами страхует', async () => {
    const plan = buildPlan({ ...tiny, parts: ['classifier'], limit: 50 });
    const r = await runEval(plan, fakeProviders(), new Budget(10_000_000));
    const s = summarize(r);
    expect(s.classifier!.mourningAsCelebratory.length).toBeGreaterThan(0);
    expect(s.gates[0]).toMatchObject({ ok: false });
    // Без ответа человека цепочка не опускается ниже тёплого нейтрального,
    // а траур со словом-ключом поднимается словами, что бы ни сказал
    // классификатор.
    const m01ru = r.classRows.find((x) => x.id === 'm01' && x.lang === 'ru')!;
    expect(m01ru.keyword).not.toBeNull();
    expect(m01ru.pipeline).toBe('MOURNING');
  });
});

describe('флаги и ключи', () => {
  it('без флагов — сухой режим; --apply только явно; неверный флаг — ошибка', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--dry']).apply).toBe(false);
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(() => parseArgs(['--apply', '--dry'])).toThrow(/выберите одно/);
    expect(() => parseArgs(['--bogus'])).toThrow(/неизвестный флаг/);
    expect(() => parseArgs(['--max-usd=0'])).toThrow(/--max-usd/);
    expect(() => parseArgs(['--engines=whisper'])).toThrow(/допустимо/);
    const a = parseArgs(['--snr=clean,5', '--limit=3', '--max-usd=0.5']);
    expect(a.options).toMatchObject({ snr: [null, 5], limit: 3, maxUsd: 0.5 });
  });

  it('какие ключи нужны: синтез Soniox — при любом движке распознавания', () => {
    const none = { gemini: false, soniox: false, ffmpeg: false };
    expect(
      missingForApply({ ...DEFAULT_OPTIONS, parts: ['classifier'] }, none),
    ).toEqual(['GEMINI_API_KEY']);
    expect(
      missingForApply(
        { ...DEFAULT_OPTIONS, parts: ['stt'], engines: ['soniox'] },
        { ...none, gemini: true },
      ),
    ).toEqual(['SONIOX_API_KEY', 'ffmpeg в PATH']);
    expect(
      missingForApply(DEFAULT_OPTIONS, {
        gemini: true,
        soniox: true,
        ffmpeg: true,
      }),
    ).toEqual([]);
  });

  it('цена распознавания Gemini выше Soniox на той же фразе (звук в токенах)', () => {
    const phrase = SPEECH_SET[0];
    expect(sttCostMicro({ phrase, engine: 'gemini' })).toBeGreaterThan(
      sttCostMicro({ phrase, engine: 'soniox' }),
    );
  });
});

describe('диагностика живого прогона', () => {
  it('строка прогресса: стадия, сделано/всего, время, остаток, расход, пустые, последний вызов', () => {
    const line = progressLine(
      {
        stage: 'классификатор',
        done: 50,
        total: 250,
        spentMicro: 45_000,
        empty: 3,
        lastMs: 1_400,
      },
      60_000,
    );
    expect(line).toMatch(/\[классификатор\] 50\/250/);
    expect(line).toMatch(/прошло 1:00/);
    expect(line).toMatch(/осталось ~4:00/);
    expect(line).toMatch(/пустых ответов 3/);
    expect(line).toMatch(/последний вызов 1\.4 с/);
  });

  it('консоль: старт стадии, первый и последний шаг всегда, долгий вызов — предупреждение', async () => {
    const lines: string[] = [];
    let t = 0;
    const hooks = consoleHooks(
      (l) => lines.push(l),
      60_000,
      () => t,
    );
    const providers = fakeProviders({
      classify: async () => {
        t += 1_000;
        return { register: 'CELEBRATORY', micro: 5 };
      },
    });
    const plan = buildPlan({
      ...DEFAULT_OPTIONS,
      limit: 3,
      parts: ['classifier'],
    });
    await runEval(plan, providers, new Budget(10_000_000), undefined, hooks);
    expect(lines[0]).toMatch(/Начинаю: классификатор/);
    expect(lines.some((l) => l.includes(`1/${plan.classify.length}`))).toBe(
      true,
    );
    expect(lines.at(-1)).toContain(
      `${plan.classify.length}/${plan.classify.length}`,
    );
    hooks.waiting!('классификатор', 'm01.ru', 65_000);
    expect(lines.at(-1)).toMatch(/ждём ответ на m01\.ru уже 65 с.*Ctrl\+C/);
  });

  it('отчёт группирует пустые ответы классификатора по причине', async () => {
    const plan = buildPlan({
      ...DEFAULT_OPTIONS,
      limit: 3,
      parts: ['classifier'],
    });
    const r = await runEval(
      plan,
      fakeProviders({
        classify: async () => ({
          register: null,
          micro: 5,
          why: 'empty-answer finishReason=MAX_TOKENS',
        }),
      }),
      new Budget(10_000_000),
    );
    const md = summaryMarkdown(summarize(r), r, {
      estimateMicro: 0,
      capMicro: 0,
      startedAt: 'x',
    });
    expect(md).toMatch(/Пустые ответы по причинам/);
    expect(md).toMatch(/\d+ × empty-answer finishReason=MAX_TOKENS/);
  });
});
