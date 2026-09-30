/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../storage/blob.service', () => ({ BlobService: class {} }));
jest.mock('../../common/platform-settings.service', () => ({
  PlatformSettingsService: class {},
}));
jest.mock('../image-sketch/sketch-generator.service', () => ({
  SketchGeneratorService: class {},
}));

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { PersonaLooksService } from './persona-looks.service';
import { LOOK_WARNING_AGE_SHIFT } from './persona-looks.rules';

const PERSONA = {
  id: 'p1',
  userId: 'u1',
  consentGivenAt: new Date('2026-09-01'),
  revokedAt: null as Date | null,
  livenessCheckedAt: new Date('2026-09-01'),
  verifyResult: { status: 'ok', reasons: [] } as unknown,
  ageMin: 28 as number | null,
  ageMax: 34 as number | null,
  selfiePathname: 'users/u1/personas/p1/selfie.jpg' as string | null,
  sourcesPurgedAt: null as Date | null,
};

const OK_OUTCOME = {
  status: 'ok' as const,
  bytes: Buffer.from('png'),
  mimeType: 'image/png',
  model: 'gemini-3.1-flash-image',
  raw: { usageMetadata: { candidatesTokenCount: 1290 } },
};

function build(
  over: {
    persona?: Partial<typeof PERSONA> | null;
    looks?: Array<Record<string, any>>;
    plan?: string;
    dayUsed?: number;
    monthUsed?: number;
    settings?: Record<string, string>;
    outcome?: unknown;
    /** Чужие живые брони, созданные раньше нашей. */
    pendingAhead?: number;
    /** Скетчи образов (image_sketches) для удаления образа. */
    sketches?: Array<Record<string, any>>;
    /** Пути, удаление которых в Blob «не удалось». */
    failDelete?: string[];
  } = {},
) {
  const persona =
    over.persona === null ? null : { ...PERSONA, ...(over.persona ?? {}) };
  const looks: Record<string, any> = {};
  for (const l of over.looks ?? []) looks[l.id] = { ...l };
  let seq = 0;
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (k === 'persona') {
        const p = persona;
        return (
          !!p &&
          row.personaId === p.id &&
          (v as any).userId === p.userId &&
          ((v as any).revokedAt === undefined || p.revokedAt === null)
        );
      }
      return row[k] === v;
    });
  const prisma = {
    persona: {
      findFirst: jest
        .fn()
        .mockImplementation(async ({ where }: any) =>
          persona && persona.userId === where.userId && !persona.revokedAt
            ? persona
            : null,
        ),
    },
    personaLook: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        const found = Object.values(looks).find((r) => matches(r, where));
        return found ? { ...found } : null;
      }),
      findUnique: jest
        .fn()
        .mockImplementation(async ({ where, include }: any) => {
          const row = looks[where.id];
          if (!row) return null;
          return include?.persona ? { ...row, persona } : { ...row };
        }),
      findMany: jest.fn().mockImplementation(async () => [
        ...Array.from({ length: over.pendingAhead ?? 0 }, (_, i) => ({
          id: `other${i}`,
        })),
        ...Object.values(looks)
          .filter((r) => r.status === 'pending' && !r.isBase)
          .map((r) => ({ id: r.id })),
      ]),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        seq += 1;
        const row = {
          id: `new${seq}`,
          createdAt: new Date('2026-09-30T10:00:00Z'),
          photoUrl: null,
          photoPathname: null,
          error: null,
          deletedAt: null,
          ...data,
        };
        looks[row.id] = row;
        return { ...row };
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        looks[where.id] = { ...looks[where.id], ...data };
        return { ...looks[where.id] };
      }),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const row = looks[where.id];
        if (row && matches(row, { deletedAt: where.deletedAt })) {
          looks[where.id] = { ...row, ...data };
          return { count: 1 };
        }
        return { count: 0 };
      }),
      deleteMany: jest.fn().mockImplementation(async ({ where }: any) => {
        delete looks[where.id];
        return { count: 1 };
      }),
    },
    imageSketch: {
      findMany: jest
        .fn()
        .mockImplementation(async ({ where }: any) =>
          (over.sketches ?? [])
            .filter(
              (r) =>
                r.userId === where.userId &&
                r.targetType === where.targetType &&
                r.targetId === where.targetId &&
                r.pathname !== null,
            )
            .map((r) => ({ id: r.id, pathname: r.pathname })),
        ),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        for (const r of over.sketches ?? []) {
          if (where.id.in.includes(r.id)) Object.assign(r, data);
        }
        return { count: where.id.in.length };
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ firstName: 'Андрей' }),
    },
  };
  const plans = {
    planOfUser: jest.fn().mockResolvedValue(over.plan ?? 'LITE'),
    assertUser: jest.fn(),
    assertCanSpendUser: jest.fn(),
  };
  const aiUsage = {
    countToday: jest.fn().mockResolvedValue(over.dayUsed ?? 0),
    countSince: jest.fn().mockResolvedValue(over.monthUsed ?? 0),
    recordGemini: jest.fn(),
  };
  const blob = {
    downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('src')),
    uploadBuffer: jest
      .fn()
      .mockImplementation(async (p: string) => ({ url: `https://blob/${p}` })),
    deleteBlob: jest
      .fn()
      .mockImplementation(async (p: string) => !over.failDelete?.includes(p)),
  };
  const settings = {
    get: jest
      .fn()
      .mockImplementation(async (k: string) => over.settings?.[k] ?? null),
  };
  const generator = {
    generate: jest.fn().mockResolvedValue(over.outcome ?? OK_OUTCOME),
  };
  const service = new PersonaLooksService(
    prisma as any,
    plans as any,
    aiUsage as any,
    blob as any,
    settings as any,
    generator as any,
  );
  return { service, prisma, plans, aiUsage, blob, settings, generator, looks };
}

const BASE_LOOK = {
  id: 'base1',
  personaId: 'p1',
  label: '',
  preset: null,
  prompt: null,
  targetAge: 31,
  sourceLookId: null,
  isBase: true,
  status: 'ready',
  photoPathname: 'users/u1/personas/p1/looks/base1.png',
  photoUrl: 'https://blob/users/u1/personas/p1/looks/base1.png',
  error: null,
  deletedAt: null,
  createdAt: new Date('2026-09-01'),
};

describe('PersonaLooksService.create', () => {
  const saved = process.env.PERSONA_ENABLED;
  beforeEach(() => {
    process.env.PERSONA_ENABLED = 'true';
  });
  afterAll(() => {
    process.env.PERSONA_ENABLED = saved;
  });

  it('из селфи: image-to-image моделью картинок, файл под префиксом персоны, расход persona-look', async () => {
    const { service, generator, blob, aiUsage, looks } = build({
      looks: [BASE_LOOK],
    });
    const look = await service.create('u1', { preset: 'business' });
    expect(blob.downloadBuffer).toHaveBeenCalledWith(
      'users/u1/personas/p1/selfie.jpg',
    );
    const call = generator.generate.mock.calls[0][0];
    expect(call.model).toBe('gemini-3.1-flash-image');
    expect(call.source.mimeType).toBe('image/jpeg');
    expect(call.prompt).toContain('Business look');
    expect(call.prompt).toContain('about 31 years old');
    expect(blob.uploadBuffer.mock.calls[0][0]).toBe(
      `users/u1/personas/p1/looks/${look.id}.png`,
    );
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      OK_OUTCOME.raw,
      expect.objectContaining({ operation: 'persona-look', userId: 'u1' }),
    );
    expect(look.status).toBe('ready');
    expect(look.targetAge).toBe(31);
    expect(look.warning).toBeUndefined();
    expect(looks[look.id].sourceLookId).toBeNull();
  });

  it('из другого образа — его файл; чужой образ — 400 до модели', async () => {
    const { service, blob } = build({
      looks: [
        BASE_LOOK,
        {
          ...BASE_LOOK,
          id: 'l2',
          isBase: false,
          targetAge: 60,
          photoPathname: 'users/u1/personas/p1/looks/l2.png',
        },
        {
          ...BASE_LOOK,
          id: 'alien',
          personaId: 'p2',
          isBase: false,
          photoPathname: 'users/u2/personas/p2/looks/alien.png',
        },
      ],
    });
    const look = await service.create('u1', {
      sourceLookId: 'l2',
      description: 'зимнее пальто',
    });
    expect(blob.downloadBuffer).toHaveBeenLastCalledWith(
      'users/u1/personas/p1/looks/l2.png',
    );
    // Возраст по умолчанию — возраст образа-источника.
    expect(look.targetAge).toBe(60);

    const second = build({
      looks: [
        {
          ...BASE_LOOK,
          id: 'alien',
          personaId: 'p2',
          isBase: false,
          photoPathname: 'users/u2/personas/p2/looks/alien.png',
        },
      ],
    });
    await expect(
      second.service.create('u1', { sourceLookId: 'alien', preset: 'sport' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(second.generator.generate).not.toHaveBeenCalled();
    expect(second.prisma.personaLook.create).not.toHaveBeenCalled();
  });

  it('после удаления селфи по сроку источник — базовый образ (В-3)', async () => {
    const { service, blob, looks } = build({
      persona: { sourcesPurgedAt: new Date(), selfiePathname: null },
      looks: [BASE_LOOK],
    });
    const look = await service.create('u1', { preset: 'evening' });
    expect(blob.downloadBuffer).toHaveBeenCalledWith(BASE_LOOK.photoPathname);
    expect(looks[look.id].sourceLookId).toBe('base1');
  });

  it('Т-6: возраст вне 18…90 — 400; 18 и 90 проходят', async () => {
    for (const bad of [17, 0, 91, 150]) {
      const { service, generator } = build();
      await expect(
        service.create('u1', { targetAge: bad }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(generator.generate).not.toHaveBeenCalled();
    }
    for (const ok of [18, 90]) {
      const { service, generator } = build();
      const look = await service.create('u1', { targetAge: ok });
      expect(look.targetAge).toBe(ok);
      expect(generator.generate.mock.calls[0][0].prompt).toContain(
        `about ${ok} years old`,
      );
    }
  });

  it('сдвиг возраста больше 20 лет — warning; ровно 20 — без него', async () => {
    // Опорный возраст — середина оценки селфи 28–34 → 31.
    const far = await build().service.create('u1', { targetAge: 52 });
    expect(far.warning).toBe(LOOK_WARNING_AGE_SHIFT);
    const near = await build().service.create('u1', { targetAge: 51 });
    expect(near.warning).toBeUndefined();
    const young = await build().service.create('u1', { targetAge: 18 });
    expect(young.warning).toBeUndefined();
  });

  it('описание «в образе Монро» — отказ до модели и до брони', async () => {
    const { service, generator, prisma } = build();
    await expect(
      service.create('u1', { description: 'в образе Мэрилин Монро' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(generator.generate).not.toHaveBeenCalled();
    expect(prisma.personaLook.create).not.toHaveBeenCalled();
  });

  it('пустой запрос — 400', async () => {
    const { service } = build();
    await expect(service.create('u1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('квота: на границе — 429, бронь снята, модель не зовётся; на единицу ниже — проходит', async () => {
    // LITE: 3 в сутки, 20 в месяц (В-7).
    const atDay = build({ dayUsed: 3 });
    const err = await atDay.service
      .create('u1', { preset: 'sport' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(atDay.generator.generate).not.toHaveBeenCalled();
    expect(Object.keys(atDay.looks)).toHaveLength(0);

    const belowDay = build({ dayUsed: 2 });
    await expect(
      belowDay.service.create('u1', { preset: 'sport' }),
    ).resolves.toMatchObject({ status: 'ready' });

    const atMonth = build({ dayUsed: 0, monthUsed: 20 });
    const monthErr = await atMonth.service
      .create('u1', { preset: 'sport' })
      .catch((e) => e);
    expect((monthErr as HttpException).getStatus()).toBe(429);
    expect(JSON.stringify((monthErr as HttpException).getResponse())).toContain(
      'месяце',
    );

    const belowMonth = build({ monthUsed: 19 });
    await expect(
      belowMonth.service.create('u1', { preset: 'sport' }),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it('квота по тарифу и из настроек админки', async () => {
    const premium = build({ plan: 'PREMIUM', dayUsed: 29 });
    await expect(
      premium.service.create('u1', { preset: 'sport' }),
    ).resolves.toMatchObject({ status: 'ready' });
    const premiumFull = build({ plan: 'PREMIUM', dayUsed: 30 });
    await expect(
      premiumFull.service.create('u1', { preset: 'sport' }),
    ).rejects.toBeInstanceOf(HttpException);

    const closed = build({
      plan: 'STANDARD',
      settings: { persona_look_day_standard: '0' },
    });
    await expect(
      closed.service.create('u1', { preset: 'sport' }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(closed.settings.get).toHaveBeenCalledWith(
      'persona_look_day_standard',
    );
  });

  it('параллельные брони: чужие впереди считаются в лимит', async () => {
    const { service, generator } = build({ dayUsed: 1, pendingAhead: 2 });
    await expect(
      service.create('u1', { preset: 'sport' }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('quotaLeft — остаток, не ниже нуля', async () => {
    expect(
      await build({ dayUsed: 1, monthUsed: 5 }).service.quotaLeft('u1'),
    ).toEqual({
      dayLeft: 2,
      monthLeft: 15,
    });
    expect(
      await build({ dayUsed: 9, monthUsed: 40 }).service.quotaLeft('u1'),
    ).toEqual({
      dayLeft: 0,
      monthLeft: 0,
    });
  });

  it('сбой модели: 502, расход не пишется, строка убрана из галереи', async () => {
    const { service, aiUsage, looks } = build({
      outcome: { status: 'failed', reason: 'timeout', model: 'm' },
    });
    const err = await service.create('u1', { preset: 'sport' }).catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(502);
    expect(aiUsage.recordGemini).not.toHaveBeenCalled();
    const row = Object.values(looks)[0];
    expect(row.status).toBe('failed');
    expect(row.deletedAt).toBeInstanceOf(Date);
  });

  it('отказ модели: 422, расход пишется — вызов оплачен', async () => {
    const { service, aiUsage } = build({
      outcome: { status: 'refused', reason: 'SAFETY', model: 'm', raw: {} },
    });
    const err = await service.create('u1', { preset: 'sport' }).catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(422);
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ operation: 'persona-look' }),
    );
  });

  it('режим выключен — 404; персоны нет — 404; не проверена — 403', async () => {
    process.env.PERSONA_ENABLED = 'false';
    await expect(
      build().service.create('u1', { preset: 'sport' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    process.env.PERSONA_ENABLED = 'true';
    await expect(
      build({ persona: null }).service.create('u1', { preset: 'sport' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    for (const patch of [
      { livenessCheckedAt: null },
      { verifyResult: { status: 'refused' } },
      { ageMin: 16 },
    ]) {
      await expect(
        build({ persona: patch as never }).service.create('u1', {
          preset: 'sport',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
});

describe('PersonaLooksService.generateLookImage (базовый образ для E)', () => {
  beforeEach(() => {
    process.env.PERSONA_ENABLED = 'true';
  });

  it('базовый: только селфи, нейтральный портрет, квоту не тратит, возраст записан', async () => {
    const pending = {
      ...BASE_LOOK,
      id: 'b2',
      status: 'pending',
      targetAge: null,
      photoPathname: null,
      photoUrl: null,
    };
    const { service, generator, aiUsage, looks, blob } = build({
      looks: [pending],
    });
    await service.generateLookImage('b2', { base: true });
    expect(blob.downloadBuffer).toHaveBeenCalledWith(
      'users/u1/personas/p1/selfie.jpg',
    );
    expect(generator.generate.mock.calls[0][0].prompt).toContain(
      'neutral portrait',
    );
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      OK_OUTCOME.raw,
      expect.objectContaining({ operation: 'persona-look-base' }),
    );
    expect(looks.b2).toMatchObject({
      status: 'ready',
      targetAge: 31,
      photoPathname: 'users/u1/personas/p1/looks/b2.png',
    });
  });

  it('базовый без селфи — failed и исключение, модель не зовётся', async () => {
    const { service, generator, looks } = build({
      persona: { selfiePathname: null },
      looks: [{ ...BASE_LOOK, id: 'b3', status: 'pending' }],
    });
    await expect(
      service.generateLookImage('b3', { base: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(generator.generate).not.toHaveBeenCalled();
    expect(looks.b3.status).toBe('failed');
  });
});

describe('PersonaLooksService: переименование, удаление, фраза согласия', () => {
  beforeEach(() => {
    process.env.PERSONA_ENABLED = 'true';
  });

  it('переименование своего образа; чужой — 404', async () => {
    const { service, looks } = build({
      looks: [{ ...BASE_LOOK, id: 'l1', isBase: false }],
    });
    const view = await service.rename('u1', 'l1', '  Деловой\n');
    expect(view.label).toBe('Деловой');
    expect(looks.l1.label).toBe('Деловой');
    await expect(service.rename('u2', 'l1', 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('удаление образа удаляет файлы фото и всех его скетчей, потом строку (CONTRACT5 п.9)', async () => {
    const sketches = [
      {
        id: 'sk1',
        userId: 'u1',
        targetType: 'persona-look',
        targetId: 'l1',
        pathname: 'sketches/u1/sk1.png',
        status: 'applied',
      },
      {
        id: 'sk2',
        userId: 'u1',
        targetType: 'persona-look',
        targetId: 'l1',
        pathname: 'sketches/u1/sk2.png',
        status: 'candidate',
      },
      {
        id: 'skX',
        userId: 'u1',
        targetType: 'persona-look',
        targetId: 'other',
        pathname: 'sketches/u1/skX.png',
        status: 'applied',
      },
    ];
    const { service, looks, blob } = build({
      looks: [
        {
          ...BASE_LOOK,
          id: 'l1',
          isBase: false,
          photoPathname: 'users/u1/personas/p1/looks/l1.png',
          activeSketchId: 'sk1',
        },
      ],
      sketches,
    });
    await service.remove('u1', 'l1');
    const deleted = blob.deleteBlob.mock.calls.map((c: any[]) => c[0]).sort();
    expect(deleted).toEqual([
      'sketches/u1/sk1.png',
      'sketches/u1/sk2.png',
      'users/u1/personas/p1/looks/l1.png',
    ]);
    expect(looks.l1).toMatchObject({
      photoPathname: null,
      photoUrl: null,
      activeSketchId: null,
    });
    expect(looks.l1.deletedAt).toBeInstanceOf(Date);
    expect(sketches[0]).toMatchObject({ pathname: null, url: null });
    expect(sketches[1]).toMatchObject({ pathname: null, url: null });
    // Скетч чужого образа не тронут.
    expect(sketches[2].pathname).toBe('sketches/u1/skX.png');
  });

  it('файл не удалился — 503, строка и ссылки остаются для повтора', async () => {
    const sketches = [
      {
        id: 'sk1',
        userId: 'u1',
        targetType: 'persona-look',
        targetId: 'l1',
        pathname: 'sketches/u1/sk1.png',
      },
    ];
    const { service, looks, prisma } = build({
      looks: [
        {
          ...BASE_LOOK,
          id: 'l1',
          isBase: false,
          photoPathname: 'users/u1/personas/p1/looks/l1.png',
        },
      ],
      sketches,
      failDelete: ['sketches/u1/sk1.png'],
    });
    const err = await service.remove('u1', 'l1').catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(503);
    expect(looks.l1.deletedAt).toBeNull();
    expect(looks.l1.photoPathname).toBe('users/u1/personas/p1/looks/l1.png');
    expect(sketches[0].pathname).toBe('sketches/u1/sk1.png');
    expect(prisma.imageSketch.updateMany).not.toHaveBeenCalled();
  });

  it('удаление работает и при выключенном флаге — право на удаление', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { service, looks } = build({
      looks: [{ ...BASE_LOOK, id: 'l1', isBase: false }],
    });
    await service.remove('u1', 'l1');
    expect(looks.l1.deletedAt).toBeInstanceOf(Date);
    await expect(service.rename('u1', 'l1', 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    process.env.PERSONA_ENABLED = 'true';
  });

  it('удаление мягкое; базовый образ отдельно не удаляется', async () => {
    const { service, looks } = build({
      looks: [BASE_LOOK, { ...BASE_LOOK, id: 'l1', isBase: false }],
    });
    await service.remove('u1', 'l1');
    expect(looks.l1.deletedAt).toBeInstanceOf(Date);
    await expect(service.remove('u1', 'base1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(looks.base1.deletedAt).toBeNull();
  });

  it('фраза согласия голоса — с именем из профиля и шаблоном', async () => {
    const { service } = build();
    const r = await service.voiceConsentPhrase('u1', 'uk');
    expect(r.locale).toBe('uk');
    expect(r.text).toContain('Я, Андрей, дозволяю');
    expect(r.template).toContain('{name}');
  });
});
