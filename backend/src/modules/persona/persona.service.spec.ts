import { PersonaService, PERSONA_RETENTION_BATCH } from './persona.service';
import { PERSONA_CONSENT_VERSION } from './persona-consent';
import {
  BASE_LOOK_GENERATOR_MISSING,
  PERSONA_LOOK_GENERATOR,
  PERSONA_SHARES_LOOKUP,
} from './persona-look-generator';
import { UserVoicesService } from '../user-voices/user-voices.service';

const GOOD = {
  faces: 1,
  frontal: true,
  quality: 'good',
  screenOrPrint: false,
  sameAsSelfie: true,
  liveMotion: true,
  ageMin: 26,
  ageMax: 32,
};

type Row = Record<string, unknown>;

function persona(over: Row = {}): Row {
  return {
    id: 'p1',
    userId: 'u1',
    consentGivenAt: new Date('2026-09-30T00:00:00Z'),
    consentText: 't',
    consentTextVersion: PERSONA_CONSENT_VERSION,
    selfiePathname: 'users/u1/personas/p1/selfie-n.jpg',
    livenessPathname: 'users/u1/personas/p1/liveness-n.webm',
    livenessCheckedAt: null,
    verifyResult: null,
    ageMin: null,
    ageMax: null,
    ageEstimatedAt: null,
    sourcesPurgedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function build(opts: {
  row?: Row | null;
  modelText?: string;
  providers?: Record<string, unknown>;
}) {
  let row: Row | null = opts.row === undefined ? persona() : opts.row;
  const prisma = {
    persona: {
      findUnique: jest.fn(async () => row),
      findUniqueOrThrow: jest.fn(async () => row),
      findMany: jest.fn(async (_args?: { where: Row }) => [] as Row[]),
      create: jest.fn(async ({ data }: { data: Row }) => {
        row = persona({
          ...data,
          selfiePathname: null,
          livenessPathname: null,
        });
        return row;
      }),
      update: jest.fn(async ({ data }: { data: Row }) => {
        row = { ...row!, ...data };
        return row;
      }),
      updateMany: jest.fn(async ({ data }: { data: Row }) => {
        row = { ...row!, ...data };
        return { count: 1 };
      }),
      delete: jest.fn(async () => row),
    },
    personaLook: {
      create: jest.fn(async ({ data }: { data: Row }) => ({
        id: 'look1',
        ...data,
      })),
      findFirst: jest.fn(async () => ({
        id: 'look1',
        label: '',
        preset: null,
        targetAge: null,
        isBase: true,
        status: 'failed',
        photoUrl: null,
        error: BASE_LOOK_GENERATOR_MISSING,
        createdAt: new Date('2026-09-30T00:00:00Z'),
        activeSketch: null,
      })),
      findMany: jest.fn(async () => [] as Row[]),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({
        id: 'look1',
        label: '',
        preset: null,
        targetAge: null,
        isBase: true,
        status: 'ready',
        photoUrl: 'https://x/new.png',
        error: null,
        createdAt: new Date('2026-09-30T00:00:00Z'),
        activeSketch: null,
      })),
    },
    imageSketch: {
      findMany: jest.fn(async () => [] as Row[]),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    userVoice: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => [] as Row[]),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const blob = {
    createUploadUrl: jest.fn(async (p: string) => ({ uploadUrl: `put:${p}` })),
    head: jest.fn(async () => ({ url: 'u', size: 1000 })),
    downloadBuffer: jest.fn(async () => Buffer.from('bytes')),
    deleteMany: jest.fn(async (paths: string[]) => paths.length),
    deleteBlob: jest.fn(async () => true),
    uploadBuffer: jest.fn(async (p: string) => ({ url: `https://blob/${p}` })),
    listByPrefix: jest.fn(async () => ({ blobs: [], cursor: null })),
  };
  const aiUsage = {
    recordGemini: jest.fn(async () => undefined),
    countToday: jest.fn(async () => 0),
  };
  const providers = opts.providers ?? {};
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      const key =
        typeof token === 'string' ? token : (token as { name: string }).name;
      if (key in providers) return providers[key];
      throw new Error('not found');
    }),
  };
  const plans = { assertCanSpendUser: jest.fn(async () => undefined) };
  const service = new PersonaService(
    prisma as never,
    blob as never,
    aiUsage as never,
    moduleRef as never,
    plans as never,
  );
  const generateContent = jest.fn(async () => ({
    text: opts.modelText ?? JSON.stringify(GOOD),
  }));
  (service as unknown as { genai: unknown }).genai = {
    models: { generateContent },
  };
  return {
    service,
    prisma,
    blob,
    aiUsage,
    plans,
    generateContent,
    get row() {
      return row;
    },
  };
}

const ENV = process.env.PERSONA_ENABLED;
beforeEach(() => {
  process.env.PERSONA_ENABLED = 'true';
});
afterAll(() => {
  process.env.PERSONA_ENABLED = ENV;
});

describe('PersonaService — рубильник', () => {
  it('выключен — создание, проверка, текст согласия и /me без персоны: 404 PERSONA_DISABLED', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { service, generateContent } = build({ row: null });
    for (const call of [
      () => service.me('u1'),
      () => service.verify('u1'),
      () => service.regenerateBase('u1', 'look1'),
      () =>
        service.create('u1', {
          consent: true,
          consentTextVersion: PERSONA_CONSENT_VERSION,
        }),
      async () => service.consentText('ru'),
    ]) {
      await expect(call()).rejects.toMatchObject({
        response: { code: 'PERSONA_DISABLED' },
      });
    }
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('выключен, персона есть — /me отвечает (enabled: false), удаление работает (право на удаление)', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const h = build({ row: persona({ livenessCheckedAt: new Date() }) });
    const me = await h.service.me('u1');
    expect(me.enabled).toBe(false);
    expect(me.persona?.id).toBe('p1');
    expect(me.quota).toEqual({ dayLeft: 0, monthLeft: 0 });
    await h.service.remove('u1');
    expect(h.prisma.persona.delete).toHaveBeenCalledWith({
      where: { id: 'p1' },
    });
  });
});

describe('PersonaService.create', () => {
  const dto = { consent: true, consentTextVersion: PERSONA_CONSENT_VERSION };

  it('согласие записано ДО ссылок; ссылки под префиксом персоны', async () => {
    const { service, prisma, blob } = build({ row: null });
    const r = await service.create('u1', { ...dto, locale: 'en' });
    const created = prisma.persona.create.mock.calls[0][0].data;
    expect(created.consentTextVersion).toBe(PERSONA_CONSENT_VERSION);
    expect(created.consentText).toMatch(/Consent/);
    expect(created.consentGivenAt).toBeInstanceOf(Date);
    expect(r.selfiePathname).toMatch(
      /^users\/u1\/personas\/p1\/selfie-[0-9a-f]{24}\.jpg$/,
    );
    expect(r.livenessPathname).toMatch(/liveness-[0-9a-f]{24}\.webm$/);
    expect(r.selfieUploadUrl).toBe(`put:${r.selfiePathname}`);
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      r.selfiePathname,
      'image/jpeg',
      expect.any(Number),
    );
    expect(prisma.persona.create.mock.invocationCallOrder[0]).toBeLessThan(
      blob.createUploadUrl.mock.invocationCallOrder[0],
    );
  });

  it('устаревшая версия текста — 409, ничего не пишется', async () => {
    const { service, prisma } = build({ row: null });
    await expect(
      service.create('u1', { consent: true, consentTextVersion: 'old' }),
    ).rejects.toMatchObject({ response: { code: 'PERSONA_CONSENT_OUTDATED' } });
    expect(prisma.persona.create).not.toHaveBeenCalled();
  });

  it('без согласия — 400', async () => {
    const { service } = build({ row: null });
    await expect(
      service.create('u1', { ...dto, consent: false }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('проверенная персона есть — 409 (одна на аккаунт)', async () => {
    const { service } = build({
      row: persona({ livenessCheckedAt: new Date() }),
    });
    await expect(service.create('u1', dto)).rejects.toMatchObject({
      status: 409,
      response: { code: 'PERSONA_EXISTS' },
    });
  });

  it('закрыта по возрасту — 403, пересъёмкой не обойти', async () => {
    const { service } = build({
      row: persona({
        verifyResult: { status: 'refused', reasons: ['under-18'] },
      }),
    });
    await expect(service.create('u1', dto)).rejects.toMatchObject({
      status: 403,
      response: { code: 'PERSONA_UNDER_18' },
    });
  });

  it('непроверенная — та же строка, старые файлы удалены, новые ссылки', async () => {
    const { service, prisma, blob } = build({});
    const r = await service.create('u1', dto);
    expect(prisma.persona.create).not.toHaveBeenCalled();
    expect(r.personaId).toBe('p1');
    expect(blob.deleteMany).toHaveBeenCalledWith([
      'users/u1/personas/p1/selfie-n.jpg',
      'users/u1/personas/p1/liveness-n.webm',
    ]);
    expect(r.selfiePathname).not.toBe('users/u1/personas/p1/selfie-n.jpg');
  });
});

describe('PersonaService.verify', () => {
  it('успех: расход записан, возраст сохранён, базовый образ заведён; без генератора — failed', async () => {
    const h = build({});
    const r = await h.service.verify('u1');
    expect(r.status).toBe('ok');
    expect(r.ageMin).toBe(26);
    expect(r.ageMax).toBe(32);
    expect(h.aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'persona-verify', userId: 'u1' }),
    );
    expect(h.row!.livenessCheckedAt).toBeInstanceOf(Date);
    expect(h.prisma.personaLook.create).toHaveBeenCalledWith({
      data: { personaId: 'p1', label: '', isBase: true },
    });
    expect(h.prisma.personaLook.updateMany).toHaveBeenCalledWith({
      where: { id: 'look1', status: 'pending' },
      data: { status: 'failed', error: BASE_LOOK_GENERATOR_MISSING },
    });
    expect(r.baseLook?.isBase).toBe(true);
    // Проверенные байты — в серверные пути (CONTRACT5 п.1), клиентские — удалены.
    const [sp, sd, sm] = h.blob.uploadBuffer.mock.calls[0] as unknown as [
      string,
      Buffer,
      string,
    ];
    expect(sp).toMatch(
      /^users\/u1\/personas\/p1\/sources\/selfie-[0-9a-f]{24}\.jpg$/,
    );
    expect(sd.toString()).toBe('bytes');
    expect(sm).toBe('image/jpeg');
    expect(h.blob.uploadBuffer.mock.calls[1][0]).toMatch(
      /sources\/liveness-[0-9a-f]{24}\.webm$/,
    );
    expect(h.row!.selfiePathname).toBe(sp);
    expect(h.row!.livenessPathname).toBe(h.blob.uploadBuffer.mock.calls[1][0]);
    expect(h.blob.deleteMany).toHaveBeenCalledWith([
      'users/u1/personas/p1/selfie-n.jpg',
      'users/u1/personas/p1/liveness-n.webm',
    ]);
    expect(h.plans.assertCanSpendUser).toHaveBeenCalledWith('u1');
    // Возраст — не в JSON итога, только в своих колонках (§4.4).
    expect(JSON.stringify(h.row!.verifyResult)).not.toMatch(/age/i);
  });

  it('генератор F зарегистрирован — зовётся для базового образа', async () => {
    const gen = {
      generateLookImage: jest.fn(async () => undefined),
      quotaLeft: jest.fn(),
    };
    const h = build({ providers: { [PERSONA_LOOK_GENERATOR]: gen } });
    await h.service.verify('u1');
    expect(gen.generateLookImage).toHaveBeenCalledWith('look1', { base: true });
    expect(h.prisma.personaLook.updateMany).not.toHaveBeenCalled();
  });

  it('генератор упал — образ failed, проверка всё равно пройдена', async () => {
    const gen = {
      generateLookImage: jest.fn(async () => {
        throw new Error('boom');
      }),
      quotaLeft: jest.fn(),
    };
    const h = build({ providers: { [PERSONA_LOOK_GENERATOR]: gen } });
    const r = await h.service.verify('u1');
    expect(r.status).toBe('ok');
    expect(h.prisma.personaLook.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('ageMin < 18 — refused under-18, файлы удалены, возраст сохранён для блока', async () => {
    const h = build({
      modelText: JSON.stringify({ ...GOOD, ageMin: 15, ageMax: 19 }),
    });
    const r = await h.service.verify('u1');
    expect(r).toEqual({
      status: 'refused',
      reasons: ['under-18'],
      ageMin: 15,
      ageMax: 19,
    });
    expect(h.row!.livenessCheckedAt).toBeNull();
    expect(h.prisma.personaLook.create).not.toHaveBeenCalled();
    expect(h.blob.deleteMany).toHaveBeenCalled();
    // Повтор — без нового платного вызова.
    h.generateContent.mockClear();
    const again = await h.service.verify('u1');
    expect(again.reasons).toEqual(['under-18']);
    expect(h.generateContent).not.toHaveBeenCalled();
  });

  it('отказ за свет — оценка возраста не хранится (§4.4)', async () => {
    const h = build({
      modelText: JSON.stringify({ ...GOOD, quality: 'dark' }),
    });
    const r = await h.service.verify('u1');
    expect(r).toEqual({ status: 'refused', reasons: ['poor-quality'] });
    expect(h.row!.ageMin).toBeNull();
    expect(h.row!.ageMax).toBeNull();
  });

  it('модель недоступна — check-unavailable, файлы остаются для повтора', async () => {
    const h = build({ modelText: 'garbage' });
    const r = await h.service.verify('u1');
    expect(r.reasons).toEqual(['check-unavailable']);
    expect(h.blob.deleteMany).not.toHaveBeenCalled();
  });

  it('файл не загружен или больше потолка — 400 без вызова модели', async () => {
    const h = build({});
    h.blob.head.mockResolvedValueOnce(null as never);
    await expect(h.service.verify('u1')).rejects.toMatchObject({
      status: 400,
    });
    h.blob.head.mockResolvedValue({ url: 'u', size: 50 * 1024 * 1024 });
    await expect(h.service.verify('u1')).rejects.toMatchObject({
      status: 400,
    });
    expect(h.generateContent).not.toHaveBeenCalled();
  });

  it('уже проверена — тот же ответ без вызова модели', async () => {
    const h = build({
      row: persona({ livenessCheckedAt: new Date(), ageMin: 30, ageMax: 35 }),
    });
    const r = await h.service.verify('u1');
    expect(r.status).toBe('ok');
    expect(h.generateContent).not.toHaveBeenCalled();
  });

  it('гонка: вторая проверка не заводит второй базовый образ', async () => {
    const h = build({});
    h.prisma.persona.updateMany.mockResolvedValueOnce({ count: 0 });
    await h.service.verify('u1');
    expect(h.prisma.personaLook.create).not.toHaveBeenCalled();
  });

  it('нет персоны — 404', async () => {
    const h = build({ row: null });
    await expect(h.service.verify('u1')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('PersonaService.me', () => {
  it('без URL и путей селфи/ролика; квота без генератора — нули', async () => {
    const h = build({
      row: persona({ livenessCheckedAt: new Date(), ageMin: 30, ageMax: 35 }),
    });
    const r = await h.service.me('u1');
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/selfie|liveness/i);
    expect(r.persona).toMatchObject({ id: 'p1', verified: true, ageMin: 30 });
    expect(r.quota).toEqual({ dayLeft: 0, monthLeft: 0 });
  });

  it('нет персоны — persona: null', async () => {
    const h = build({ row: null });
    expect((await h.service.me('u1')).persona).toBeNull();
  });
});

describe('PersonaService.remove', () => {
  it('удаляет файлы источников, образов, скетчей, голос через UserVoicesService, строки последними', async () => {
    const voices = { remove: jest.fn(async () => undefined) };
    const shares = {
      publishedSharesWithPersona: jest.fn(async () => [
        { id: 's1', url: 'https://x/s1', sessionId: 'sess1' },
      ]),
    };
    const h = build({
      row: persona({ livenessCheckedAt: new Date() }),
      providers: {
        [UserVoicesService.name]: voices,
        [PERSONA_SHARES_LOOKUP]: shares,
      },
    });
    h.prisma.personaLook.findMany.mockResolvedValue([
      { id: 'l1', photoPathname: 'users/u1/personas/p1/looks/l1.png' },
      { id: 'l2', photoPathname: null, photoUrl: null },
    ]);
    h.prisma.imageSketch.findMany.mockResolvedValue([
      { id: 'sk1', pathname: 'sketches/u1/sk1.png' },
    ]);
    h.prisma.userVoice.findMany.mockResolvedValue([
      { id: 'v1', sampleUrl: null, resembleVoiceId: 'r1' },
    ]);
    h.blob.listByPrefix.mockResolvedValue({
      blobs: [{ pathname: 'users/u1/personas/p1/stray.png' }],
      cursor: null,
    } as never);

    const r = await h.service.remove('u1');
    expect(r).toEqual({
      publishedSharesWithPersona: [
        { id: 's1', url: 'https://x/s1', sessionId: 'sess1' },
      ],
    });
    expect(h.prisma.imageSketch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { targetType: 'persona-look', targetId: { in: ['l1', 'l2'] } },
      }),
    );
    const deleted = h.blob.deleteMany.mock.calls[0][0];
    expect(deleted).toEqual(
      expect.arrayContaining([
        'users/u1/personas/p1/selfie-n.jpg',
        'users/u1/personas/p1/liveness-n.webm',
        'users/u1/personas/p1/looks/l1.png',
        'sketches/u1/sk1.png',
        'users/u1/personas/p1/stray.png',
      ]),
    );
    expect(voices.remove).toHaveBeenCalledWith('u1', 'v1');
    expect(h.prisma.imageSketch.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['sk1'] } },
    });
    expect(h.prisma.persona.delete).toHaveBeenCalledWith({
      where: { id: 'p1' },
    });
    expect(h.blob.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      h.prisma.persona.delete.mock.invocationCallOrder[0],
    );
  });

  it('без сервиса голосов — строка и образец удаляются здесь; без помощника G — []', async () => {
    const h = build({});
    h.prisma.userVoice.findMany.mockResolvedValue([
      {
        id: 'v1',
        sampleUrl:
          'https://store.public.blob.vercel-storage.com/users/u1/voices/v1/sample.webm',
        resembleVoiceId: 'r1',
      },
    ]);
    const r = await h.service.remove('u1');
    expect(r.publishedSharesWithPersona).toEqual([]);
    expect(h.blob.deleteBlob).toHaveBeenCalledWith(
      'users/u1/voices/v1/sample.webm',
    );
    expect(h.prisma.userVoice.deleteMany).toHaveBeenCalledWith({
      where: { id: 'v1' },
    });
  });
});

describe('PersonaService.purgeExpiredSources (В-3)', () => {
  const now = new Date('2026-11-30T00:00:00Z');
  type Where = Record<string, unknown>;
  const src = (id: string, over: Row = {}) => ({
    id,
    userId: 'u1',
    selfiePathname: `${id}.jpg`,
    livenessPathname: `${id}.webm`,
    revokedAt: null,
    verifyResult: null,
    ...over,
  });
  /** Проход по where (первое звено AND) — выдаёт строки только своему проходу. */
  function byPass(h: ReturnType<typeof build>, pass: Record<string, Row[]>) {
    h.prisma.persona.findMany.mockImplementation((async (args: {
      where: Where;
      take: number;
    }) => {
      const w = (
        args.where.AND ? (args.where.AND as Where[])[0] : args.where
      ) as Where;
      const gt = args.where.AND
        ? ((args.where.AND as Where[])[1].id as { gt: string }).gt
        : null;
      const key =
        w.sourcesPurgedAt === null
          ? 'verified'
          : w.consentGivenAt
            ? 'abandoned'
            : 'revoked';
      return (pass[key] ?? [])
        .filter((r) => !gt || (r.id as string) > gt)
        .slice(0, args.take);
    }) as never);
  }

  it('проверенные: граница 30 дней, «ни одного образа новее», не отозванные; ставит sourcesPurgedAt', async () => {
    const h = build({});
    byPass(h, { verified: [src('p1')] });
    const r = await h.service.purgeExpiredSources(now);
    expect(r).toMatchObject({ purged: 1, abandoned: 0, erased: 0, failed: 0 });
    const args = h.prisma.persona.findMany.mock.calls[0][0] as unknown as {
      where: Where;
      orderBy: unknown;
    };
    const cutoff = new Date('2026-10-31T00:00:00Z');
    expect(args.where.livenessCheckedAt).toEqual({ not: null, lt: cutoff });
    expect(args.where.sourcesPurgedAt).toBeNull();
    expect(args.where.revokedAt).toBeNull();
    expect(args.where.looks).toEqual({ none: { createdAt: { gte: cutoff } } });
    expect(args.orderBy).toEqual({ id: 'asc' });
    expect(h.blob.deleteMany).toHaveBeenCalledWith(['p1.jpg', 'p1.webm']);
    expect(h.prisma.persona.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: {
        selfiePathname: null,
        livenessPathname: null,
        sourcesPurgedAt: now,
      },
    });
  });

  it('хранилище не приняло — путь не обнуляется, следующая строка всё равно обрабатывается', async () => {
    const h = build({});
    byPass(h, { verified: [src('p1'), src('p2')] });
    h.blob.deleteMany.mockResolvedValueOnce(0);
    const r = await h.service.purgeExpiredSources(now);
    expect(r).toMatchObject({ purged: 1, failed: 1 });
    expect(h.prisma.persona.update).toHaveBeenCalledTimes(1);
    expect(h.prisma.persona.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p2' } }),
    );
  });

  it('полная выборка — следующая берётся курсором по id, упавшие не повторяются', async () => {
    const h = build({});
    const many = Array.from({ length: PERSONA_RETENTION_BATCH + 3 }, (_, i) =>
      src(`p${String(i).padStart(4, '0')}`),
    );
    byPass(h, { verified: many });
    h.blob.deleteMany.mockResolvedValue(0); // все падают
    const r = await h.service.purgeExpiredSources(now);
    expect(r.failed).toBe(PERSONA_RETENTION_BATCH + 3);
    const second = h.prisma.persona.findMany.mock.calls[1][0] as unknown as {
      where: { AND: Where[] };
    };
    expect(second.where.AND[1]).toEqual({
      id: { gt: many[PERSONA_RETENTION_BATCH - 1].id },
    });
  });

  it('незавершённые попытки старше суток — файлы удалены, пути обнулены', async () => {
    const h = build({});
    byPass(h, { abandoned: [src('p2', { livenessPathname: null })] });
    const r = await h.service.purgeExpiredSources(now);
    expect(r).toMatchObject({ purged: 0, abandoned: 1, failed: 0 });
    const w = (
      h.prisma.persona.findMany.mock.calls[1][0] as unknown as { where: Where }
    ).where;
    expect(w.livenessCheckedAt).toBeNull();
    expect(w.revokedAt).toBeNull();
    expect(w.consentGivenAt).toEqual({ lt: new Date('2026-11-29T00:00:00Z') });
    expect(h.blob.deleteMany).toHaveBeenCalledWith(['p2.jpg']);
    expect(h.prisma.persona.update).toHaveBeenCalledWith({
      where: { id: 'p2' },
      data: { selfiePathname: null, livenessPathname: null },
    });
  });

  it('отозванные: недоудалённая персона дочищается целиком, надгробие 18 — только файлы', async () => {
    const h = build({
      row: persona({ revokedAt: new Date(), livenessCheckedAt: new Date() }),
    });
    byPass(h, {
      revoked: [
        src('p1', { revokedAt: new Date() }),
        src('p9', {
          revokedAt: new Date(),
          verifyResult: { status: 'refused', refusals: ['under-18'] },
        }),
      ],
    });
    const r = await h.service.purgeExpiredSources(now);
    expect(r.erased).toBe(2);
    expect(h.prisma.persona.delete).toHaveBeenCalledTimes(1);
    expect(h.prisma.persona.delete).toHaveBeenCalledWith({
      where: { id: 'p1' },
    });
    expect(h.prisma.persona.update).toHaveBeenCalledWith({
      where: { id: 'p9' },
      data: {
        selfiePathname: null,
        livenessPathname: null,
        sourcesPurgedAt: now,
      },
    });
  });

  it('список ожидания Resemble повторяется', async () => {
    const resemble = {
      retryPendingDeletes: jest.fn(async () => ({
        retried: 2,
        deleted: 1,
        stillFailing: 1,
      })),
    };
    const h = build({ providers: { ResembleService: resemble } });
    byPass(h, {});
    const r = await h.service.purgeExpiredSources(now);
    expect(r.resembleRetried).toBe(2);
  });
});

describe('PersonaService.regenerateBase (§4.1 п.4)', () => {
  const verified = () =>
    persona({ livenessCheckedAt: new Date(), ageMin: 30, ageMax: 35 });
  const baseLook = (over: Row = {}) => ({
    id: 'look1',
    personaId: 'p1',
    isBase: true,
    status: 'ready',
    deletedAt: null,
    ...over,
  });
  const gen = () => ({
    generateLookImage: jest.fn(async () => undefined),
    quotaLeft: jest.fn(),
  });

  it('базовый: строка в pending, генератор F с base:true, ответ — свежий образ', async () => {
    const g = gen();
    const h = build({
      row: verified(),
      providers: { [PERSONA_LOOK_GENERATOR]: g },
    });
    h.prisma.personaLook.findFirst.mockResolvedValueOnce(baseLook() as never);
    const r = await h.service.regenerateBase('u1', 'look1');
    expect(h.prisma.personaLook.updateMany).toHaveBeenCalledWith({
      where: { id: 'look1', status: { not: 'pending' } },
      data: { status: 'pending', error: null },
    });
    expect(g.generateLookImage).toHaveBeenCalledWith('look1', { base: true });
    expect(h.aiUsage.countToday).toHaveBeenCalledWith(
      'u1',
      'persona-look-base',
    );
    expect(r).toMatchObject({ id: 'look1', status: 'ready' });
  });

  it('не базовый — 400; чужой/удалённый — 404', async () => {
    const h = build({ row: verified() });
    h.prisma.personaLook.findFirst.mockResolvedValueOnce(
      baseLook({ isBase: false }) as never,
    );
    await expect(h.service.regenerateBase('u1', 'look1')).rejects.toMatchObject(
      { status: 400 },
    );
    h.prisma.personaLook.findFirst.mockResolvedValueOnce(null as never);
    await expect(h.service.regenerateBase('u1', 'x')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('селфи удалено по сроку — 409 PERSONA_SOURCES_PURGED, генерации нет', async () => {
    const g = gen();
    const h = build({
      row: persona({
        livenessCheckedAt: new Date(),
        sourcesPurgedAt: new Date(),
        selfiePathname: null,
      }),
      providers: { [PERSONA_LOOK_GENERATOR]: g },
    });
    h.prisma.personaLook.findFirst.mockResolvedValueOnce(baseLook() as never);
    await expect(h.service.regenerateBase('u1', 'look1')).rejects.toMatchObject(
      { status: 409, response: { code: 'PERSONA_SOURCES_PURGED' } },
    );
    expect(g.generateLookImage).not.toHaveBeenCalled();
  });

  it('суточный потолок базовых генераций — 429, генерации нет', async () => {
    const g = gen();
    const h = build({
      row: verified(),
      providers: { [PERSONA_LOOK_GENERATOR]: g },
    });
    h.prisma.personaLook.findFirst.mockResolvedValueOnce(baseLook() as never);
    h.aiUsage.countToday.mockResolvedValueOnce(6);
    await expect(h.service.regenerateBase('u1', 'look1')).rejects.toMatchObject(
      { status: 429 },
    );
    expect(g.generateLookImage).not.toHaveBeenCalled();
    // На единицу ниже потолка — можно.
    h.prisma.personaLook.findFirst.mockResolvedValueOnce(baseLook() as never);
    h.aiUsage.countToday.mockResolvedValueOnce(5);
    await h.service.regenerateBase('u1', 'look1');
    expect(g.generateLookImage).toHaveBeenCalledTimes(1);
  });

  it('уже создаётся (или гонка) — 409, генерации нет', async () => {
    const g = gen();
    const h = build({
      row: verified(),
      providers: { [PERSONA_LOOK_GENERATOR]: g },
    });
    h.prisma.personaLook.findFirst.mockResolvedValueOnce(
      baseLook({ status: 'pending' }) as never,
    );
    await expect(h.service.regenerateBase('u1', 'look1')).rejects.toMatchObject(
      { status: 409 },
    );
    h.prisma.personaLook.findFirst.mockResolvedValueOnce(baseLook() as never);
    h.prisma.personaLook.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(h.service.regenerateBase('u1', 'look1')).rejects.toMatchObject(
      { status: 409 },
    );
    expect(g.generateLookImage).not.toHaveBeenCalled();
  });

  it('не проверена — 403', async () => {
    const h = build({});
    await expect(h.service.regenerateBase('u1', 'look1')).rejects.toMatchObject(
      { status: 403 },
    );
  });
});

describe('Волна исправлений (CONTRACT5)', () => {
  it('п.3: отказ 18 — надгробие: revokedAt, файлы удалены; POST /personas → 403; /me показывает отказ; DELETE строку не удаляет', async () => {
    const h = build({
      modelText: JSON.stringify({ ...GOOD, ageMin: 15, ageMax: 19 }),
    });
    const r = await h.service.verify('u1');
    expect(r.reasons).toEqual(['under-18']);
    expect(h.row!.revokedAt).toBeInstanceOf(Date);
    expect(h.row!.selfiePathname).toBeNull();
    expect((h.row!.verifyResult as { refusals: string[] }).refusals).toEqual([
      'under-18',
    ]);
    await expect(
      h.service.create('u1', {
        consent: true,
        consentTextVersion: PERSONA_CONSENT_VERSION,
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'PERSONA_UNDER_18' },
    });
    const me = await h.service.me('u1');
    expect(me.persona?.refusals).toEqual(['under-18']);
    expect(me.persona?.verified).toBe(false);
    const del = await h.service.remove('u1');
    expect(del.publishedSharesWithPersona).toEqual([]);
    expect(h.prisma.persona.delete).not.toHaveBeenCalled();
    // Повтор проверки — без платного вызова.
    h.generateContent.mockClear();
    expect((await h.service.verify('u1')).reasons).toEqual(['under-18']);
    expect(h.generateContent).not.toHaveBeenCalled();
  });

  it('п.7: хранилище приняло не все файлы — 503, строка остаётся отозванной', async () => {
    const h = build({ row: persona({ livenessCheckedAt: new Date() }) });
    h.blob.deleteMany.mockResolvedValueOnce(1);
    await expect(h.service.remove('u1')).rejects.toMatchObject({
      status: 503,
      response: { code: 'PERSONA_DELETE_INCOMPLETE' },
    });
    expect(h.prisma.persona.delete).not.toHaveBeenCalled();
    expect(h.row!.revokedAt).toBeInstanceOf(Date);
    // Пока удаление не завершено — новая попытка не заводится.
    await expect(
      h.service.create('u1', {
        consent: true,
        consentTextVersion: PERSONA_CONSENT_VERSION,
      }),
    ).rejects.toMatchObject({ response: { code: 'PERSONA_DELETE_PENDING' } });
    // Повторный DELETE дочищает.
    await h.service.remove('u1');
    expect(h.prisma.persona.delete).toHaveBeenCalled();
  });

  it('п.7: листинг префикса не удался — удаление не завершено', async () => {
    const h = build({ row: persona({ livenessCheckedAt: new Date() }) });
    h.blob.listByPrefix.mockRejectedValueOnce(new Error('down') as never);
    await expect(h.service.remove('u1')).rejects.toMatchObject({
      status: 503,
    });
    expect(h.prisma.persona.delete).not.toHaveBeenCalled();
  });

  it('п.11: лимит трат аккаунта — до платного вызова (verify) и до генерации (regenerate)', async () => {
    const h = build({});
    h.plans.assertCanSpendUser.mockRejectedValueOnce(
      Object.assign(new Error('limit'), { status: 429 }) as never,
    );
    await expect(h.service.verify('u1')).rejects.toThrow('limit');
    expect(h.generateContent).not.toHaveBeenCalled();

    const g = {
      generateLookImage: jest.fn(async () => undefined),
      quotaLeft: jest.fn(),
    };
    const h2 = build({
      row: persona({ livenessCheckedAt: new Date() }),
      providers: { [PERSONA_LOOK_GENERATOR]: g },
    });
    h2.prisma.personaLook.findFirst.mockResolvedValueOnce({
      id: 'look1',
      isBase: true,
      status: 'ready',
    } as never);
    h2.plans.assertCanSpendUser.mockRejectedValueOnce(
      new Error('limit') as never,
    );
    await expect(h2.service.regenerateBase('u1', 'look1')).rejects.toThrow(
      'limit',
    );
    expect(g.generateLookImage).not.toHaveBeenCalled();
  });

  it('п.11: базовый образ при проверке входит в суточный потолок базовых', async () => {
    const g = {
      generateLookImage: jest.fn(async () => undefined),
      quotaLeft: jest.fn(),
    };
    const h = build({ providers: { [PERSONA_LOOK_GENERATOR]: g } });
    h.aiUsage.countToday.mockResolvedValueOnce(6);
    const r = await h.service.verify('u1');
    expect(r.status).toBe('ok');
    expect(g.generateLookImage).not.toHaveBeenCalled();
    expect(h.prisma.personaLook.updateMany).toHaveBeenCalledWith({
      where: { id: 'look1', status: 'pending' },
      data: { status: 'failed', error: expect.stringMatching(/завтра/) },
    });
  });

  it('п.1: копия не записалась — 503, проверка не засчитана', async () => {
    const h = build({});
    h.blob.uploadBuffer.mockRejectedValueOnce(new Error('down') as never);
    await expect(h.service.verify('u1')).rejects.toMatchObject({
      status: 503,
    });
    expect(h.row!.livenessCheckedAt).toBeNull();
    expect(h.row!.selfiePathname).toBe('users/u1/personas/p1/selfie-n.jpg');
    expect(h.prisma.personaLook.create).not.toHaveBeenCalled();
  });

  it('п.1: гонка проиграна — свои серверные копии удаляются, клиентские не трогаются', async () => {
    const h = build({});
    h.prisma.persona.updateMany.mockResolvedValueOnce({ count: 0 });
    await h.service.verify('u1');
    const deleted = h.blob.deleteMany.mock.calls[0][0] as string[];
    expect(deleted.every((p) => p.includes('/sources/'))).toBe(true);
  });

  it('статус голоса персоны — нижний регистр', async () => {
    const h = build({ row: persona({ livenessCheckedAt: new Date() }) });
    h.prisma.userVoice.findFirst.mockResolvedValueOnce({
      id: 'v1',
      status: 'READY',
    } as never);
    expect((await h.service.me('u1')).voice).toEqual({
      id: 'v1',
      status: 'ready',
    });
  });

  it('п.15: без UserVoicesService клон удаляется у Resemble здесь же', async () => {
    const resemble = { deleteVoice: jest.fn(async () => 'failed') };
    const h = build({
      row: persona({ livenessCheckedAt: new Date() }),
      providers: { ResembleService: resemble },
    });
    h.prisma.userVoice.findMany.mockResolvedValue([
      { id: 'v1', sampleUrl: null, resembleVoiceId: 'r1' },
    ] as never);
    await h.service.remove('u1');
    expect(resemble.deleteVoice).toHaveBeenCalledWith('r1');
    expect(h.prisma.userVoice.deleteMany).toHaveBeenCalledWith({
      where: { id: 'v1' },
    });
  });
});

describe('Аудит проверки: голос, гонка verify/delete, крон надгробий', () => {
  it('образец голоса персоны (вне префикса) — в общем наборе файлов; сбой — 503, строки голоса целы', async () => {
    const voices = { remove: jest.fn(async () => undefined) };
    const h = build({
      row: persona({ livenessCheckedAt: new Date() }),
      providers: { [UserVoicesService.name]: voices },
    });
    h.prisma.userVoice.findMany.mockResolvedValue([
      {
        id: 'v1',
        sampleUrl:
          'https://store.public.blob.vercel-storage.com/users/u1/voices/v1/sample.webm',
        resembleVoiceId: 'r1',
      },
    ] as never);
    h.blob.listByPrefix.mockImplementation((async (prefix: string) =>
      prefix === 'users/u1/voices/v1/'
        ? {
            blobs: [{ pathname: 'users/u1/voices/v1/extra.bin' }],
            cursor: null,
          }
        : { blobs: [], cursor: null }) as never);
    h.blob.deleteMany.mockResolvedValueOnce(0);
    await expect(h.service.remove('u1')).rejects.toMatchObject({
      status: 503,
      response: { code: 'PERSONA_DELETE_INCOMPLETE' },
    });
    const sent = h.blob.deleteMany.mock.calls[0][0] as string[];
    expect(sent).toEqual(
      expect.arrayContaining([
        'users/u1/voices/v1/sample.webm',
        'users/u1/voices/v1/extra.bin',
      ]),
    );
    // Строки голоса не тронуты — повтор знает, где образец.
    expect(voices.remove).not.toHaveBeenCalled();
    expect(h.prisma.persona.delete).not.toHaveBeenCalled();
    // Повтор проходит: файлы, затем голос, затем строка.
    await h.service.remove('u1');
    expect(voices.remove).toHaveBeenCalledWith('u1', 'v1');
    expect(h.blob.deleteMany.mock.invocationCallOrder[1]).toBeLessThan(
      voices.remove.mock.invocationCallOrder[0],
    );
  });

  it('листинг папки голоса не удался — удаление не завершено', async () => {
    const h = build({ row: persona({ livenessCheckedAt: new Date() }) });
    h.prisma.userVoice.findMany.mockResolvedValue([
      { id: 'v1', sampleUrl: null, resembleVoiceId: null },
    ] as never);
    h.blob.listByPrefix.mockRejectedValueOnce(new Error('down') as never);
    await expect(h.service.remove('u1')).rejects.toMatchObject({
      status: 503,
    });
  });

  it('гонка verify/DELETE: claim требует revokedAt: null; проиграл — копии удалены, 404', async () => {
    const h = build({});
    h.prisma.persona.updateMany.mockResolvedValueOnce({ count: 0 });
    h.prisma.persona.findUnique
      .mockResolvedValueOnce(persona() as never) // verify: строка
      .mockResolvedValueOnce(persona() as never) // requirePersona
      .mockResolvedValueOnce(persona({ revokedAt: new Date() }) as never);
    await expect(h.service.verify('u1')).rejects.toMatchObject({
      status: 404,
    });
    const where = (
      h.prisma.persona.updateMany.mock.calls[0][0] as unknown as {
        where: Row;
      }
    ).where;
    expect(where).toEqual({
      id: 'p1',
      livenessCheckedAt: null,
      revokedAt: null,
    });
    const deleted = h.blob.deleteMany.mock.calls[0][0] as string[];
    expect(deleted.every((p) => p.includes('/sources/'))).toBe(true);
    expect(h.prisma.persona.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(h.prisma.personaLook.create).not.toHaveBeenCalled();
  });

  it('крон: дочищенные надгробия исключены из выборки отозванных', async () => {
    const h = build({});
    await h.service.purgeExpiredSources(new Date('2026-11-30T00:00:00Z'));
    const third = h.prisma.persona.findMany.mock.calls[2][0] as unknown as {
      where: Row;
    };
    expect(third.where).toEqual({
      revokedAt: { not: null },
      NOT: {
        livenessCheckedAt: null,
        sourcesPurgedAt: { not: null },
        selfiePathname: null,
        livenessPathname: null,
      },
    });
  });

  it('надгробие при отказе помечается дочищенным (sourcesPurgedAt)', async () => {
    const h = build({
      modelText: JSON.stringify({ ...GOOD, ageMin: 15, ageMax: 19 }),
    });
    await h.service.verify('u1');
    expect(h.row!.sourcesPurgedAt).toBeInstanceOf(Date);
    expect(h.row!.livenessCheckedAt).toBeNull();
  });
});
