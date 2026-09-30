/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
/**
 * Лица в референсах поздравления (этап G ТЗ Greeting 2.0 §4.8, Г-8):
 * проверка лица при загрузке, согласие `PATCH { faceConsent: true }`,
 * поведение при недоступной проверке.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));

import {
  FACE_CONSENT_NOT_NEEDED,
  GreetingReferenceService,
} from './greeting-reference.service';

const OLD_FLAG = process.env.PERSONA_ENABLED;
beforeEach(() => {
  process.env.PERSONA_ENABLED = 'true';
});
afterAll(() => {
  process.env.PERSONA_ENABLED = OLD_FLAG;
});

const PATH = 'sessions/s1/greeting-refs/gr_abc/photo.jpg';

function setup(
  opts: {
    images?: unknown[];
    modelText?: string | null;
    noClient?: boolean;
    downloadFails?: boolean;
  } = {},
) {
  const session = {
    sessionId: 's1',
    userId: 'u1',
    greetingBriefSnapshot: { occasion: 'BIRTHDAY' },
    greetingReferenceImages: opts.images ?? [],
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue(session),
    updateSession: jest.fn().mockResolvedValue(undefined),
  };
  const blob = {
    downloadBuffer: opts.downloadFails
      ? jest.fn().mockRejectedValue(new Error('404'))
      : jest.fn().mockResolvedValue(Buffer.from('jpeg')),
    uploadBuffer: jest
      .fn()
      .mockImplementation(async (p: string) => ({ url: `https://blob/${p}` })),
    deleteBlob: jest.fn().mockResolvedValue(true),
  };
  const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
  const generateContent = jest.fn().mockResolvedValue({
    text: opts.modelText === undefined ? '{"faces": 1}' : opts.modelText,
  });
  const service = new GreetingReferenceService(
    sessions as any,
    blob as any,
    {} as any,
    aiUsage as any,
  );
  if (opts.noClient) {
    // Геттер `genai` создаёт клиент лениво и бросает без ключа — так же
    // ведёт себя стенд без GEMINI_API_KEY.
    Object.defineProperty(service, 'genai', {
      get: () => {
        throw new Error('GEMINI_API_KEY is not set');
      },
    });
  } else {
    (service as any).geminiClient = { models: { generateContent } };
  }
  return { service, sessions, blob, aiUsage, generateContent };
}

const saved = (sessions: { updateSession: jest.Mock }) =>
  sessions.updateSession.mock.calls[0][1].greetingReferenceImages;

describe('confirm — проверка лица при загрузке (Г-8)', () => {
  it('лицо найдено → hasFace, нужен ответ согласия; расход записан отдельной операцией', async () => {
    const { service, sessions, aiUsage, generateContent } = setup();
    const list = await service.confirm('s1', { pathname: PATH, label: 'Мама' });
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(saved(sessions)[0]).toMatchObject({ id: 'gr_abc', hasFace: true });
    expect(list[0]).toMatchObject({
      hasFace: true,
      needsFaceConsent: true,
      faceConsentAt: null,
    });
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'reference-face-check',
        sessionId: 's1',
        userId: 'u1',
      }),
    );
  });

  it('лица нет → hasFace: false, согласие не нужно', async () => {
    const { service, sessions } = setup({ modelText: '{"faces": 0}' });
    const list = await service.confirm('s1', { pathname: PATH, label: 'Дача' });
    expect(saved(sessions)[0].hasFace).toBe(false);
    expect(list[0].needsFaceConsent).toBe(false);
  });

  it.each([
    ['нет ключа Gemini', { noClient: true }],
    ['модель ответила мусором', { modelText: 'not json' }],
  ])(
    'проверка недоступна (%s) — fail-closed: «лицо может быть», нужно согласие (CONTRACT5 п.4)',
    async (_n, opts) => {
      const { service, sessions } = setup(opts as never);
      const list = await service.confirm('s1', {
        pathname: PATH,
        label: 'Мама',
      });
      expect(saved(sessions)[0]).toMatchObject({ faceCheckFailed: true });
      expect('hasFace' in saved(sessions)[0]).toBe(false);
      expect(list[0]).toMatchObject({
        hasFace: null,
        needsFaceConsent: true,
        faceCheckUnavailable: true,
      });
    },
  );

  it('файла нет в хранилище — 400, ничего не пишется', async () => {
    const { service, sessions } = setup({ downloadFails: true });
    await expect(
      service.confirm('s1', { pathname: PATH, label: 'Мама' }),
    ).rejects.toThrow(/not found in storage/);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('файл сессии — серверная копия под случайным путём; клиентский удалён (CONTRACT5 п.2)', async () => {
    const { service, sessions, blob } = setup();
    await service.confirm('s1', { pathname: PATH, label: 'Мама' });
    const img = saved(sessions)[0];
    expect(img.photoPathname).toMatch(
      /^sessions\/s1\/greeting-refs\/gr_abc\/[a-f0-9]{24}\.jpg$/,
    );
    expect(img.photoPathname).not.toBe(PATH);
    expect(img.photoUrl).toBe(`https://blob/${img.photoPathname}`);
    expect(blob.uploadBuffer).toHaveBeenCalledWith(
      img.photoPathname,
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(blob.deleteBlob).toHaveBeenCalledWith(PATH);
  });

  it('режим выключен — проверки лица нет, копия на сервер всё равно (CONTRACT5 п.6)', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { service, sessions, generateContent, blob } = setup();
    const list = await service.confirm('s1', { pathname: PATH, label: 'Мама' });
    expect(generateContent).not.toHaveBeenCalled();
    expect('hasFace' in saved(sessions)[0]).toBe(false);
    expect(list[0].needsFaceConsent).toBe(false);
    expect(blob.uploadBuffer).toHaveBeenCalled();
  });
});

describe('update — согласие изображённого (Г-8)', () => {
  const withFace = {
    id: 'r1',
    label: 'Мама',
    description: null,
    photoUrl: 'https://blob/r1.jpg',
    photoPathname: 'sessions/s1/greeting-refs/r1/photo.jpg',
    createdAt: '2026-09-30T00:00:00.000Z',
    hasFace: true,
  };

  it('faceConsent: true ставит отметку времени и снимает запрет', async () => {
    const { service, sessions } = setup({ images: [withFace] });
    const list = await service.update('s1', 'r1', { faceConsent: true });
    expect(saved(sessions)[0].faceConsentAt).toEqual(expect.any(String));
    expect(list[0]).toMatchObject({ needsFaceConsent: false });
  });

  it('повторное подтверждение не переписывает первую отметку', async () => {
    const first = '2026-09-01T00:00:00.000Z';
    const { service, sessions } = setup({
      images: [{ ...withFace, faceConsentAt: first }],
    });
    await service.update('s1', 'r1', { faceConsent: true });
    expect(saved(sessions)[0].faceConsentAt).toBe(first);
  });

  it('непроверенное фото (старое или проверка не ответила) — подтвердить можно', async () => {
    const { service, sessions } = setup({
      images: [{ ...withFace, hasFace: undefined }],
    });
    const list = await service.update('s1', 'r1', { faceConsent: true });
    expect(saved(sessions)[0].faceConsentAt).toEqual(expect.any(String));
    expect(list[0].needsFaceConsent).toBe(false);
  });

  it('для фото без найденного лица — 400, запись не меняется', async () => {
    const { service, sessions } = setup({
      images: [{ ...withFace, hasFace: false }],
    });
    await expect(
      service.update('s1', 'r1', { faceConsent: true }),
    ).rejects.toThrow(FACE_CONSENT_NOT_NEEDED);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('правка подписи без faceConsent согласия не ставит', async () => {
    const { service, sessions } = setup({ images: [withFace] });
    await service.update('s1', 'r1', { label: 'Мамочка' });
    expect(saved(sessions)[0]).toMatchObject({ label: 'Мамочка' });
    expect(saved(sessions)[0].faceConsentAt).toBeUndefined();
  });
});
