import {
  loadConfiguration,
  validateConfiguration,
} from '../../config/configuration';
import { devFakeGeminiEnabled } from '../../config/dev-ai-env';
import { devFakeEmbedding, siteGeminiClient } from './dev-fake-gemini';

describe('dev-заглушка Gemini (интеграционный прогон Э2)', () => {
  const FLAG = { SITES_DEV_FAKE_GEMINI: 'true' };

  it('production + флаг: старт падает (validateConfiguration), фабрика бросает', () => {
    const env = { ...FLAG, NODE_ENV: 'production', SITES_DATABASE_URL: 'x' };
    expect(() => validateConfiguration(loadConfiguration(env))).toThrow(
      /SITES_DEV_FAKE_GEMINI/,
    );
    expect(() => siteGeminiClient(env)).toThrow(/production/);
    expect(devFakeGeminiEnabled(env)).toBe(false);
    expect(devFakeGeminiEnabled({ ...FLAG, NODE_ENV: 'test' })).toBe(true);
    // Даже с ключом — не заглушка и не тихий настоящий клиент.
    expect(() => siteGeminiClient({ ...env, GEMINI_API_KEY: 'k' })).toThrow(
      /production/,
    );
  });

  it('без флага — настоящий клиент (без ключа — понятный отказ)', () => {
    expect(() => siteGeminiClient({ NODE_ENV: 'development' })).toThrow(
      /GEMINI_API_KEY/,
    );
    expect(() =>
      validateConfiguration(loadConfiguration({ NODE_ENV: 'development' })),
    ).not.toThrow();
  });

  it('вне production + флаг: эмбеддинги, короткий вызов и стрим с цитатой — без сети', async () => {
    const c = siteGeminiClient({
      ...FLAG,
      NODE_ENV: 'development',
      SITES_DEV_FAKE_GEMINI_DELAY_MS: '0',
    });
    const e = await c.models.embedContent({
      model: 'm',
      contents: ['доставка по Киеву', 'возврат товара'],
      config: { outputDimensionality: 768 },
    });
    expect(e.embeddings).toHaveLength(2);
    expect(e.embeddings![0].values).toHaveLength(768);
    const t = await c.models.generateContent({
      model: 'm',
      contents: [{ role: 'user', parts: [{ text: '<q>\nСколько?\n</q>' }] }],
    });
    expect(t.text).toBe('Сколько?');
    const stream = await c.models.generateContentStream({
      model: 'm',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: '<source id="S2" url="https://x" title="Доставка">\nДоставка 100 грн. Быстро.\n</source>\n<question>\nСколько?\n</question>',
            },
          ],
        },
      ],
    });
    let out = '';
    for await (const ch of stream) out += ch.text ?? '';
    expect(out).toBe(
      'Доставка 100 грн. [S2]<<<actions>>>{"items":[{"kind":"lead","label":"Оставить заявку"}]}',
    );
  });

  it('эмбеддинг: одинаковые слова — близкие векторы, вектор не нулевой', () => {
    const cos = (a: number[], b: number[]) => {
      let d = 0,
        na = 0,
        nb = 0;
      a.forEach((x, i) => {
        d += x * b[i];
        na += x * x;
        nb += b[i] * b[i];
      });
      return d / Math.sqrt(na * nb);
    };
    const a = devFakeEmbedding('Сколько стоит доставка по Киеву');
    const b = devFakeEmbedding('Доставка по Киеву стоит 100 грн');
    const c = devFakeEmbedding('Гарантия на ноутбуки два года');
    expect(cos(a, b)).toBeGreaterThan(cos(a, c));
    expect(devFakeEmbedding('').some((x) => x !== 0)).toBe(true);
  });
});
