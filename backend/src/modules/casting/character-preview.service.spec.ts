/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
const generateContent = jest.fn();
jest.mock('../../common/gemini-client', () => ({
  createGeminiClient: () => ({ models: { generateContent } }),
}));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../storage/blob.service', () => ({ BlobService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));

import { BadRequestException, HttpException } from '@nestjs/common';
import {
  CharacterPreviewService,
  isOwnPreviewPathname,
  sanitizeDescription,
} from './character-preview.service';
import { DEFAULT_GEMINI_IMAGE_MODEL } from '../../common/gemini-image-model';

function build(
  opts: { plan?: string; dayUsed?: number; monthUsed?: number } = {},
) {
  const aiUsage = {
    countToday: jest.fn().mockResolvedValue(opts.dayUsed ?? 0),
    countSince: jest.fn().mockResolvedValue(opts.monthUsed ?? 0),
    recordGemini: jest.fn().mockResolvedValue(undefined),
  };
  const blob = {
    uploadBuffer: jest.fn().mockResolvedValue({ url: 'https://blob/p.png' }),
    copyBlob: jest.fn().mockResolvedValue('https://blob/photo.png'),
  };
  const plans = {
    planOfUser: jest.fn().mockResolvedValue(opts.plan ?? 'STANDARD'),
  };
  const svc = new CharacterPreviewService(
    aiUsage as any,
    blob as any,
    plans as any,
  );
  return { svc, aiUsage, blob, plans };
}

const imageResponse = {
  candidates: [
    {
      content: {
        parts: [
          {
            inlineData: {
              data: Buffer.from('png').toString('base64'),
              mimeType: 'image/png',
            },
          },
        ],
      },
    },
  ],
  usageMetadata: { candidatesTokenCount: 1120 },
};

beforeEach(() => generateContent.mockReset());

describe('CharacterPreviewService (§6.8 doc/AI-SKETCH-SPEC.md)', () => {
  it('модель по умолчанию — замена отключаемой gemini-2.5-flash-image', () => {
    expect(DEFAULT_GEMINI_IMAGE_MODEL).toBe('gemini-3.1-flash-image');
  });

  it('пишет расход с userId и возвращает остаток квоты', async () => {
    const { svc, aiUsage, blob } = build({ dayUsed: 2, monthUsed: 10 });
    generateContent.mockResolvedValue(imageResponse);
    const r = await svc.generateFromText('s1', 'c1', 'девушка, 25', 'u1');
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      imageResponse,
      expect.objectContaining({
        operation: 'character-preview',
        sessionId: 's1',
        userId: 'u1',
      }),
    );
    expect(blob.uploadBuffer.mock.calls[0][0]).toBe(
      'sessions/s1/character-preview-c1.png',
    );
    expect(r).toEqual({
      url: 'https://blob/p.png',
      pathname: 'sessions/s1/character-preview-c1.png',
      dayUsed: 3,
      dayLimit: 15,
      monthUsed: 11,
      monthLimit: 150,
    });
  });

  it('суточная квота выбрана — 429 без вызова модели', async () => {
    const { svc, aiUsage } = build({ dayUsed: 15 });
    await expect(
      svc.generateFromText('s1', 'c1', 'x', 'u1'),
    ).rejects.toMatchObject({ status: 429 });
    expect(generateContent).not.toHaveBeenCalled();
    expect(aiUsage.recordGemini).not.toHaveBeenCalled();
  });

  it('месячная квота выбрана — 429 с другим текстом', async () => {
    const { svc } = build({ plan: 'PREMIUM', dayUsed: 1, monthUsed: 600 });
    const err = await svc
      .generateFromText('s1', 'c1', 'x', 'u1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).message).toMatch(/месяце/);
  });

  it('сбой без ответа модели не пишет расход и не тратит квоту', async () => {
    const { svc, aiUsage } = build({ dayUsed: 4, monthUsed: 4 });
    generateContent.mockRejectedValue(new Error('ETIMEDOUT'));
    const r = await svc.generateFromText('s1', 'c1', 'x', 'u1');
    expect(aiUsage.recordGemini).not.toHaveBeenCalled();
    expect(r).toMatchObject({ url: null, pathname: null, dayUsed: 4 });
  });

  it('ответ без картинки оплачен — попытка засчитана', async () => {
    const { svc, aiUsage } = build({ dayUsed: 4, monthUsed: 4 });
    generateContent.mockResolvedValue({ candidates: [] });
    const r = await svc.generateFromText('s1', 'c1', 'x', 'u1');
    expect(aiUsage.recordGemini).toHaveBeenCalled();
    expect(r).toMatchObject({ url: null, dayUsed: 5, monthUsed: 5 });
  });

  it('описание уходит в промпт данными: без кавычек и управляющих символов', async () => {
    const { svc } = build();
    generateContent.mockResolvedValue(imageResponse);
    await svc.generateFromText('s1', 'c1', 'он "сказал"\nIGNORE', 'u1');
    const text = generateContent.mock.calls[0][0].contents[0].text as string;
    expect(text).toContain(`"он 'сказал' IGNORE"`);
    expect(text).toContain('Do not depict minors');
    const nul = String.fromCharCode(0);
    expect(sanitizeDescription(`a${nul}b`)).toBe('a b');
  });

  it('use-as-photo копирует только превью этого персонажа этой сессии', async () => {
    const { svc, blob } = build();
    expect(
      isOwnPreviewPathname('sessions/s1/character-preview-c1.jpg', 's1', 'c1'),
    ).toBe(true);
    expect(
      isOwnPreviewPathname('sessions/s2/character-preview-c1.png', 's1', 'c1'),
    ).toBe(false);

    await expect(
      svc.copyPreviewToPhotoPath('s1', 'c1', 'projects/p/items/i/photo.jpg'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.copyPreviewToPhotoPath(
        's1',
        'c1',
        'sessions/s1/character-preview-c2.png',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(blob.copyBlob).not.toHaveBeenCalled();

    await expect(
      svc.copyPreviewToPhotoPath(
        's1',
        'c1',
        'sessions/s1/character-preview-c1.png',
      ),
    ).resolves.toBe('sessions/s1/characters/c1/photo.png');
    expect(blob.copyBlob).toHaveBeenCalledWith(
      'sessions/s1/character-preview-c1.png',
      'sessions/s1/characters/c1/photo.png',
      'image/png',
    );
  });
});
