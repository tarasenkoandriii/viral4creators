/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { PromptService } from './prompt.service';
import { ModerationStatus } from '../../common/types/prompt.types';
import { SessionStatus } from '../../common/types/session.types';

const KEY = 'GEMINI_API_KEY';

function build(prompt: Record<string, unknown> | null) {
  const session: Record<string, unknown> = {
    sessionId: 's1',
    generationPrompt: prompt ?? undefined,
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue(prompt === null ? null : session),
    updateSession: jest.fn().mockResolvedValue(undefined),
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new PromptService(
    sessions as any,
    { recordGemini: jest.fn() } as any,
    { assertCanSpendSession: jest.fn() } as any,
  );
  // Найдено при повторном аудите §20: `updatePrompt()` теперь тоже
  // вызывает модель (`extractLiteralTexts()`, чтобы текстовые карточки
  // не расходились с правкой) — без мока здесь ушёл бы настоящий
  // сетевой запрос на фейковый ключ. Мок настроен на отказ намеренно:
  // эти тесты про текст озвучки, не про text-card — `extractLiteralTexts`
  // должен просто вернуть `null` (сбой) и не мешать основной проверке.
  (svc as any).genai = {
    models: {
      generateContent: jest
        .fn()
        .mockRejectedValue(new Error('not mocked in this suite')),
    },
  };
  return { svc, sessions, session };
}

const BASE = {
  promptId: 'p1',
  generatedText: 'text',
  finalText: 'text',
  characterCount: 4,
  generatedAt: new Date(),
  moderationStatus: ModerationStatus.PENDING,
  voiceoverScript: 'Текст, который написал GPT.',
  finalVoiceoverScript: 'Текст, который написал GPT.',
};

describe('PromptService.updatePrompt — текст озвучки (ТЗ §15.2)', () => {
  const original = process.env[KEY];
  beforeAll(() => {
    // Конструктор требует ключ; сетевых вызовов в этих проверках нет.
    process.env[KEY] = 'test-key';
  });
  afterAll(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('не переданный текст озвучки не трогает сохранённый', async () => {
    // Иначе правка промпта молча стирала бы выверенные реплики.
    const { svc } = build({ ...BASE });
    const r = await svc.updatePrompt('s1', 'новый промпт');
    expect(r.finalVoiceoverScript).toBe('Текст, который написал GPT.');
  });

  it('пустая строка — это «стёр реплики», а не «не передал»', async () => {
    // До этапа 37 пустая строка сворачивалась в undefined, и постобработка
    // откатывалась к тексту GPT: пользователь читал «пусто — ролик
    // останется со звуком модели», стирал реплики и получал ролик,
    // озвученный ровно тем, что он удалил, — и платил за этот синтез.
    const { svc } = build({ ...BASE });
    const r = await svc.updatePrompt('s1', 'новый промпт', '');
    expect(r.finalVoiceoverScript).toBe('');
    expect(r.voiceoverScriptEdited).toBe('');
    // Исходный текст модели остаётся — сравнить «до и после» можно.
    expect(r.voiceoverScript).toBe('Текст, который написал GPT.');
  });

  it('строка из пробелов считается стиранием', async () => {
    const { svc } = build({ ...BASE });
    const r = await svc.updatePrompt('s1', 'промпт', '   \n  ');
    expect(r.finalVoiceoverScript).toBe('');
  });

  it('правка сохраняется как есть, без обрезки по краям смысла', async () => {
    const { svc } = build({ ...BASE });
    const r = await svc.updatePrompt('s1', 'промпт', '  Моя реплика.  ');
    expect(r.finalVoiceoverScript).toBe('Моя реплика.');
  });

  it('правка промпта сбрасывает утверждение', async () => {
    const { svc } = build({ ...BASE, approvedAt: new Date() });
    const r = await svc.updatePrompt('s1', 'другой промпт');
    expect(r.approvedAt).toBeUndefined();
  });

  it('пишутся только затронутые ключи, а не вся сессия', async () => {
    // А-2.3: между чтением сессии и записью проходит до 120 секунд
    // (таймаут GPT-5), и весь снимок целиком затирал бы правки, которые
    // пользователь сделал за это время на том же экране.
    const { svc, sessions } = build({ ...BASE });
    await svc.updatePrompt('s1', 'новый промпт');
    const patch = sessions.updateSession.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(Object.keys(patch)).toEqual(['generationPrompt']);
  });

  it('нет сессии — понятный отказ, а не падение', async () => {
    const { svc } = build(null);
    await expect(svc.updatePrompt('s1', 'x')).rejects.toThrow('Session');
  });
});

describe('PromptService.generatePrompt — что уходит в Veo (Б-2.1)', () => {
  const original = process.env[KEY];
  beforeAll(() => {
    process.env[KEY] = 'test-key';
  });
  afterAll(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  /**
   * Сессия, готовая к генерации промпта: разбор завершён, товар описан.
   * `genai` подменяется — сетевых вызовов в этих проверках нет.
   */
  function buildGen(content: string) {
    const session: Record<string, unknown> = {
      sessionId: 's1',
      videoAnalysis: { status: 'complete', sceneBreakdown: 'Сцена 1: товар' },
      productInformation: {
        productName: 'Кроссовки',
        productDescription: 'лёгкие, для бега',
      },
    };
    const sessions = {
      getSession: jest.fn().mockResolvedValue(session),
      updateSession: jest.fn().mockResolvedValue(undefined),
      claimWork: jest.fn().mockResolvedValue(true),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new PromptService(
      sessions as any,
      { recordGemini: jest.fn() } as any,
      { assertCanSpendSession: jest.fn() } as any,
    );
    const post = jest.fn().mockResolvedValue({ text: content });
    (svc as any).genai = { models: { generateContent: post } };
    return { svc, sessions, post };
  }

  it('из ответа-объекта в Veo уходит промпт, а не вся обёртка', async () => {
    // Регресс этапа 35: модель просят ответить объектом с двумя ключами,
    // а в сессию клался сырой ответ — то есть в Veo уезжал JSON целиком,
    // и пользователь редактировал его руками на экране «Промпт».
    const { svc } = buildGen(
      JSON.stringify({
        prompt: '8 seconds; UGC smartphone realism. Dialogue: «Беги легче».',
        voiceoverScript: 'Беги легче.',
      }),
    );
    const r = await svc.generatePrompt('s1');
    expect(r.finalText.startsWith('{')).toBe(false);
    expect(r.finalText).toBe(
      '8 seconds; UGC smartphone realism. Dialogue: «Беги легче».',
    );
    expect(r.generatedText).toBe(r.finalText);
    expect(r.characterCount).toBe(r.finalText.length);
    // Реплики достаются оттуда же и в Veo вторым экземпляром не уезжают.
    expect(r.finalVoiceoverScript).toBe('Беги легче.');
  });

  it('объект в ```json-заборе разбирается так же', async () => {
    const { svc } = buildGen(
      '```json\n{"prompt":"8 seconds; product close-up.","voiceoverScript":"Держи ритм."}\n```',
    );
    const r = await svc.generatePrompt('s1');
    expect(r.finalText).toBe('8 seconds; product close-up.');
  });

  it('ответ не объектом остаётся сырым текстом — старый путь не сломан', async () => {
    // До этапа 35 модель отвечала простым текстом, и такие ответы
    // случаются до сих пор: подменять их разбором было бы хуже.
    const { svc } = buildGen('8 seconds; plain text answer. Dialogue: «Раз».');
    const r = await svc.generatePrompt('s1');
    expect(r.finalText).toBe('8 seconds; plain text answer. Dialogue: «Раз».');
  });
});

describe('PromptService.generatePrompt — движение камеры (ТЗ §29)', () => {
  const original = process.env[KEY];
  beforeAll(() => {
    process.env[KEY] = 'test-key';
  });
  afterAll(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  /** Та же готовая к генерации сессия, но с манифестом и форматом кадра. */
  function buildCam(snapshot: Record<string, unknown>, frame?: string) {
    const session: Record<string, unknown> = {
      sessionId: 's1',
      videoAnalysis: { status: 'complete', sceneBreakdown: 'Сцена 1: товар' },
      productInformation: {
        productName: 'Кроссовки',
        productDescription: 'лёгкие, для бега',
      },
      brandManifestSnapshot: snapshot,
      ...(frame ? { originalVideo: { frame: { aspectRatio: frame } } } : {}),
    };
    const svc = new PromptService(
      {
        getSession: jest.fn().mockResolvedValue(session),
        updateSession: jest.fn().mockResolvedValue(undefined),
        claimWork: jest.fn().mockResolvedValue(true),
        releaseWork: jest.fn().mockResolvedValue(undefined),
      } as any,
      { recordGemini: jest.fn() } as any,
      { assertCanSpendSession: jest.fn() } as any,
    );
    const post = jest.fn().mockResolvedValue({ text: 'готовый промпт' });
    (svc as any).genai = { models: { generateContent: post } };
    return { svc, post };
  }

  /** Текст брифа, ушедший в GPT-5. */
  function sentBrief(post: jest.Mock): string {
    const body = post.mock.calls[0][0] as {
      contents: { text: string }[];
    };
    return body.contents.map((c) => c.text).join('\n');
  }

  it('заказанный наезд доезжает до модели', async () => {
    const { svc, post } = buildCam({ cameraMove: 'push-in' }, '9:16');
    await svc.generatePrompt('s1');
    expect(sentBrief(post)).toContain('CAMERA MOVEMENT');
  });

  it('в неродном формате просим движение меньше', async () => {
    // §16.1: кадр снимается с запасом под центральную обрезку, и наезд
    // сужает безопасную зону второй раз — товар упрётся в границу.
    const { svc, post } = buildCam({ cameraMove: 'push-in' }, '1:1');
    await svc.generatePrompt('s1');
    const brief = sentBrief(post);
    expect(brief).toContain('SMALL');
    expect(brief).toContain('1:1');
  });

  it('без выбора движения в промпте о камере ни слова', async () => {
    // Пустая секция — не безобидна: она занимает место в брифе и
    // подталкивает модель придумать движение самой.
    const { svc, post } = buildCam({ cameraMove: 'none' }, '9:16');
    await svc.generatePrompt('s1');
    expect(sentBrief(post)).not.toContain('CAMERA MOVEMENT');
  });

  it('сессия без манифеста (до этапа 46) генерируется по-старому', async () => {
    const { svc, post } = buildCam({}, '16:9');
    await svc.generatePrompt('s1');
    expect(sentBrief(post)).not.toContain('CAMERA MOVEMENT');
  });
});

describe('PromptService.generatePrompt — замок и запись расхода (этап 47)', () => {
  const original = process.env[KEY];
  beforeAll(() => {
    process.env[KEY] = 'test-key';
  });
  afterAll(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  function buildLocked(claimed: boolean) {
    const session = {
      sessionId: 's1',
      videoAnalysis: { status: 'complete', sceneBreakdown: 'Сцена 1: товар' },
      productInformation: {
        productName: 'Кроссовки',
        productDescription: 'лёгкие, для бега',
      },
    };
    const sessions = {
      getSession: jest.fn().mockResolvedValue(session),
      updateSession: jest.fn().mockResolvedValue(undefined),
      claimWork: jest.fn().mockResolvedValue(claimed),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
    const svc = new PromptService(
      sessions as any,
      aiUsage as any,
      { assertCanSpendSession: jest.fn() } as any,
    );
    const post = jest.fn().mockResolvedValue({ text: 'промпт' });
    (svc as any).genai = { models: { generateContent: post } };
    return { svc, sessions, post, aiUsage };
  }

  it('занятый замок — 409 без вызова GPT-5', async () => {
    // Повтор после клиентского таймаута в 120 с оплачивал сборку
    // промпта второй раз; замка не было вовсе.
    const { svc, sessions, post } = buildLocked(false);
    await expect(svc.generatePrompt('s1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(sessions.claimWork).toHaveBeenCalledWith(
      's1',
      'prompt',
      expect.any(Number),
    );
    expect(post).not.toHaveBeenCalled();
    expect(sessions.releaseWork).not.toHaveBeenCalled();
  });

  it('замок снимается и после успеха, и после отказа модели', async () => {
    const ok = buildLocked(true);
    await ok.svc.generatePrompt('s1');
    expect(ok.sessions.releaseWork).toHaveBeenCalledWith('s1', 'prompt');

    const bad = buildLocked(true);
    bad.post.mockRejectedValue(new Error('модель недоступна'));
    await expect(bad.svc.generatePrompt('s1')).rejects.toThrow();
    expect(bad.sessions.releaseWork).toHaveBeenCalledWith('s1', 'prompt');
  });

  // Доп. запрос владельца продукта: найдено по реальному сбою в проде
  // (2026-09-13) — `@google/genai` кидает `ApiError`, чьё `.message`
  // целиком является JSON-строкой вида `{"error":{"code":429,...}}`, не
  // структурированным AxiosError, который этот путь разбирал раньше.
  // Тест воспроизводит буквально тот формат, что был в реальном логе.
  it('реальный формат ошибки Gemini (429, квота исчерпана) — понятное сообщение, не падение на разборе', async () => {
    const { svc, post } = buildLocked(true);
    post.mockRejectedValue(
      new Error(
        '{"error":{"code":429,"message":"Your prepayment credits are depleted.","status":"RESOURCE_EXHAUSTED"}}',
      ),
    );
    await expect(svc.generatePrompt('s1')).rejects.toThrow(
      /ограничил частоту запросов/,
    );
  });

  // Найдено при аудите: `extractLiteralTexts()` изначально записывала
  // расход под операцией 'prompt', слитно с основной сборкой — та же
  // причина, что уже развела 'grok-reference-rewrite' отдельной
  // строкой (§15.3 ТЗ), не была применена сюда с первого раза.
  it('извлечение текстовых моментов пишется отдельной операцией "text-extraction", не слитно с "prompt"', async () => {
    const { svc, aiUsage } = buildLocked(true);
    await svc.generatePrompt('s1');
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'prompt', sessionId: 's1' }),
    );
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'text-extraction',
        sessionId: 's1',
      }),
    );
  });

  it('расход записан до того, как метод вернул ответ (В-2.1)', async () => {
    const { svc, aiUsage } = buildLocked(true);
    let recorded = false;
    aiUsage.recordGemini.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            recorded = true;
            resolve();
          }, 20),
        ),
    );
    await svc.generatePrompt('s1');
    expect(recorded).toBe(true);
  });
});

describe('PromptService.generateAbVariants — набор вариантов одним вызовом (этап 66)', () => {
  const original = process.env[KEY];
  beforeAll(() => {
    process.env[KEY] = 'test-key';
  });
  afterAll(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  /** Сессия с уже одобренным промптом — источник стиля для вариантов. */
  function buildAb(
    content: string,
    overrides: Record<string, unknown> = {},
    claimed = true,
  ) {
    const session: Record<string, unknown> = {
      sessionId: 's1',
      videoAnalysis: { status: 'complete', sceneBreakdown: 'Сцена 1: товар' },
      productInformation: {
        productName: 'Кроссовки',
        productDescription: 'лёгкие, для бега',
      },
      generationPrompt: {
        finalText: '8 seconds; UGC. Dialogue: «Беги легче».',
        finalVoiceoverScript: 'Беги легче.',
      },
      ...overrides,
    };
    const sessions = {
      getSession: jest.fn().mockResolvedValue(session),
      updateSession: jest.fn().mockResolvedValue(undefined),
      claimWork: jest.fn().mockResolvedValue(claimed),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
    const svc = new PromptService(
      sessions as any,
      aiUsage as any,
      { assertCanSpendSession: jest.fn() } as any,
    );
    const post = jest.fn().mockResolvedValue({ text: content });
    (svc as any).genai = { models: { generateContent: post } };
    return { svc, sessions, post, aiUsage };
  }

  const THREE_VARIANTS = JSON.stringify({
    variants: [
      {
        hookLabel: 'Хук: вопрос',
        ctaLabel: 'CTA: скидка 20%',
        prompt: 'вариант 1',
        voiceoverScript: 'озвучка 1',
      },
      {
        hookLabel: 'Хук: заявление',
        ctaLabel: 'CTA: срочность',
        prompt: 'вариант 2',
        voiceoverScript: 'озвучка 2',
      },
      {
        hookLabel: 'Хук: проблема',
        ctaLabel: 'CTA: соц. доказательство',
        prompt: 'вариант 3',
        voiceoverScript: 'озвучка 3',
      },
    ],
  });

  it('у сессии нет одобренного промпта — 400, без обращения к GPT-5', async () => {
    // Специфично для A/B-вариантов (не проверяется в generatePrompt):
    // варьировать нечего, если стиля-источника ещё нет.
    const { svc, post } = buildAb(THREE_VARIANTS, {
      generationPrompt: undefined,
    });
    await expect(svc.generateAbVariants('s1', 3)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('разбор ещё не завершён — 400', async () => {
    const { svc } = buildAb(THREE_VARIANTS, {
      videoAnalysis: { status: 'pending' },
    });
    await expect(svc.generateAbVariants('s1', 3)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('занятый замок — 409 без вызова GPT-5, отдельный вид работы от обычного промпта', async () => {
    // 'ab-variants', не 'prompt' — сборка вариантов не должна мешать
    // редактированию текущего промпта той же сессии, и наоборот.
    const { svc, sessions, post } = buildAb(THREE_VARIANTS, {}, false);
    await expect(svc.generateAbVariants('s1', 3)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(sessions.claimWork).toHaveBeenCalledWith(
      's1',
      'ab-variants',
      expect.any(Number),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('успешный разбор — три варианта с хуком/CTA/текстом/озвучкой, каждый', async () => {
    const { svc } = buildAb(THREE_VARIANTS);
    const drafts = await svc.generateAbVariants('s1', 3);
    expect(drafts).toHaveLength(3);
    expect(drafts[0]).toEqual({
      hookLabel: 'Хук: вопрос',
      ctaLabel: 'CTA: скидка 20%',
      prompt: 'вариант 1',
      voiceoverScript: 'озвучка 1',
    });
  });

  it('обёртка ```json разбирается так же, как у обычной сборки промпта', async () => {
    const { svc } = buildAb('```json\n' + THREE_VARIANTS + '\n```');
    const drafts = await svc.generateAbVariants('s1', 3);
    expect(drafts).toHaveLength(3);
  });

  it('расход записан отдельной операцией — видна отдельной строкой в отчёте §26', async () => {
    const { svc, aiUsage } = buildAb(THREE_VARIANTS);
    await svc.generateAbVariants('s1', 3);
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'ab-variants', sessionId: 's1' }),
    );
  });

  it('модель вернула меньше вариантов, чем запрошено — отдаёт то, что получила, не падает', async () => {
    const twoVariants = JSON.stringify({
      variants: JSON.parse(THREE_VARIANTS).variants.slice(0, 2),
    });
    const { svc } = buildAb(twoVariants);
    const drafts = await svc.generateAbVariants('s1', 3);
    expect(drafts).toHaveLength(2);
  });

  it('замок снимается и после успеха, и после отказа модели', async () => {
    const ok = buildAb(THREE_VARIANTS);
    await ok.svc.generateAbVariants('s1', 3);
    expect(ok.sessions.releaseWork).toHaveBeenCalledWith('s1', 'ab-variants');

    const bad = buildAb(THREE_VARIANTS);
    bad.post.mockRejectedValue(new Error('модель недоступна'));
    await expect(bad.svc.generateAbVariants('s1', 3)).rejects.toThrow();
    expect(bad.sessions.releaseWork).toHaveBeenCalledWith('s1', 'ab-variants');
  });
});

describe('PromptService.seedPrompt — посев уже готового текста, без GPT-5 (этап 66)', () => {
  const original = process.env[KEY];
  beforeAll(() => {
    process.env[KEY] = 'test-key';
  });
  afterAll(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  function buildSeed(session: Record<string, unknown> | null) {
    const sessions = {
      getSession: jest.fn().mockResolvedValue(session),
      updateSession: jest.fn().mockResolvedValue(undefined),
      claimWork: jest.fn().mockResolvedValue(true),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const post = jest.fn();
    const svc = new PromptService(
      sessions as any,
      { recordGemini: jest.fn() } as any,
      { assertCanSpendSession: jest.fn() } as any,
    );
    (svc as any).genai = { models: { generateContent: post } };
    return { svc, sessions, post };
  }

  it('свежесозданная дочерняя сессия без generationPrompt вовсе — работает, в отличие от updatePrompt', async () => {
    // Ради этого seedPrompt и понадобился: у дочерней сессии,
    // которую только что завела AbTestWorkerService, ещё нет
    // generationPrompt — updatePrompt на такой сессии кидает 400.
    const { svc, sessions } = buildSeed({ sessionId: 'sess-new' });
    const prompt = await svc.seedPrompt('sess-new', 'готовый текст варианта');
    expect(prompt.finalText).toBe('готовый текст варианта');
    expect(prompt.generatedText).toBe('готовый текст варианта');
    expect(sessions.updateSession).toHaveBeenCalledWith('sess-new', {
      generationPrompt: expect.objectContaining({
        finalText: 'готовый текст варианта',
      }),
      status: SessionStatus.PROMPT_GENERATED,
    });
  });

  it('без обращения к GPT-5 — весь смысл метода', async () => {
    const { svc, post } = buildSeed({ sessionId: 'sess-new' });
    await svc.seedPrompt('sess-new', 'текст', 'озвучка');
    expect(post).not.toHaveBeenCalled();
  });

  it('переданная озвучка становится finalVoiceoverScript с источником field', async () => {
    const { svc } = buildSeed({ sessionId: 'sess-new' });
    const prompt = await svc.seedPrompt('sess-new', 'текст', ' озвучка ');
    expect(prompt.finalVoiceoverScript).toBe('озвучка');
    expect(prompt.voiceoverScriptSource).toBe('field');
  });

  it('без озвучки — источник none, поле не заполнено', async () => {
    const { svc } = buildSeed({ sessionId: 'sess-new' });
    const prompt = await svc.seedPrompt('sess-new', 'текст');
    expect(prompt.finalVoiceoverScript).toBeUndefined();
    expect(prompt.voiceoverScriptSource).toBe('none');
  });

  it('сессия не найдена — понятный отказ', async () => {
    const { svc } = buildSeed(null);
    await expect(svc.seedPrompt('missing', 'текст')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('PromptService.moderateText — гейт, на который опирается отказ рендерить', () => {
  const original = process.env[KEY];
  beforeEach(() => {
    process.env[KEY] = 'test-key';
  });
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  const svc = () =>
    new PromptService(
      { getSession: jest.fn() } as any,
      { recordGemini: jest.fn() } as any,
      { assertCanSpendSession: jest.fn() } as any,
    );

  it('чистый текст проходит', () => {
    const r = svc().moderateText('Марина, с днём рождения!');
    expect(r.status).toBe(ModerationStatus.PENDING);
    expect(r.flags).toEqual([]);
  });

  it('русскоязычная угроза ловится — раньше список был только английский', () => {
    const r = svc().moderateText('Я убью тебя');
    expect(r.status).toBe(ModerationStatus.FLAGGED);
    expect(r.flags).toContain('threat');
  });

  it('соболезнование НЕ блокируется', () => {
    // У продукта есть повод СОБОЛЕЗНОВАНИЕ, и FLAGGED означает отказ
    // рендерить (`GreetingVideoService.startVideo`). Заблокировать его
    // значило бы отказать человеку в самый неподходящий момент.
    const r = svc().moderateText(
      'Примите мои соболезнования в связи со смертью вашего отца.',
    );
    expect(r.status).toBe(ModerationStatus.PENDING);
  });
});
