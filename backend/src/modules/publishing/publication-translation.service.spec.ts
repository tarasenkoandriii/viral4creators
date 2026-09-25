import { GEMINI_MODEL } from '../../common/gemini-model';
import { PublicationTranslationService } from './publication-translation.service';

interface GenerateRequest {
  model: string;
  contents: unknown;
  config: {
    responseMimeType?: string;
    maxOutputTokens?: number;
    abortSignal?: AbortSignal;
  };
}

/**
 * Перевод метаданных ролика — сетевая обвязка (аудит этапа 137).
 *
 * Разбор ответа проверяется своим тестом рядом; здесь — три границы,
 * каждую из которых нашёл аудит и ни одна не видна глазами:
 *
 * 1. Модель берётся из общего места. Зашитая строка `gemini-2.5-flash`
 *    выглядела безобидно, но Google отключил эту модель для новых
 *    ключей (реальная авария продукта 13.09.2026, см. шапку
 *    `common/gemini-model.ts`) — а сервис глотает ошибки, так что
 *    локализации просто никогда бы не появлялись, и никто бы не узнал.
 * 2. У вызова есть таймаут: он идёт внутри тика крона под локом.
 * 3. Отказ провайдера — пустая карта, а не исключение.
 */
function build(over: { text?: string; fail?: boolean; noKey?: boolean } = {}) {
  const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
  const svc = new PublicationTranslationService(aiUsage as never);
  // Параметр объявлен, хотя тело его не читает: без него `mock.calls`
  // типизируется пустым кортежем, и обращение к аргументу — ошибка
  // `tsc`, которую песочница увидит только на прогоне CI.
  const generateContent = jest.fn(async (_request: GenerateRequest) => {
    if (over.fail) throw new Error('gemini down');
    return {
      text: over.text ?? '{"en":{"title":"Steel mug","description":"A mug"}}',
    };
  });
  if (!over.noKey) {
    (svc as unknown as { genai: unknown }).genai = {
      models: { generateContent },
    };
  } else {
    (svc as unknown as { genai: unknown }).genai = null;
  }
  return { svc, aiUsage, generateContent };
}

describe('PublicationTranslationService', () => {
  it('зовёт модель из общего места, а не зашитую строку', async () => {
    const { svc, generateContent } = build();
    await svc.translate({ title: 'Кружка', description: 'Описание' }, 'ru');
    expect(generateContent.mock.calls[0][0]).toMatchObject({
      model: GEMINI_MODEL,
    });
  });

  it('у вызова есть потолок ответа и таймаут — он идёт под локом крона', async () => {
    const { svc, generateContent } = build();
    await svc.translate({ title: 'Кружка', description: '' }, 'ru');
    const config = generateContent.mock.calls[0][0].config;
    expect(config.responseMimeType).toBe('application/json');
    expect(config.maxOutputTokens).toBeGreaterThan(0);
    expect(config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('расход пишется своей операцией, с владельцем заявки', async () => {
    const { svc, aiUsage } = build();
    await svc.translate({ title: 'Кружка', description: '' }, 'ru', {
      sessionId: 's1',
      userId: 'u1',
    });
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'publication-translate',
        model: GEMINI_MODEL,
        sessionId: 's1',
        userId: 'u1',
      }),
    );
  });

  it('переводы возвращаются разобранными', async () => {
    const { svc } = build();
    expect(
      await svc.translate({ title: 'Кружка', description: 'Описание' }, 'ru'),
    ).toEqual({ en: { title: 'Steel mug', description: 'A mug' } });
  });

  it('отказ провайдера — пустая карта, а не исключение', async () => {
    const { svc } = build({ fail: true });
    await expect(
      svc.translate({ title: 'Кружка', description: '' }, 'ru'),
    ).resolves.toEqual({});
  });

  it('без ключа и без заголовка в сеть не ходит вовсе', async () => {
    const withoutKey = build({ noKey: true });
    expect(
      await withoutKey.svc.translate(
        { title: 'Кружка', description: '' },
        'ru',
      ),
    ).toEqual({});
    expect(withoutKey.generateContent).not.toHaveBeenCalled();

    const empty = build();
    expect(
      await empty.svc.translate(
        { title: '   ', description: 'Описание' },
        'ru',
      ),
    ).toEqual({});
    expect(empty.generateContent).not.toHaveBeenCalled();
  });
});
