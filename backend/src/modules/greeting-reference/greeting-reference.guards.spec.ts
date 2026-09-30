/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
/**
 * Референсы поздравления — волна CONTRACT6 (G-B2): потолок расхода на
 * платных вызовах (п.1), ограничитель частоты на их маршрутах, запрет
 * правки во время рендера (п.2) и коды с русскими текстами отказов (п.9).
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));

import { HttpException } from '@nestjs/common';
import {
  GreetingReferenceService,
  MAX_GREETING_REFERENCE_IMAGES,
} from './greeting-reference.service';
import { GreetingReferenceController } from './greeting-reference.controller';
import { RATE_LIMIT_KEY, RateLimitRule } from '../../common/rate-limit';
import { GREETING_CHANGE_DURING_RENDER_MESSAGE } from '../../common/greeting-render-lock';

const OLD_FLAG = process.env.PERSONA_ENABLED;
afterEach(() => {
  process.env.PERSONA_ENABLED = OLD_FLAG;
});

const PATH = 'sessions/s1/greeting-refs/gr_abc/photo.jpg';

function setup(
  opts: {
    images?: unknown[];
    video?: unknown;
    brief?: unknown;
    budgetFails?: boolean;
    downloadFails?: boolean;
  } = {},
) {
  const session = {
    sessionId: 's1',
    userId: 'u1',
    greetingBriefSnapshot:
      opts.brief === undefined
        ? {
            occasion: 'BIRTHDAY',
            customOccasionText: null,
            tone: 'WARM',
            resolvedPresenterProvider: 'grok',
          }
        : opts.brief,
    greetingReferenceImages: opts.images ?? [],
    generatedVideo: opts.video ?? null,
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue(session),
    updateSession: jest.fn().mockResolvedValue(undefined),
  };
  const blob = {
    downloadBuffer: opts.downloadFails
      ? jest.fn().mockRejectedValue(new Error('404 sessions/s1/secret-path'))
      : jest.fn().mockResolvedValue(Buffer.from('jpeg')),
    uploadBuffer: jest
      .fn()
      .mockImplementation(async (p: string) => ({ url: `https://blob/${p}` })),
    deleteBlob: jest.fn().mockResolvedValue(true),
  };
  const frames = {
    generate: jest.fn().mockResolvedValue({
      status: 'ok',
      bytes: Buffer.from('png'),
      mimeType: 'image/png',
      model: 'm',
      raw: {},
    }),
  };
  const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
  const plans = {
    assertCanSpendSession: opts.budgetFails
      ? jest.fn().mockRejectedValue(new HttpException('Лимит исчерпан', 429))
      : jest.fn().mockResolvedValue(undefined),
  };
  const generateContent = jest.fn().mockResolvedValue({ text: '{"faces": 0}' });
  const service = new GreetingReferenceService(
    sessions as any,
    blob as any,
    frames as any,
    aiUsage as any,
    plans as any,
  );
  (service as any).geminiClient = { models: { generateContent } };
  return { service, sessions, blob, frames, plans, generateContent };
}

/** Тело исключения: код и текст, как их увидит клиент. */
async function bodyOf(p: Promise<unknown>): Promise<{
  status: number;
  code?: string;
  message: string;
}> {
  try {
    await p;
  } catch (e) {
    const ex = e as HttpException;
    const r = ex.getResponse() as { code?: string; message?: string } | string;
    return typeof r === 'string'
      ? { status: ex.getStatus(), message: r }
      : { status: ex.getStatus(), code: r.code, message: r.message ?? '' };
  }
  throw new Error('ожидался отказ');
}

const img = (id: string) => ({
  id,
  label: 'Мама',
  description: null,
  photoUrl: `https://blob/${id}.jpg`,
  photoPathname: `sessions/s1/greeting-refs/${id}/photo.jpg`,
  createdAt: '2026-09-30T00:00:00.000Z',
  hasFace: false,
});

describe('потолок расхода (CONTRACT6 п.1)', () => {
  it('generateFrame: бюджет исчерпан — модель не зовётся, ничего не пишется', async () => {
    const { service, frames, sessions, plans } = setup({ budgetFails: true });
    await expect(service.generateFrame('s1', 'u1')).rejects.toThrow(
      'Лимит исчерпан',
    );
    expect(plans.assertCanSpendSession).toHaveBeenCalledWith('s1');
    expect(frames.generate).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('suggestSettings: отказ по бюджету доходит до человека, а не пустым списком', async () => {
    const { service, generateContent } = setup({ budgetFails: true });
    await expect(service.suggestSettings('s1', 'u1')).rejects.toThrow(
      'Лимит исчерпан',
    );
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('confirm при включённом режиме: бюджет до платной проверки лица', async () => {
    process.env.PERSONA_ENABLED = 'true';
    const { service, generateContent, sessions } = setup({
      budgetFails: true,
    });
    await expect(
      service.confirm('s1', { pathname: PATH, label: 'Мама' }),
    ).rejects.toThrow('Лимит исчерпан');
    expect(generateContent).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('confirm при выключенном режиме: вызова модели нет — и бюджет не читается', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { service, plans, sessions } = setup({ budgetFails: true });
    await service.confirm('s1', { pathname: PATH, label: 'Мама' });
    expect(plans.assertCanSpendSession).not.toHaveBeenCalled();
    expect(sessions.updateSession).toHaveBeenCalled();
  });
});

describe('ограничитель частоты на платных маршрутах', () => {
  const rulesOf = (name: keyof GreetingReferenceController) =>
    Reflect.getMetadata(
      RATE_LIMIT_KEY,
      GreetingReferenceController.prototype[name],
    ) as RateLimitRule[] | undefined;

  it.each(['generate', 'settings', 'confirm'] as const)(
    '%s — по человеку, с узким и часовым окном',
    (name) => {
      const rules = rulesOf(name);
      expect(rules).toHaveLength(2);
      expect(rules!.every((r) => r.by === 'user')).toBe(true);
    },
  );

  it('бесплатные маршруты без ограничителя', () => {
    expect(rulesOf('list')).toBeUndefined();
    expect(rulesOf('uploadUrl')).toBeUndefined();
  });
});

describe('правка во время рендера — 409 с кодом (CONTRACT6 п.2)', () => {
  const busy = { status: 'processing' };

  it.each([
    [
      'confirm',
      (s: GreetingReferenceService) =>
        s.confirm('s1', { pathname: PATH, label: 'Мама' }),
    ],
    [
      'generateFrame',
      (s: GreetingReferenceService) => s.generateFrame('s1', 'u1'),
    ],
    [
      'update',
      (s: GreetingReferenceService) =>
        s.update('s1', 'gr_1', { label: 'Папа' }),
    ],
    ['remove', (s: GreetingReferenceService) => s.remove('s1', 'gr_1')],
  ])('%s', async (_name, call) => {
    const { service, sessions, frames } = setup({
      video: busy,
      images: [img('gr_1')],
    });
    const body = await bodyOf(call(service));
    expect(body).toEqual({
      status: 409,
      code: 'GREETING_CHANGE_DURING_RENDER',
      message: GREETING_CHANGE_DURING_RENDER_MESSAGE,
    });
    expect(sessions.updateSession).not.toHaveBeenCalled();
    expect(frames.generate).not.toHaveBeenCalled();
  });

  it('готовый ролик правку не держит — фото удаляется', async () => {
    const { service, sessions } = setup({
      video: { status: 'complete' },
      images: [img('gr_1')],
    });
    await service.remove('s1', 'gr_1');
    expect(sessions.updateSession).toHaveBeenCalled();
  });
});

describe('коды и русские тексты отказов (CONTRACT6 п.9)', () => {
  const full = Array.from({ length: MAX_GREETING_REFERENCE_IMAGES }, (_, i) =>
    img(`gr_${i}`),
  );

  it('не поздравление — код и текст без внутренних имён', async () => {
    const { service } = setup({ brief: null });
    for (const p of [
      service.createUploadUrl('s1', { mimeType: 'image/jpeg' } as any),
      service.generateFrame('s1', 'u1'),
      service.suggestSettings('s1', 'u1'),
    ]) {
      const body = await bodyOf(p);
      expect(body.code).toBe('GREETING_NOT_GREETING_SESSION');
      expect(body.message).not.toMatch(/GREETING_VIDEO|brief|session/i);
    }
  });

  it('лимит фото — один код у загрузки, подтверждения и кадра', async () => {
    const { service } = setup({ images: full });
    for (const p of [
      service.createUploadUrl('s1', { mimeType: 'image/jpeg' } as any),
      service.confirm('s1', {
        pathname: 'sessions/s1/greeting-refs/gr_new/photo.jpg',
        label: 'x',
      }),
      service.generateFrame('s1', 'u1'),
    ]) {
      const body = await bodyOf(p);
      expect(body).toMatchObject({
        status: 400,
        code: 'GREETING_REFERENCE_LIMIT',
      });
      expect(body.message).toContain(String(MAX_GREETING_REFERENCE_IMAGES));
      expect(body.message).not.toMatch(/Grok|reference/i);
    }
  });

  it('чужой путь, повтор, пропавший файл, неизвестное фото — свои коды, без путей и id', async () => {
    const { service } = setup({ images: [img('gr_abc')] });
    const foreign = await bodyOf(
      service.confirm('s1', {
        pathname: 'sessions/s2/greeting-refs/gr_x/photo.jpg',
        label: 'x',
      }),
    );
    expect(foreign.code).toBe('GREETING_REFERENCE_PATH_INVALID');
    expect(foreign.message).not.toContain('sessions/');

    const again = await bodyOf(
      service.confirm('s1', { pathname: PATH, label: 'x' }),
    );
    expect(again.code).toBe('GREETING_REFERENCE_ALREADY_ADDED');
    expect(again.message).not.toContain('gr_abc');

    const missing = await bodyOf(
      service.update('s1', 'gr_zzz', { label: 'x' }),
    );
    expect(missing).toMatchObject({
      status: 404,
      code: 'GREETING_REFERENCE_NOT_FOUND',
    });
    expect(missing.message).not.toContain('gr_zzz');
    const missing2 = await bodyOf(service.remove('s1', 'gr_zzz'));
    expect(missing2.code).toBe('GREETING_REFERENCE_NOT_FOUND');
  });

  it('файл не дошёл до хранилища — код, текст без пути и ошибки хранилища', async () => {
    const { service } = setup({ downloadFails: true });
    const body = await bodyOf(
      service.confirm('s1', { pathname: PATH, label: 'x' }),
    );
    expect(body.code).toBe('GREETING_REFERENCE_UPLOAD_MISSING');
    expect(body.message).not.toContain('sessions/');
    expect(body.message).not.toContain('404');
  });
});
