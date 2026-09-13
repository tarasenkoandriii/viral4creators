import {
  AI_PROVIDERS,
  estimateCost,
  formatMicroUsd,
  MODEL_RATES,
  ModelRate,
  priceEnvKey,
  pricingTable,
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
    // 600k свежих × $0.30/M + 400k кеша × $0.075/M.
    expect(
      estimateCost(
        'gemini-2.5-flash',
        { inputTokens: 1_000_000, cachedInputTokens: 400_000 },
        {},
      ).costMicroUsd,
    ).toBe(210_000);
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
    ).toBe(75_000);
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

  it('мелкие суммы не округляются до нуля при показе', () => {
    expect(formatMicroUsd(0)).toBe('$0');
    expect(formatMicroUsd(4_200)).toBe('$0.0042');
    expect(formatMicroUsd(1_234_567)).toBe('$1.23');
  });
});
