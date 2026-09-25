/**
 * Готовность по сессии — «Тонкая красная линия» §7.3, волна D.
 *
 * Здесь проверяется перевод сессии в аргументы правил: сами правила
 * живут рядом и проверены отдельно. Тонкость одна, и она вся в том,
 * какие поля сессии считать признаком чего.
 */

import { readinessOfSession } from './wizard-readiness.session';

interface GreetingOver {
  brief?: Record<string, unknown>;
  references?: unknown[];
  prompt?: { approvedAt?: string | null; moderationStatus?: string | null };
}

const greeting = (over: GreetingOver = {}) => ({
  greetingBriefSnapshot: {
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    recipientName: 'Марина',
    senderName: 'Андрей',
    presenterProvider: 'grok',
    ...over.brief,
  },
  greetingReferenceImages: over.references ?? [],
  generationPrompt: over.prompt ?? null,
});

const product = (over: Record<string, unknown> = {}) => ({
  videoAnalysis: { status: 'complete' },
  productInformation: {
    productImage: { pathname: 'sessions/x/product.png' },
  },
  generationPrompt: { approvedAt: '2026-09-23T00:00:00Z' },
  brandManifestSnapshot: {},
  ...over,
});

describe('шаблон сцены вместо референса (этап 149)', () => {
  const done = (session: Record<string, unknown>) =>
    readinessOfSession(session).items.find((i) => i.key === 'analysis')?.done;

  it('выбранный шаблон закрывает пункт «откуда сцена»', () => {
    expect(
      done(
        product({
          videoAnalysis: null,
          sceneTemplate: { templateId: 'unboxing', chosenAt: 'now' },
        }),
      ),
    ).toBe(true);
  });

  it('снимок без самого выбора выбором не считается', () => {
    // Пустой объект в JSON сессии — обычный след неудавшейся записи; по
    // нему нельзя решить, что человек приём выбрал.
    expect(done(product({ videoAnalysis: null, sceneTemplate: {} }))).toBe(
      false,
    );
    expect(
      done(product({ videoAnalysis: null, sceneTemplate: { templateId: '' } })),
    ).toBe(false);
    expect(done(product({ videoAnalysis: null, sceneTemplate: null }))).toBe(
      false,
    );
  });

  it('разбор без шаблона закрывает пункт по-прежнему', () => {
    expect(done(product())).toBe(true);
  });
});

describe('готовность по сессии', () => {
  it('сценарий определяется снимком брифа, а не аргументом', () => {
    // Вызывающий уже решил, какой перед ним сценарий, когда создавал
    // сессию; спрашивать его об этом второй раз — способ разойтись.
    expect(readinessOfSession(greeting()).items.map((i) => i.key)).toContain(
      'recipient',
    );
    expect(readinessOfSession(product()).items.map((i) => i.key)).toContain(
      'analysis',
    );
  });

  it('лицо требуется по РАЗРЕШЁННОМУ провайдеру, а не по выбранному', () => {
    // Тариф мог понизиться после сохранения брифа: рендерить будет
    // резолвер, и просить фото там, где аватара всё равно не будет, —
    // просить зря.
    const downgraded = readinessOfSession(
      greeting({
        brief: {
          presenterProvider: 'hedra',
          resolvedPresenterProvider: 'grok',
        },
      }),
    );
    expect(downgraded.items.some((i) => i.key === 'face')).toBe(false);

    const avatar = readinessOfSession(
      greeting({
        brief: {
          presenterProvider: 'hedra',
          resolvedPresenterProvider: 'hedra',
        },
      }),
    );
    expect(avatar.items.find((i) => i.key === 'face')?.done).toBe(false);
  });

  it('помеченный модерацией сценарий не считается готовым', () => {
    const r = readinessOfSession(
      greeting({ prompt: { moderationStatus: 'flagged' } }),
    );
    expect(r.items.find((i) => i.key === 'scriptClean')?.done).toBe(false);
    expect(r.canGenerate).toBe(false);
  });

  it('фото товара читается резолвером, а не наличием поля', () => {
    // При применённом скетче в генерацию уходит скетч; «фото есть»
    // обязано означать то же, что прочитает `GenerationService`.
    const withoutPath = readinessOfSession(
      product({ productInformation: { productImage: {} } }),
    );
    expect(withoutPath.items.find((i) => i.key === 'photo')?.done).toBe(false);
  });

  it('незавершённый разбор не считается разбором', () => {
    const r = readinessOfSession(
      product({ videoAnalysis: { status: 'processing' } }),
    );
    expect(r.items.find((i) => i.key === 'analysis')?.done).toBe(false);
  });

  it('неодобренный промпт не считается одобренным', () => {
    const r = readinessOfSession(product({ generationPrompt: {} }));
    expect(r.items.find((i) => i.key === 'prompt')?.done).toBe(false);
  });
});
