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
  PRICE_ENV_KEY_EXCEPTIONS,
  PRICE_KINDS,
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

// TODO «запас покрытия веток `common/ai-pricing.ts` над порогом 95 % мал»:
// крайние случаи модальностей, кеша, unpriced и переопределений — чтобы
// правка прайса, задевшая одну из веток, падала здесь, а не в отчёте.
describe('ai-pricing — крайние случаи (модальности, кеш, unpriced, env)', () => {
  // Своих ставок картинок/видео в прайсе нет — задаём их env, чтобы три
  // модальности различались ценой.
  const ENV_IMG_VIDEO = {
    [priceEnvKey('gemini-2.5-flash', 'image_input')]: '0.5',
    [priceEnvKey('gemini-2.5-flash', 'video_input')]: '0.8',
  };

  it('разбивка больше свежего входа урезается с дешёвого: звук → видео → картинки', () => {
    // Вход 1M: звук 600k целиком, видео 300k целиком, картинкам — остаток
    // 100k, тексту — ничего: 0.6×$1.00 + 0.3×$0.80 + 0.1×$0.50 = $0.89.
    expect(
      estimateCost(
        'gemini-2.5-flash',
        {
          inputTokens: 1_000_000,
          inputByModality: { AUDIO: 600_000, VIDEO: 300_000, IMAGE: 300_000 },
        },
        ENV_IMG_VIDEO,
      ).costMicroUsd,
    ).toBe(890_000);
  });

  it('кеш без разбивки: текст → картинки → видео и только остаток — звук', () => {
    // Вход 1M (текст 200k, звук 400k, видео 200k, картинки 200k), кеш
    // 700k: текст 200k, картинки 200k, видео 200k, звук 100k. Свежий —
    // звук 300k ($0.30); кеш звука 100k × $0.10 = $0.01; прочий кеш
    // 600k × $0.03 = $0.018. Итого $0.328.
    expect(
      estimateCost(
        'gemini-2.5-flash',
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 700_000,
          inputByModality: { AUDIO: 400_000, VIDEO: 200_000, IMAGE: 200_000 },
        },
        ENV_IMG_VIDEO,
      ).costMicroUsd,
    ).toBe(328_000);
  });

  it('разбивка кеша без разбивки входа: звук в кеше не больше самого кеша', () => {
    // Flash-Lite: кеш 500k, провайдер назвал звуком 900k — по ставке кеша
    // звука идут 500k ($0.015), свежие 500k — текстом ($0.05).
    expect(
      estimateCost(
        'gemini-2.5-flash-lite',
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 500_000,
          cachedByModality: { AUDIO: 900_000 },
        },
        {},
      ).costMicroUsd,
    ).toBe(65_000);
  });

  it('мусор в разбивке и отрицательный кеш — как будто их нет', () => {
    const plain = estimateCost(
      'gemini-2.5-flash',
      { inputTokens: 1_000_000 },
      {},
    ).costMicroUsd;
    expect(plain).toBe(300_000);
    expect(
      estimateCost(
        'gemini-2.5-flash',
        {
          inputTokens: 1_000_000,
          cachedInputTokens: -100,
          inputByModality: { AUDIO: NaN, VIDEO: -5, IMAGE: Infinity },
          cachedByModality: { AUDIO: -1 },
        },
        ENV_IMG_VIDEO,
      ).costMicroUsd,
    ).toBe(plain);
  });

  it('нет входных токенов — кеш и разбивка без них ничего не стоят, выход считается', () => {
    expect(
      estimateCost(
        'gemini-2.5-flash',
        {
          inputTokens: 0,
          cachedInputTokens: 500,
          inputByModality: { AUDIO: 500 },
          cachedByModality: { AUDIO: 500 },
          outputTokens: 1_000_000,
        },
        {},
      ).costMicroUsd,
    ).toBe(2_500_000);
  });

  it('модель без входной ставки (генерация картинок) — вход не считается вовсе', () => {
    expect(
      estimateCost(
        'gemini-2.5-flash-image',
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 1_000,
          inputByModality: { IMAGE: 1_000 },
          outputTokens: 1_000_000,
        },
        {},
      ).costMicroUsd,
    ).toBe(30_000_000);
  });

  it('unpriced: ставки нет — нули при любых единицах, переменная окружения её не создаёт', () => {
    const env = { [priceEnvKey('gemini-9-ultra', 'input')]: '1' };
    expect(rateFor('gemini-9-ultra', env)).toBeNull();
    expect(
      estimateCost(
        'gemini-9-ultra',
        {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          seconds: 8,
          characters: 1_000,
          calls: 3,
        },
        env,
      ),
    ).toEqual({
      costMicroUsd: 0,
      unpriced: true,
      pricingVersion: expect.any(String),
    });
  });

  it('поштучные: calls — множитель, явный ноль — ноль, нулевая ставка — не unpriced', () => {
    expect(estimateCost('serpapi', { calls: 3 }, {}).costMicroUsd).toBe(90_000);
    expect(estimateCost('serpapi', { calls: 0 }, {}).costMicroUsd).toBe(0);
    expect(estimateCost('youtube-data-api', { calls: 5 }, {})).toMatchObject({
      costMicroUsd: 0,
      unpriced: false,
    });
  });

  it('секунды: дробная ставка округляется только в итоге, ноль секунд — ноль', () => {
    // Soniox async: $0.10 за час = 27.(7) микродоллара в секунду.
    expect(
      estimateCost('soniox-stt-async', { seconds: 3600 }, {}).costMicroUsd,
    ).toBe(100_000);
    expect(
      estimateCost('soniox-stt-async', { seconds: 1 }, {}).costMicroUsd,
    ).toBe(28);
    expect(
      estimateCost('veo-3.1-generate-preview', { seconds: 0 }, {}).costMicroUsd,
    ).toBe(0);
  });

  it('переменная: пробелы — ставка из кода, пробелы вокруг числа — допустимы, отрицательное — мусор', () => {
    const key = priceEnvKey('gemini-2.5-flash', 'input');
    const input = (raw: string) =>
      rateFor('gemini-2.5-flash', { [key]: raw })!.inputPerMTok;
    expect(input('   ')).toBe(300_000);
    expect(input(' 1.5 ')).toBe(1_500_000);
    expect(input('-1')).toBe(300_000);
    expect(input('1e-6')).toBe(1);
    // Меньше микродоллара за миллион — округляется до нуля, а не в мусор.
    expect(input('0.0000004')).toBe(0);
  });

  it.each([
    ['input', 'inputPerMTokUsd'],
    ['cached', 'cachedInputPerMTokUsd'],
    ['output', 'outputPerMTokUsd'],
    ['second', 'perSecondUsd'],
    ['call', 'perCallUsd'],
    ['chars', 'perMCharsUsd'],
    ['audio_input', 'audioInputPerMTokUsd'],
    ['image_input', 'imageInputPerMTokUsd'],
    ['video_input', 'videoInputPerMTokUsd'],
    ['cached_audio', 'cachedAudioInputPerMTokUsd'],
  ] as const)(
    'таблица прайса: переопределение «%s» видно в %s и помечает строку',
    (kind, column) => {
      const env = { [priceEnvKey('gemini-2.5-flash', kind)]: '0.123' };
      const row = pricingTable(env).find(
        (r) => r.model === 'gemini-2.5-flash',
      )!;
      expect(row[column]).toBe(0.123);
      expect(row.overridden).toBe(true);
      // Остальные строки не задеты.
      expect(
        pricingTable(env)
          .filter((r) => r.overridden)
          .map((r) => r.model),
      ).toEqual(['gemini-2.5-flash']);
    },
  );

  // Найдено этими тестами: `AI_PRICE_GEMINI_2_5_FLASH_IMAGE_INPUT` было
  // именем сразу двух ставок — картинок на входе 2.5 Flash и входа модели
  // картинок, и одна переменная меняла обе.
  it('у каждой ставки своя переменная: имена не совпадают ни у одной пары', () => {
    const seen = new Map<string, string>();
    for (const model of Object.keys(MODEL_RATES)) {
      for (const kind of PRICE_KINDS) {
        const key = priceEnvKey(model, kind);
        expect([key, seen.get(key)]).toEqual([key, undefined]);
        seen.set(key, `${model}/${kind}`);
      }
    }
    expect(seen.size).toBe(
      Object.keys(MODEL_RATES).length * PRICE_KINDS.length,
    );
  });

  it('совпавшее имя — за прежней ставкой, ставка по модальности — с двойным подчёркиванием', () => {
    expect(priceEnvKey('gemini-2.5-flash-image', 'input')).toBe(
      'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_INPUT',
    );
    expect(priceEnvKey('gemini-2.5-flash', 'image_input')).toBe(
      'AI_PRICE_GEMINI_2_5_FLASH__IMAGE_INPUT',
    );
    // Без совпадения — обычное имя.
    expect(priceEnvKey('gemini-2.5-flash', 'audio_input')).toBe(
      'AI_PRICE_GEMINI_2_5_FLASH_AUDIO_INPUT',
    );
    expect(priceEnvKey('gemini-2.5-flash-lite', 'image_input')).toBe(
      'AI_PRICE_GEMINI_2_5_FLASH_LITE_IMAGE_INPUT',
    );

    const plain = { AI_PRICE_GEMINI_2_5_FLASH_IMAGE_INPUT: '2' };
    expect(rateFor('gemini-2.5-flash-image', plain)!.inputPerMTok).toBe(
      2_000_000,
    );
    expect(
      rateFor('gemini-2.5-flash', plain)!.imageInputPerMTok,
    ).toBeUndefined();
    const double = { AI_PRICE_GEMINI_2_5_FLASH__IMAGE_INPUT: '2' };
    expect(rateFor('gemini-2.5-flash', double)!.imageInputPerMTok).toBe(
      2_000_000,
    );
    expect(
      rateFor('gemini-2.5-flash-image', double)!.inputPerMTok,
    ).toBeUndefined();
  });

  it('исключения в именах — о существующих ставках и в форме с двойным подчёркиванием', () => {
    for (const [ref, key] of Object.entries(PRICE_ENV_KEY_EXCEPTIONS)) {
      const [model, kind] = ref.split('/');
      expect(MODEL_RATES[model]).toBeDefined();
      expect(PRICE_KINDS).toContain(kind);
      expect(key).toMatch(/^AI_PRICE_[A-Z0-9_]+__[A-Z_]+$/);
    }
  });

  // Полный список имён — снимок: переименование модели, вида или правила
  // имени (в том числе исключений) краснеет здесь, а не в отчёте о деньгах.
  // Добавили модель — допишите её строку.
  it('имена переменных прайса — полный список (снимок)', () => {
    const actual = Object.fromEntries(
      Object.keys(MODEL_RATES).map((model) => [
        model,
        PRICE_KINDS.map((kind) => priceEnvKey(model, kind)),
      ]),
    );
    expect(actual).toEqual({
      'gemini-2.5-flash': [
        'AI_PRICE_GEMINI_2_5_FLASH_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_CACHED',
        'AI_PRICE_GEMINI_2_5_FLASH_OUTPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_SECOND',
        'AI_PRICE_GEMINI_2_5_FLASH_CALL',
        'AI_PRICE_GEMINI_2_5_FLASH_CHARS',
        'AI_PRICE_GEMINI_2_5_FLASH_AUDIO_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH__IMAGE_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_VIDEO_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_CACHED_AUDIO',
      ],
      'gemini-2.5-pro': [
        'AI_PRICE_GEMINI_2_5_PRO_INPUT',
        'AI_PRICE_GEMINI_2_5_PRO_CACHED',
        'AI_PRICE_GEMINI_2_5_PRO_OUTPUT',
        'AI_PRICE_GEMINI_2_5_PRO_SECOND',
        'AI_PRICE_GEMINI_2_5_PRO_CALL',
        'AI_PRICE_GEMINI_2_5_PRO_CHARS',
        'AI_PRICE_GEMINI_2_5_PRO_AUDIO_INPUT',
        'AI_PRICE_GEMINI_2_5_PRO_IMAGE_INPUT',
        'AI_PRICE_GEMINI_2_5_PRO_VIDEO_INPUT',
        'AI_PRICE_GEMINI_2_5_PRO_CACHED_AUDIO',
      ],
      'gemini-3.6-flash': [
        'AI_PRICE_GEMINI_3_6_FLASH_INPUT',
        'AI_PRICE_GEMINI_3_6_FLASH_CACHED',
        'AI_PRICE_GEMINI_3_6_FLASH_OUTPUT',
        'AI_PRICE_GEMINI_3_6_FLASH_SECOND',
        'AI_PRICE_GEMINI_3_6_FLASH_CALL',
        'AI_PRICE_GEMINI_3_6_FLASH_CHARS',
        'AI_PRICE_GEMINI_3_6_FLASH_AUDIO_INPUT',
        'AI_PRICE_GEMINI_3_6_FLASH_IMAGE_INPUT',
        'AI_PRICE_GEMINI_3_6_FLASH_VIDEO_INPUT',
        'AI_PRICE_GEMINI_3_6_FLASH_CACHED_AUDIO',
      ],
      'gemini-2.5-flash-lite': [
        'AI_PRICE_GEMINI_2_5_FLASH_LITE_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_LITE_CACHED',
        'AI_PRICE_GEMINI_2_5_FLASH_LITE_OUTPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_LITE_SECOND',
        'AI_PRICE_GEMINI_2_5_FLASH_LITE_CALL',
        'AI_PRICE_GEMINI_2_5_FLASH_LITE_CHARS',
        'AI_PRICE_GEMINI_2_5_FLASH_LITE_AUDIO_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_LITE_IMAGE_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_LITE_VIDEO_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_LITE_CACHED_AUDIO',
      ],
      'gemini-embedding-001': [
        'AI_PRICE_GEMINI_EMBEDDING_001_INPUT',
        'AI_PRICE_GEMINI_EMBEDDING_001_CACHED',
        'AI_PRICE_GEMINI_EMBEDDING_001_OUTPUT',
        'AI_PRICE_GEMINI_EMBEDDING_001_SECOND',
        'AI_PRICE_GEMINI_EMBEDDING_001_CALL',
        'AI_PRICE_GEMINI_EMBEDDING_001_CHARS',
        'AI_PRICE_GEMINI_EMBEDDING_001_AUDIO_INPUT',
        'AI_PRICE_GEMINI_EMBEDDING_001_IMAGE_INPUT',
        'AI_PRICE_GEMINI_EMBEDDING_001_VIDEO_INPUT',
        'AI_PRICE_GEMINI_EMBEDDING_001_CACHED_AUDIO',
      ],
      'gemini-3.1-flash-image': [
        'AI_PRICE_GEMINI_3_1_FLASH_IMAGE_INPUT',
        'AI_PRICE_GEMINI_3_1_FLASH_IMAGE_CACHED',
        'AI_PRICE_GEMINI_3_1_FLASH_IMAGE_OUTPUT',
        'AI_PRICE_GEMINI_3_1_FLASH_IMAGE_SECOND',
        'AI_PRICE_GEMINI_3_1_FLASH_IMAGE_CALL',
        'AI_PRICE_GEMINI_3_1_FLASH_IMAGE_CHARS',
        'AI_PRICE_GEMINI_3_1_FLASH_IMAGE_AUDIO_INPUT',
        'AI_PRICE_GEMINI_3_1_FLASH_IMAGE_IMAGE_INPUT',
        'AI_PRICE_GEMINI_3_1_FLASH_IMAGE_VIDEO_INPUT',
        'AI_PRICE_GEMINI_3_1_FLASH_IMAGE_CACHED_AUDIO',
      ],
      'gemini-2.5-flash-image': [
        'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_CACHED',
        'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_OUTPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_SECOND',
        'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_CALL',
        'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_CHARS',
        'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_AUDIO_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_IMAGE_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_VIDEO_INPUT',
        'AI_PRICE_GEMINI_2_5_FLASH_IMAGE_CACHED_AUDIO',
      ],
      'veo-3.1-generate-preview': [
        'AI_PRICE_VEO_3_1_GENERATE_PREVIEW_INPUT',
        'AI_PRICE_VEO_3_1_GENERATE_PREVIEW_CACHED',
        'AI_PRICE_VEO_3_1_GENERATE_PREVIEW_OUTPUT',
        'AI_PRICE_VEO_3_1_GENERATE_PREVIEW_SECOND',
        'AI_PRICE_VEO_3_1_GENERATE_PREVIEW_CALL',
        'AI_PRICE_VEO_3_1_GENERATE_PREVIEW_CHARS',
        'AI_PRICE_VEO_3_1_GENERATE_PREVIEW_AUDIO_INPUT',
        'AI_PRICE_VEO_3_1_GENERATE_PREVIEW_IMAGE_INPUT',
        'AI_PRICE_VEO_3_1_GENERATE_PREVIEW_VIDEO_INPUT',
        'AI_PRICE_VEO_3_1_GENERATE_PREVIEW_CACHED_AUDIO',
      ],
      'veo-3.1-lite-generate-preview': [
        'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_INPUT',
        'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_CACHED',
        'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_OUTPUT',
        'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_SECOND',
        'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_CALL',
        'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_CHARS',
        'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_AUDIO_INPUT',
        'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_IMAGE_INPUT',
        'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_VIDEO_INPUT',
        'AI_PRICE_VEO_3_1_LITE_GENERATE_PREVIEW_CACHED_AUDIO',
      ],
      'veo-3.0-generate-preview': [
        'AI_PRICE_VEO_3_0_GENERATE_PREVIEW_INPUT',
        'AI_PRICE_VEO_3_0_GENERATE_PREVIEW_CACHED',
        'AI_PRICE_VEO_3_0_GENERATE_PREVIEW_OUTPUT',
        'AI_PRICE_VEO_3_0_GENERATE_PREVIEW_SECOND',
        'AI_PRICE_VEO_3_0_GENERATE_PREVIEW_CALL',
        'AI_PRICE_VEO_3_0_GENERATE_PREVIEW_CHARS',
        'AI_PRICE_VEO_3_0_GENERATE_PREVIEW_AUDIO_INPUT',
        'AI_PRICE_VEO_3_0_GENERATE_PREVIEW_IMAGE_INPUT',
        'AI_PRICE_VEO_3_0_GENERATE_PREVIEW_VIDEO_INPUT',
        'AI_PRICE_VEO_3_0_GENERATE_PREVIEW_CACHED_AUDIO',
      ],
      'grok-imagine-video-1.5:480p': [
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_480P_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_480P_CACHED',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_480P_OUTPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_480P_SECOND',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_480P_CALL',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_480P_CHARS',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_480P_AUDIO_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_480P_IMAGE_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_480P_VIDEO_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_480P_CACHED_AUDIO',
      ],
      'grok-imagine-video-1.5:720p': [
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_720P_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_720P_CACHED',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_720P_OUTPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_720P_SECOND',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_720P_CALL',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_720P_CHARS',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_720P_AUDIO_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_720P_IMAGE_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_720P_VIDEO_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_720P_CACHED_AUDIO',
      ],
      'grok-imagine-video-1.5:1080p': [
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_1080P_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_1080P_CACHED',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_1080P_OUTPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_1080P_SECOND',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_1080P_CALL',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_1080P_CHARS',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_1080P_AUDIO_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_1080P_IMAGE_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_1080P_VIDEO_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_1_5_1080P_CACHED_AUDIO',
      ],
      'grok-imagine-video:480p': [
        'AI_PRICE_GROK_IMAGINE_VIDEO_480P_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_480P_CACHED',
        'AI_PRICE_GROK_IMAGINE_VIDEO_480P_OUTPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_480P_SECOND',
        'AI_PRICE_GROK_IMAGINE_VIDEO_480P_CALL',
        'AI_PRICE_GROK_IMAGINE_VIDEO_480P_CHARS',
        'AI_PRICE_GROK_IMAGINE_VIDEO_480P_AUDIO_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_480P_IMAGE_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_480P_VIDEO_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_480P_CACHED_AUDIO',
      ],
      'grok-imagine-video:720p': [
        'AI_PRICE_GROK_IMAGINE_VIDEO_720P_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_720P_CACHED',
        'AI_PRICE_GROK_IMAGINE_VIDEO_720P_OUTPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_720P_SECOND',
        'AI_PRICE_GROK_IMAGINE_VIDEO_720P_CALL',
        'AI_PRICE_GROK_IMAGINE_VIDEO_720P_CHARS',
        'AI_PRICE_GROK_IMAGINE_VIDEO_720P_AUDIO_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_720P_IMAGE_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_720P_VIDEO_INPUT',
        'AI_PRICE_GROK_IMAGINE_VIDEO_720P_CACHED_AUDIO',
      ],
      'grok-imagine-image': [
        'AI_PRICE_GROK_IMAGINE_IMAGE_INPUT',
        'AI_PRICE_GROK_IMAGINE_IMAGE_CACHED',
        'AI_PRICE_GROK_IMAGINE_IMAGE_OUTPUT',
        'AI_PRICE_GROK_IMAGINE_IMAGE_SECOND',
        'AI_PRICE_GROK_IMAGINE_IMAGE_CALL',
        'AI_PRICE_GROK_IMAGINE_IMAGE_CHARS',
        'AI_PRICE_GROK_IMAGINE_IMAGE_AUDIO_INPUT',
        'AI_PRICE_GROK_IMAGINE_IMAGE_IMAGE_INPUT',
        'AI_PRICE_GROK_IMAGINE_IMAGE_VIDEO_INPUT',
        'AI_PRICE_GROK_IMAGINE_IMAGE_CACHED_AUDIO',
      ],
      'gpt-5': [
        'AI_PRICE_GPT_5_INPUT',
        'AI_PRICE_GPT_5_CACHED',
        'AI_PRICE_GPT_5_OUTPUT',
        'AI_PRICE_GPT_5_SECOND',
        'AI_PRICE_GPT_5_CALL',
        'AI_PRICE_GPT_5_CHARS',
        'AI_PRICE_GPT_5_AUDIO_INPUT',
        'AI_PRICE_GPT_5_IMAGE_INPUT',
        'AI_PRICE_GPT_5_VIDEO_INPUT',
        'AI_PRICE_GPT_5_CACHED_AUDIO',
      ],
      serpapi: [
        'AI_PRICE_SERPAPI_INPUT',
        'AI_PRICE_SERPAPI_CACHED',
        'AI_PRICE_SERPAPI_OUTPUT',
        'AI_PRICE_SERPAPI_SECOND',
        'AI_PRICE_SERPAPI_CALL',
        'AI_PRICE_SERPAPI_CHARS',
        'AI_PRICE_SERPAPI_AUDIO_INPUT',
        'AI_PRICE_SERPAPI_IMAGE_INPUT',
        'AI_PRICE_SERPAPI_VIDEO_INPUT',
        'AI_PRICE_SERPAPI_CACHED_AUDIO',
      ],
      'ffmpeg-api': [
        'AI_PRICE_FFMPEG_API_INPUT',
        'AI_PRICE_FFMPEG_API_CACHED',
        'AI_PRICE_FFMPEG_API_OUTPUT',
        'AI_PRICE_FFMPEG_API_SECOND',
        'AI_PRICE_FFMPEG_API_CALL',
        'AI_PRICE_FFMPEG_API_CHARS',
        'AI_PRICE_FFMPEG_API_AUDIO_INPUT',
        'AI_PRICE_FFMPEG_API_IMAGE_INPUT',
        'AI_PRICE_FFMPEG_API_VIDEO_INPUT',
        'AI_PRICE_FFMPEG_API_CACHED_AUDIO',
      ],
      htdemucs: [
        'AI_PRICE_HTDEMUCS_INPUT',
        'AI_PRICE_HTDEMUCS_CACHED',
        'AI_PRICE_HTDEMUCS_OUTPUT',
        'AI_PRICE_HTDEMUCS_SECOND',
        'AI_PRICE_HTDEMUCS_CALL',
        'AI_PRICE_HTDEMUCS_CHARS',
        'AI_PRICE_HTDEMUCS_AUDIO_INPUT',
        'AI_PRICE_HTDEMUCS_IMAGE_INPUT',
        'AI_PRICE_HTDEMUCS_VIDEO_INPUT',
        'AI_PRICE_HTDEMUCS_CACHED_AUDIO',
      ],
      'elevenlabs-tts': [
        'AI_PRICE_ELEVENLABS_TTS_INPUT',
        'AI_PRICE_ELEVENLABS_TTS_CACHED',
        'AI_PRICE_ELEVENLABS_TTS_OUTPUT',
        'AI_PRICE_ELEVENLABS_TTS_SECOND',
        'AI_PRICE_ELEVENLABS_TTS_CALL',
        'AI_PRICE_ELEVENLABS_TTS_CHARS',
        'AI_PRICE_ELEVENLABS_TTS_AUDIO_INPUT',
        'AI_PRICE_ELEVENLABS_TTS_IMAGE_INPUT',
        'AI_PRICE_ELEVENLABS_TTS_VIDEO_INPUT',
        'AI_PRICE_ELEVENLABS_TTS_CACHED_AUDIO',
      ],
      'resemble-tts': [
        'AI_PRICE_RESEMBLE_TTS_INPUT',
        'AI_PRICE_RESEMBLE_TTS_CACHED',
        'AI_PRICE_RESEMBLE_TTS_OUTPUT',
        'AI_PRICE_RESEMBLE_TTS_SECOND',
        'AI_PRICE_RESEMBLE_TTS_CALL',
        'AI_PRICE_RESEMBLE_TTS_CHARS',
        'AI_PRICE_RESEMBLE_TTS_AUDIO_INPUT',
        'AI_PRICE_RESEMBLE_TTS_IMAGE_INPUT',
        'AI_PRICE_RESEMBLE_TTS_VIDEO_INPUT',
        'AI_PRICE_RESEMBLE_TTS_CACHED_AUDIO',
      ],
      'soniox-stt-async': [
        'AI_PRICE_SONIOX_STT_ASYNC_INPUT',
        'AI_PRICE_SONIOX_STT_ASYNC_CACHED',
        'AI_PRICE_SONIOX_STT_ASYNC_OUTPUT',
        'AI_PRICE_SONIOX_STT_ASYNC_SECOND',
        'AI_PRICE_SONIOX_STT_ASYNC_CALL',
        'AI_PRICE_SONIOX_STT_ASYNC_CHARS',
        'AI_PRICE_SONIOX_STT_ASYNC_AUDIO_INPUT',
        'AI_PRICE_SONIOX_STT_ASYNC_IMAGE_INPUT',
        'AI_PRICE_SONIOX_STT_ASYNC_VIDEO_INPUT',
        'AI_PRICE_SONIOX_STT_ASYNC_CACHED_AUDIO',
      ],
      'soniox-tts': [
        'AI_PRICE_SONIOX_TTS_INPUT',
        'AI_PRICE_SONIOX_TTS_CACHED',
        'AI_PRICE_SONIOX_TTS_OUTPUT',
        'AI_PRICE_SONIOX_TTS_SECOND',
        'AI_PRICE_SONIOX_TTS_CALL',
        'AI_PRICE_SONIOX_TTS_CHARS',
        'AI_PRICE_SONIOX_TTS_AUDIO_INPUT',
        'AI_PRICE_SONIOX_TTS_IMAGE_INPUT',
        'AI_PRICE_SONIOX_TTS_VIDEO_INPUT',
        'AI_PRICE_SONIOX_TTS_CACHED_AUDIO',
      ],
      'hedra-character-3': [
        'AI_PRICE_HEDRA_CHARACTER_3_INPUT',
        'AI_PRICE_HEDRA_CHARACTER_3_CACHED',
        'AI_PRICE_HEDRA_CHARACTER_3_OUTPUT',
        'AI_PRICE_HEDRA_CHARACTER_3_SECOND',
        'AI_PRICE_HEDRA_CHARACTER_3_CALL',
        'AI_PRICE_HEDRA_CHARACTER_3_CHARS',
        'AI_PRICE_HEDRA_CHARACTER_3_AUDIO_INPUT',
        'AI_PRICE_HEDRA_CHARACTER_3_IMAGE_INPUT',
        'AI_PRICE_HEDRA_CHARACTER_3_VIDEO_INPUT',
        'AI_PRICE_HEDRA_CHARACTER_3_CACHED_AUDIO',
      ],
      'resemble-voice-clone': [
        'AI_PRICE_RESEMBLE_VOICE_CLONE_INPUT',
        'AI_PRICE_RESEMBLE_VOICE_CLONE_CACHED',
        'AI_PRICE_RESEMBLE_VOICE_CLONE_OUTPUT',
        'AI_PRICE_RESEMBLE_VOICE_CLONE_SECOND',
        'AI_PRICE_RESEMBLE_VOICE_CLONE_CALL',
        'AI_PRICE_RESEMBLE_VOICE_CLONE_CHARS',
        'AI_PRICE_RESEMBLE_VOICE_CLONE_AUDIO_INPUT',
        'AI_PRICE_RESEMBLE_VOICE_CLONE_IMAGE_INPUT',
        'AI_PRICE_RESEMBLE_VOICE_CLONE_VIDEO_INPUT',
        'AI_PRICE_RESEMBLE_VOICE_CLONE_CACHED_AUDIO',
      ],
      'youtube-data-api': [
        'AI_PRICE_YOUTUBE_DATA_API_INPUT',
        'AI_PRICE_YOUTUBE_DATA_API_CACHED',
        'AI_PRICE_YOUTUBE_DATA_API_OUTPUT',
        'AI_PRICE_YOUTUBE_DATA_API_SECOND',
        'AI_PRICE_YOUTUBE_DATA_API_CALL',
        'AI_PRICE_YOUTUBE_DATA_API_CHARS',
        'AI_PRICE_YOUTUBE_DATA_API_AUDIO_INPUT',
        'AI_PRICE_YOUTUBE_DATA_API_IMAGE_INPUT',
        'AI_PRICE_YOUTUBE_DATA_API_VIDEO_INPUT',
        'AI_PRICE_YOUTUBE_DATA_API_CACHED_AUDIO',
      ],
    });
  });

  it('показ сумм на границе цента', () => {
    expect(formatMicroUsd(10_000)).toBe('$0.01');
    expect(formatMicroUsd(5_000)).toBe('$0.0050');
    expect(formatMicroUsd(1_000_000)).toBe('$1.00');
  });
});
