// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/ai-pricing.spec.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

import {
  AI_PROVIDERS,
  estimateCost,
  formatMicroUsd,
  geminiUsageUnits,
  MODEL_RATES,
  ModelRate,
  priceEnvKey,
  pricingTable,
  parseModalityDetails,
  rateFor,
} from './ai-pricing';

describe('ai-pricing (ТЗ §26)', () => {
  it('токены считаются по ставке за миллион', () => {
    // gemini-2.5-flash: $0.30 вход / $2.50 выход за 1M.
    const { costMicroUsd, unpriced } = estimateCost(
      'gemini-2.5-flash',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      {},
    );
    expect(unpriced).toBe(false);
    expect(costMicroUsd).toBe(2_800_000); // $2.80
  });

  it('секунды видео считаются по ставке за секунду', () => {
    // Veo Lite $0.15/сек × 8 секунд ролика.
    expect(
      estimateCost('veo-3.1-lite-generate-preview', { seconds: 8 }, {})
        .costMicroUsd,
    ).toBe(1_200_000);
  });

  it('Grok — три разных ставки по разрешению на одну модель, не одна общая (§10.2 ТЗ)', () => {
    // 480p $0.08, 720p $0.14, 1080p $0.25 — за 8-секундный ролик.
    expect(
      estimateCost('grok-imagine-video-1.5:480p', { seconds: 8 }, {})
        .costMicroUsd,
    ).toBe(640_000);
    expect(
      estimateCost('grok-imagine-video-1.5:720p', { seconds: 8 }, {})
        .costMicroUsd,
    ).toBe(1_120_000);
    expect(
      estimateCost('grok-imagine-video-1.5:1080p', { seconds: 8 }, {})
        .costMicroUsd,
    ).toBe(2_000_000);
  });

  it('синтез речи считается в символах, а не в токенах', () => {
    // Тариф Creator: $22 за 100 000 символов, то есть $0.22 за тысячу.
    // До этой проверки ветка `perMChars` не исполнялась ни разу: потеря
    // ставки давала бы `{ costMicroUsd: 0, unpriced: false }` — тот самый
    // «молчаливый ноль», против которого и придуман флаг `unpriced`.
    const r = estimateCost('elevenlabs-tts', { characters: 1000 }, {});
    expect(r.costMicroUsd).toBe(220_000); // $0.22
    expect(r.unpriced).toBe(false);
  });

  it('токены в счёт озвучки не идут, а символы — в счёт текстовой модели', () => {
    // Подогнать символы под «токены» значило бы врать в отчёте: у TTS
    // провайдер считает именно символы, и обе единицы не взаимозаменяемы.
    expect(
      estimateCost('elevenlabs-tts', { inputTokens: 1_000_000 }, {})
        .costMicroUsd,
    ).toBe(0);
    expect(
      estimateCost('gemini-2.5-flash', { characters: 1_000_000 }, {})
        .costMicroUsd,
    ).toBe(0);
  });

  it('символов не было — озвучка ничего не стоит', () => {
    // Пустая реплика не должна попадать в счёт: у ElevenLabs нет
    // поштучной ставки, и платить не за что.
    expect(
      estimateCost('elevenlabs-tts', { characters: 0 }, {}).costMicroUsd,
    ).toBe(0);
  });

  it('кешированные токены дешевле обычных и не оплачиваются дважды', () => {
    // Провайдер отдаёт кеш ОТДЕЛЬНЫМ счётчиком внутри общего входа
    // (§26.1). Не вычесть его — значит оплатить один и тот же токен
    // дважды и завысить отчёт.
    // 600k свежих × $0.30/M + 400k кеша × $0.03/M (прайс 2026-10-07).
    expect(
      estimateCost(
        'gemini-2.5-flash',
        { inputTokens: 1_000_000, cachedInputTokens: 400_000 },
        {},
      ).costMicroUsd,
    ).toBe(192_000);
  });

  it('кеша больше, чем входа, — счёт не уходит в минус', () => {
    // Битый или расходящийся счётчик провайдера не должен вычесть из
    // суммы больше, чем в неё положили.
    expect(
      estimateCost(
        'gemini-2.5-flash',
        { inputTokens: 1_000_000, cachedInputTokens: 5_000_000 },
        {},
      ).costMicroUsd,
    ).toBe(30_000);
    expect(
      estimateCost(
        'gemini-2.5-flash',
        { inputTokens: 1_000_000, cachedInputTokens: -400_000 },
        {},
      ).costMicroUsd,
    ).toBe(300_000);
  });

  it('без своей ставки кеша он считается по обычной входной', () => {
    // Ставка кеша необязательна: у модели, для которой её не завели,
    // кеш тарифицируется как обычный вход — расход ЗАВЫШАЕТСЯ. Так было
    // у всех моделей до этапа 32, и это сознательный перекос в
    // безопасную сторону: занизить сумму в отчёте о деньгах хуже.
    const rates = MODEL_RATES as Record<string, ModelRate>;
    rates['модель-без-ставки-кеша'] = {
      provider: 'GEMINI',
      inputPerMTok: 1_000_000, // $1 за миллион входных
      note: 'ставка заведена только этой проверкой',
    };
    try {
      const r = estimateCost(
        'модель-без-ставки-кеша',
        { inputTokens: 1_000_000, cachedInputTokens: 400_000 },
        {},
      );
      // 600k свежих + 400k кеша по той же цене = ровно $1, а не $0.60.
      expect(r.costMicroUsd).toBe(1_000_000);
      expect(r.unpriced).toBe(false);
    } finally {
      delete rates['модель-без-ставки-кеша'];
    }
  });

  it('поштучный вызов считается даже без явного calls', () => {
    expect(estimateCost('serpapi', {}, {}).costMicroUsd).toBe(30_000);
    expect(estimateCost('serpapi', { calls: 3 }, {}).costMicroUsd).toBe(90_000);
  });

  it('бесплатная квота — это ноль с известной ставкой, а не unpriced', () => {
    const r = estimateCost('youtube-data-api', {}, {});
    expect(r.costMicroUsd).toBe(0);
    expect(r.unpriced).toBe(false);
  });

  it('неизвестная модель не считается бесплатной — поднимается unpriced', () => {
    // Иначе новая модель, добавленная в код и забытая в прайсе, тихо
    // занижала бы общую сумму.
    const r = estimateCost('gemini-9.9-ultra', { inputTokens: 5_000_000 }, {});
    expect(r.costMicroUsd).toBe(0);
    expect(r.unpriced).toBe(true);
  });

  it('переменная окружения переопределяет ставку и задаётся в долларах', () => {
    const env = { [priceEnvKey('gemini-2.5-flash', 'input')]: '1.50' };
    expect(
      estimateCost('gemini-2.5-flash', { inputTokens: 1_000_000 }, env)
        .costMicroUsd,
    ).toBe(1_500_000);
  });

  it('ключ переменной строится предсказуемо', () => {
    expect(priceEnvKey('veo-3.1-lite-generate-preview', 'second')).toBe(
      'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_SECOND',
    );
  });

  it('мусор в переменной не обнуляет ставку', () => {
    // Молча обнулить ставку хуже, чем остаться на значении из кода:
    // нулевой расход прочитают как правду.
    for (const bad of ['', '   ', 'дёшево', '-1', 'NaN']) {
      const env = { [priceEnvKey('serpapi', 'call')]: bad };
      expect(estimateCost('serpapi', {}, env).costMicroUsd).toBe(30_000);
    }
  });

  it('ноль в переменной — законное значение (договорились о бесплатном доступе)', () => {
    const env = { [priceEnvKey('serpapi', 'call')]: '0' };
    expect(estimateCost('serpapi', {}, env).costMicroUsd).toBe(0);
  });

  it('таблица прайса помечает переопределённые ставки', () => {
    const plain = pricingTable({});
    expect(plain.every((r) => !r.overridden)).toBe(true);

    const env = { [priceEnvKey('gemini-2.5-flash', 'output')]: '9' };
    const row = pricingTable(env).find((r) => r.model === 'gemini-2.5-flash')!;
    expect(row.overridden).toBe(true);
    expect(row.outputPerMTokUsd).toBe(9);
  });

  it('у каждой ставки есть пояснение, откуда она взята', () => {
    // Прайс с неизвестным происхождением — это выдумка в отчёте о деньгах.
    for (const model of Object.keys(MODEL_RATES)) {
      expect(rateFor(model, {})!.note.length).toBeGreaterThan(10);
    }
  });

  it('hedra-character-3 (пилот аватара, этап 72) считается по секундам, провайдер HEDRA', () => {
    expect(AI_PROVIDERS).toContain('HEDRA');
    const { costMicroUsd, unpriced } = estimateCost(
      'hedra-character-3',
      { seconds: 10 },
      {},
    );
    expect(unpriced).toBe(false);
    expect(rateFor('hedra-character-3', {})!.provider).toBe('HEDRA');
    expect(costMicroUsd).toBeGreaterThan(0);
  });

  it('gemini-embedding-001 (знания помощника) — только вход, $0.15 за 1M токенов', () => {
    const { costMicroUsd, unpriced } = estimateCost(
      'gemini-embedding-001',
      { inputTokens: 1_000_000 },
      {},
    );
    expect(unpriced).toBe(false);
    expect(costMicroUsd).toBe(150_000);
    expect(rateFor('gemini-embedding-001', {})!.provider).toBe('GEMINI');
    // Выходных токенов у эмбеддинга нет — их число не меняет счёт.
    expect(
      estimateCost(
        'gemini-embedding-001',
        { inputTokens: 1_000, outputTokens: 1_000_000 },
        {},
      ).costMicroUsd,
    ).toBe(150);
    expect(priceEnvKey('gemini-embedding-001', 'input')).toBe(
      'AI_PRICE_GEMINI_EMBEDDING_001_INPUT',
    );
  });

  it('мелкие суммы не округляются до нуля при показе', () => {
    expect(formatMicroUsd(0)).toBe('$0');
    expect(formatMicroUsd(4_200)).toBe('$0.0042');
    expect(formatMicroUsd(1_234_567)).toBe('$1.23');
  });
});

// C1 захода 8 (ТЗ поздравлений 2.0 стр. 1940): звук на входе Gemini
// дороже текста, и голос, посчитанный по текстовой ставке, занижал и
// отчёт, и потолок голоса В-14.
describe('ai-pricing — вход по модальностям (звук, картинки, видео)', () => {
  const M = 1_000_000;

  it('звук у 2.5 Flash — по своей ставке $1.00, а не по текстовой $0.30', () => {
    expect(
      estimateCost(
        'gemini-2.5-flash',
        { inputTokens: M, inputByModality: { AUDIO: M } },
        {},
      ).costMicroUsd,
    ).toBe(1_000_000);
  });

  it('смешанный вход: звук по звуковой, остаток — по текстовой', () => {
    // 1M звука × $1.00 + 1M текста × $0.30.
    expect(
      estimateCost(
        'gemini-2.5-flash',
        { inputTokens: 2 * M, inputByModality: { AUDIO: M } },
        {},
      ).costMicroUsd,
    ).toBe(1_300_000);
  });

  it('2.5 Flash-Lite: звук $0.30 против $0.10 у текста', () => {
    expect(
      estimateCost(
        'gemini-2.5-flash-lite',
        { inputTokens: 2 * M, inputByModality: { AUDIO: M } },
        {},
      ).costMicroUsd,
    ).toBe(400_000);
  });

  it('без разбивки — ровно как раньше (вся сумма по текстовой ставке)', () => {
    expect(
      estimateCost('gemini-2.5-flash', { inputTokens: M }, {}).costMicroUsd,
    ).toBe(300_000);
  });

  it('у модели без своей ставки звука (3.6 Flash) звук идёт по входной', () => {
    expect(rateFor('gemini-3.6-flash', {})!.audioInputPerMTok).toBeUndefined();
    expect(
      estimateCost(
        'gemini-3.6-flash',
        { inputTokens: M, inputByModality: { AUDIO: M } },
        {},
      ).costMicroUsd,
    ).toBe(750_000);
  });

  it('картинки и видео без своей ставки — по текстовой; со ставкой из env — по ней', () => {
    const units = {
      inputTokens: 3 * M,
      inputByModality: { IMAGE: M, VIDEO: M },
    };
    expect(estimateCost('gemini-2.5-flash', units, {}).costMicroUsd).toBe(
      900_000,
    );
    const env = {
      [priceEnvKey('gemini-2.5-flash', 'video_input')]: '2',
      [priceEnvKey('gemini-2.5-flash', 'image_input')]: '0.5',
    };
    // видео $2 + картинки $0.50 + текст $0.30.
    expect(estimateCost('gemini-2.5-flash', units, env).costMicroUsd).toBe(
      2_800_000,
    );
  });

  it('ставка звука переопределяется своей переменной и видна в таблице прайса', () => {
    const key = priceEnvKey('gemini-2.5-flash', 'audio_input');
    expect(key).toBe('AI_PRICE_GEMINI_2_5_FLASH_AUDIO_INPUT');
    const env = { [key]: '2' };
    expect(
      estimateCost(
        'gemini-2.5-flash',
        { inputTokens: M, inputByModality: { AUDIO: M } },
        env,
      ).costMicroUsd,
    ).toBe(2_000_000);
    const plain = pricingTable({}).find((r) => r.model === 'gemini-2.5-flash')!;
    expect(plain.audioInputPerMTokUsd).toBe(1);
    expect(plain.overridden).toBe(false);
    const row = pricingTable(env).find((r) => r.model === 'gemini-2.5-flash')!;
    expect(row.audioInputPerMTokUsd).toBe(2);
    expect(row.overridden).toBe(true);
  });

  it('кеш без разбивки сначала съедает текст — дорогой звук остаётся по своей ставке', () => {
    // 1M входа: 600k звука, 400k текста; 300k из кеша — из текста.
    // 100k текста × $0.30 + 600k звука × $1.00 + 300k кеша текста × $0.03.
    expect(
      estimateCost(
        'gemini-2.5-flash',
        {
          inputTokens: M,
          cachedInputTokens: 300_000,
          inputByModality: { AUDIO: 600_000 },
        },
        {},
      ).costMicroUsd,
    ).toBe(639_000);
    // Кеша больше, чем текста: остаток кеша — из звука.
    // 500k звука × $1.00 + кеш: 400k текста × $0.03 + 100k звука × $0.10.
    expect(
      estimateCost(
        'gemini-2.5-flash',
        {
          inputTokens: M,
          cachedInputTokens: 500_000,
          inputByModality: { AUDIO: 600_000 },
        },
        {},
      ).costMicroUsd,
    ).toBe(522_000);
  });

  it('кеш без разбивки после текста берёт дешёвые картинки, а не звук', () => {
    // 1M: 400k звука, 400k картинок, 200k текста; 500k кеша — 200k
    // текста и 300k картинок. Свежие: 400k звука × $1 + 100k картинок ×
    // $0.30; кеш 500k (текст и картинки) × $0.03.
    expect(
      estimateCost(
        'gemini-2.5-flash',
        {
          inputTokens: M,
          cachedInputTokens: 500_000,
          inputByModality: { AUDIO: 400_000, IMAGE: 400_000 },
        },
        {},
      ).costMicroUsd,
    ).toBe(445_000);
  });

  it('кеш с разбивкой вычитается из своей модальности', () => {
    // Из 600k звука 300k в кеше: 300k звука × $1 + 400k текста × $0.30 +
    // 300k кеша звука × $0.10.
    expect(
      estimateCost(
        'gemini-2.5-flash',
        {
          inputTokens: M,
          cachedInputTokens: 300_000,
          inputByModality: { AUDIO: 600_000 },
          cachedByModality: { AUDIO: 300_000 },
        },
        {},
      ).costMicroUsd,
    ).toBe(450_000);
  });

  it('кеш звука — по своей ставке (Flash-Lite $0.03 против $0.01), переопределяется env', () => {
    const units = {
      inputTokens: 2 * M,
      cachedInputTokens: 2 * M,
      inputByModality: { AUDIO: M },
      cachedByModality: { AUDIO: M },
    };
    // 1M кеша звука × $0.03 + 1M кеша текста × $0.01.
    expect(estimateCost('gemini-2.5-flash-lite', units, {}).costMicroUsd).toBe(
      40_000,
    );
    const key = priceEnvKey('gemini-2.5-flash-lite', 'cached_audio');
    expect(key).toBe('AI_PRICE_GEMINI_2_5_FLASH_LITE_CACHED_AUDIO');
    expect(
      estimateCost('gemini-2.5-flash-lite', units, { [key]: '0.5' })
        .costMicroUsd,
    ).toBe(510_000);
    const row = pricingTable({ [key]: '0.5' }).find(
      (r) => r.model === 'gemini-2.5-flash-lite',
    )!;
    expect(row.cachedAudioInputPerMTokUsd).toBe(0.5);
    expect(row.overridden).toBe(true);
    // Разбивка кеша без разбивки входа — звук в кеше всё равно по своей.
    expect(
      estimateCost(
        'gemini-2.5-flash-lite',
        {
          inputTokens: M,
          cachedInputTokens: M,
          cachedByModality: { AUDIO: M },
        },
        {},
      ).costMicroUsd,
    ).toBe(30_000);
  });

  it('кеш 2.5 по прайсу 2026-10-07: Flash $0.03, Flash-Lite $0.01, Pro $0.125', () => {
    expect(rateFor('gemini-2.5-flash', {})!.cachedInputPerMTok).toBe(30_000);
    expect(rateFor('gemini-2.5-flash', {})!.cachedAudioInputPerMTok).toBe(
      100_000,
    );
    expect(rateFor('gemini-2.5-flash-lite', {})!.cachedInputPerMTok).toBe(
      10_000,
    );
    expect(rateFor('gemini-2.5-pro', {})!.cachedInputPerMTok).toBe(125_000);
  });

  it('разбивка больше входа не раздувает счёт сверх входа', () => {
    expect(
      estimateCost(
        'gemini-2.5-flash',
        { inputTokens: 100_000, inputByModality: { AUDIO: 500_000 } },
        {},
      ).costMicroUsd,
    ).toBe(100_000);
  });

  it('разбор promptTokensDetails: звук/картинки/видео, мусор пропускается', () => {
    expect(parseModalityDetails(undefined)).toBeUndefined();
    expect(parseModalityDetails('AUDIO')).toBeUndefined();
    expect(parseModalityDetails([])).toBeUndefined();
    expect(
      parseModalityDetails([{ modality: 'TEXT', tokenCount: 10 }]),
    ).toBeUndefined();
    expect(
      parseModalityDetails([
        { modality: 'TEXT', tokenCount: 10 },
        { modality: 'AUDIO', tokenCount: 100 },
        { modality: 'audio', tokenCount: 5 },
        { modality: 'IMAGE', tokenCount: -3 },
        { modality: 'VIDEO', tokenCount: 'много' },
        null,
        { tokenCount: 7 },
      ]),
    ).toEqual({ AUDIO: 105, IMAGE: 0, VIDEO: 0 });
  });

  it('geminiUsageUnits без разбивки — прежние единицы, с разбивкой — ещё и модальности', () => {
    const base = {
      promptTokenCount: 1000,
      cachedContentTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 20,
    };
    expect(geminiUsageUnits(base)).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 70,
    });
    expect(geminiUsageUnits(undefined)).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(
      geminiUsageUnits({
        ...base,
        promptTokensDetails: [
          { modality: 'TEXT', tokenCount: 200 },
          { modality: 'AUDIO', tokenCount: 800 },
        ],
        cacheTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
      }),
    ).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 70,
      inputByModality: { AUDIO: 800 },
      cachedByModality: { AUDIO: 100 },
    });
  });

  it('без явного env ставки и их переопределения читаются из process.env', () => {
    const key = priceEnvKey('serpapi', 'call');
    const saved = process.env[key];
    process.env[key] = '0.5';
    try {
      expect(rateFor('serpapi')!.perCall).toBe(500_000);
      expect(estimateCost('serpapi', {}).costMicroUsd).toBe(500_000);
      const row = pricingTable().find((r) => r.model === 'serpapi')!;
      expect(row.perCallUsd).toBe(0.5);
      expect(row.overridden).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });
});
