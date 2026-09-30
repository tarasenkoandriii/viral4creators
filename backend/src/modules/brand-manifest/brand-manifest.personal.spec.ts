/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Этап G ТЗ Greeting 2.0 §4.7: личный бренд-бук (kind PERSONAL), образ по
 * умолчанию, подпись, тон и стиль карточек.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));
jest.mock('@vercel/blob', () => ({
  head: jest.fn().mockResolvedValue({ url: 'https://blob.test/head-url' }),
}));

import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { PERSONA_VOICE_ONLY_PERSONAL } from '../../common/greeting-persona';
import {
  BrandManifestService,
  DEFAULT_LOOK_NOT_FOUND,
  DEFAULT_LOOK_ONLY_PERSONAL,
  KIND_IMMUTABLE,
  PERSONAL_NEEDS_PERSONA,
  manifestDataFromDto,
  toManifestView,
  toSummaryView,
} from './brand-manifest.service';

const NOW = new Date('2026-09-30T12:00:00.000Z');
/** Проверенная персона без отказа (CONTRACT5 п.13). */
const VERIFIED = {
  id: 'p1',
  livenessCheckedAt: NOW,
  revokedAt: null,
  verifyResult: { status: 'ok' },
};
const USER = 'u1';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'bm1',
  title: 'Я',
  styleNotes: null,
  filters: null,
  effects: null,
  createdAt: NOW,
  updatedAt: NOW,
  characters: [],
  _count: { projects: 0 },
  ...over,
});

function build() {
  const prisma = {
    brandManifest: {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve(row(data))),
      findFirst: jest.fn().mockResolvedValue(row()),
      update: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve(row(data))),
    },
    persona: { findFirst: jest.fn().mockResolvedValue(VERIFIED) },
    personaLook: { findFirst: jest.fn().mockResolvedValue({ id: 'l1' }) },
    userVoice: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const plans = { assertUser: jest.fn().mockResolvedValue(undefined) };
  const tts = {
    resolve: jest.fn().mockResolvedValue({ providerKey: 'elevenlabs' }),
  };
  const svc = new BrandManifestService(
    prisma as any,
    {} as any,
    plans as any,
    tts as any,
    {} as any,
  );
  return { svc, prisma, plans };
}

const OLD_FLAG = process.env.PERSONA_ENABLED;
beforeEach(() => {
  process.env.PERSONA_ENABLED = 'true';
});
afterAll(() => {
  process.env.PERSONA_ENABLED = OLD_FLAG;
});

describe('личный бренд-бук — создание', () => {
  it('PERSONAL: персона ставится сервером, тариф — personalBrand, образ проверен', async () => {
    const { svc, prisma, plans } = build();
    const view = await svc.create(USER, {
      title: 'Я',
      kind: 'PERSONAL',
      defaultLookId: 'l1',
    });
    expect(plans.assertUser).toHaveBeenCalledWith(USER, 'personalBrand');
    expect(plans.assertUser).not.toHaveBeenCalledWith(USER, 'brandManifest');
    expect(prisma.persona.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, revokedAt: null } }),
    );
    expect(prisma.personaLook.findFirst).toHaveBeenCalledWith({
      where: { id: 'l1', personaId: 'p1', deletedAt: null },
      select: { id: true },
    });
    const data = prisma.brandManifest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      kind: 'PERSONAL',
      personaId: 'p1',
      defaultLookId: 'l1',
    });
    expect(view.kind).toBe('PERSONAL');
    expect(view.defaultLookId).toBe('l1');
  });

  it('режим выключен — 404 PERSONA_DISABLED раньше тарифа и записи', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { svc, prisma, plans } = build();
    const err = await svc
      .create(USER, { title: 'Я', kind: 'PERSONAL' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.getResponse()).toMatchObject({ code: 'PERSONA_DISABLED' });
    expect(plans.assertUser).not.toHaveBeenCalled();
    expect(prisma.brandManifest.create).not.toHaveBeenCalled();
  });

  it('нет персоны — 400 с подсказкой', async () => {
    const { svc, prisma } = build();
    prisma.persona.findFirst.mockResolvedValue(null);
    await expect(
      svc.create(USER, { title: 'Я', kind: 'PERSONAL' }),
    ).rejects.toThrow(PERSONAL_NEEDS_PERSONA);
    expect(prisma.brandManifest.create).not.toHaveBeenCalled();
  });

  it('чужой или удалённый образ — отказ', async () => {
    const { svc, prisma } = build();
    prisma.personaLook.findFirst.mockResolvedValue(null);
    await expect(
      svc.create(USER, { title: 'Я', kind: 'PERSONAL', defaultLookId: 'x' }),
    ).rejects.toThrow(DEFAULT_LOOK_NOT_FOUND);
  });

  it('корпоративный: образ по умолчанию нельзя; тариф — brandManifest', async () => {
    const { svc, plans } = build();
    await expect(
      svc.create(USER, { title: 'Co', defaultLookId: 'l1' }),
    ).rejects.toThrow(DEFAULT_LOOK_ONLY_PERSONAL);
    await svc.create(USER, { title: 'Co' });
    expect(plans.assertUser).toHaveBeenCalledWith(USER, 'brandManifest');
  });

  it('корпоративный создаётся и при выключенном режиме', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { svc, prisma } = build();
    await svc.create(USER, { title: 'Co', kind: 'COMPANY' });
    expect(prisma.brandManifest.create).toHaveBeenCalled();
    expect(prisma.persona.findFirst).not.toHaveBeenCalled();
  });
});

describe('личный бренд-бук — правка', () => {
  it('вид не меняется: COMPANY → PERSONAL и обратно — 400; тот же вид — можно', async () => {
    const { svc, prisma } = build();
    await expect(svc.update(USER, 'bm1', { kind: 'PERSONAL' })).rejects.toThrow(
      KIND_IMMUTABLE,
    );
    prisma.brandManifest.findFirst.mockResolvedValue(row({ kind: 'PERSONAL' }));
    await expect(svc.update(USER, 'bm1', { kind: 'COMPANY' })).rejects.toThrow(
      KIND_IMMUTABLE,
    );
    await svc.update(USER, 'bm1', { kind: 'PERSONAL', title: 'Я 2' });
    // Вид в запись не попадает вовсе — только то, что правится.
    expect(prisma.brandManifest.update.mock.calls[0][0].data).toEqual({
      title: 'Я 2',
    });
  });

  it('образ по умолчанию: только у личного, свой; привязка к текущей персоне', async () => {
    const { svc, prisma } = build();
    await expect(
      svc.update(USER, 'bm1', { defaultLookId: 'l1' }),
    ).rejects.toThrow(DEFAULT_LOOK_ONLY_PERSONAL);
    prisma.brandManifest.findFirst.mockResolvedValue(
      row({ kind: 'PERSONAL', personaId: null }),
    );
    await svc.update(USER, 'bm1', { defaultLookId: 'l1' });
    expect(prisma.brandManifest.update.mock.calls[0][0].data).toMatchObject({
      defaultLookId: 'l1',
      personaId: 'p1',
    });
    // Сброс образа не требует персоны и режима.
    process.env.PERSONA_ENABLED = 'false';
    await svc.update(USER, 'bm1', { defaultLookId: null });
    expect(prisma.brandManifest.update.mock.calls[1][0].data).toEqual({
      defaultLookId: null,
    });
  });

  it('образ по умолчанию при выключенном режиме — 404', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { svc, prisma } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(row({ kind: 'PERSONAL' }));
    await expect(
      svc.update(USER, 'bm1', { defaultLookId: 'l1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('manifestDataFromDto — подпись, тон, стиль карточек (Г-6)', () => {
  it('подпись обрезается, пустая — null; стиль — только белый список; null → DbNull', () => {
    expect(
      manifestDataFromDto(
        {
          signature: '  Мама  ',
          defaultTone: 'WARM',
          cardStyle: { font: 'serif', color: 'gold' },
        },
        'elevenlabs',
      ),
    ).toEqual({
      signature: 'Мама',
      defaultTone: 'WARM',
      cardStyle: { font: 'serif', color: 'gold' },
    });
    expect(
      manifestDataFromDto(
        { signature: '   ', defaultTone: null, cardStyle: null },
        'elevenlabs',
      ),
    ).toEqual({
      signature: null,
      defaultTone: null,
      cardStyle: Prisma.DbNull,
    });
    // Ключ вне белого списка (обошёл DTO) — не пишется как есть.
    expect(
      manifestDataFromDto(
        { cardStyle: { font: 'Comic Sans', color: '#000' } as any },
        'elevenlabs',
      ),
    ).toEqual({ cardStyle: Prisma.DbNull });
  });

  it('kind и defaultLookId чистая функция не пишет — это решает сервис', () => {
    expect(
      manifestDataFromDto(
        { kind: 'PERSONAL', defaultLookId: 'l1' } as any,
        'elevenlabs',
      ),
    ).toEqual({});
  });
});

describe('представление', () => {
  it('новые поля в ответе; старые строки — COMPANY без стиля', () => {
    expect(toManifestView(row() as any)).toMatchObject({
      kind: 'COMPANY',
      defaultLookId: null,
      signature: null,
      defaultTone: null,
      cardStyle: null,
    });
    expect(
      toManifestView(
        row({
          kind: 'PERSONAL',
          defaultLookId: 'l1',
          signature: 'Мама',
          defaultTone: 'NOPE',
          cardStyle: { font: 'mono', color: 'mint' },
        }) as any,
      ),
    ).toMatchObject({
      kind: 'PERSONAL',
      defaultLookId: 'l1',
      signature: 'Мама',
      defaultTone: null,
      cardStyle: { font: 'mono', color: 'mint' },
    });
    expect(toSummaryView(row({ kind: 'PERSONAL' }) as any).kind).toBe(
      'PERSONAL',
    );
  });
});

describe('CONTRACT5 п.13 — только проверенная персона без отказа', () => {
  it.each([
    ['не проверена', { ...VERIFIED, livenessCheckedAt: null }],
    [
      'отказ проверки',
      {
        ...VERIFIED,
        verifyResult: { status: 'refused', refusals: ['screen'] },
      },
    ],
    [
      'младше 18',
      {
        ...VERIFIED,
        verifyResult: { status: 'refused', refusals: ['under-18'] },
      },
    ],
  ])('%s — 400, бренд-бук не создаётся', async (_n, persona) => {
    const { svc, prisma } = build();
    prisma.persona.findFirst.mockResolvedValue(persona);
    await expect(
      svc.create(USER, { title: 'Я', kind: 'PERSONAL' }),
    ).rejects.toThrow(PERSONAL_NEEDS_PERSONA);
    expect(prisma.brandManifest.create).not.toHaveBeenCalled();
  });
});

describe('CONTRACT5 п.5а — голос персоны только в личном бренд-буке', () => {
  const personaVoice = (prisma: any) =>
    prisma.userVoice.findFirst.mockImplementation(async (args: any) =>
      args?.where?.personaId ? { id: 'uv-persona' } : null,
    );

  it('корпоративный с голосом персоны — 400 и при создании, и при правке', async () => {
    const { svc, prisma } = build();
    personaVoice(prisma);
    await expect(
      svc.create(USER, { title: 'Co', ttsVoiceId: 'rv-persona' }),
    ).rejects.toThrow(PERSONA_VOICE_ONLY_PERSONAL);
    await expect(
      svc.update(USER, 'bm1', { ttsVoiceId: 'rv-persona' }),
    ).rejects.toThrow(PERSONA_VOICE_ONLY_PERSONAL);
    expect(prisma.brandManifest.create).not.toHaveBeenCalled();
    expect(prisma.brandManifest.update).not.toHaveBeenCalled();
  });

  it('личный с голосом персоны — можно', async () => {
    const { svc, prisma } = build();
    personaVoice(prisma);
    prisma.brandManifest.findFirst.mockResolvedValue(row({ kind: 'PERSONAL' }));
    await svc.update(USER, 'bm1', { ttsVoiceId: 'rv-persona' });
    expect(prisma.brandManifest.update).toHaveBeenCalled();
  });

  it('обычный клон в корпоративном — как раньше', async () => {
    const { svc, prisma } = build();
    await svc.update(USER, 'bm1', { ttsVoiceId: 'rv-plain' });
    expect(prisma.brandManifest.update).toHaveBeenCalled();
  });
});

describe('CONTRACT5 п.10 — лица на фото сцены бренд-бука', () => {
  const OLD_KEY = process.env.GEMINI_API_KEY;
  afterEach(() => {
    process.env.GEMINI_API_KEY = OLD_KEY;
  });
  function withScene(
    modelText: string | null,
    flag = 'true',
    photoUrl: string | null = null,
  ) {
    process.env.PERSONA_ENABLED = flag;
    const b = build();
    const scene = {
      id: 'bs1',
      brandManifestId: 'bm1',
      label: 'Офис',
      photoUrl,
      description: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    (b.prisma as any).brandScene = {
      findFirst: jest.fn().mockResolvedValue(scene),
      update: jest
        .fn()
        .mockImplementation(async ({ data }: any) => ({ ...scene, ...data })),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const blob = {
      downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('jpg')),
      uploadBuffer: jest.fn().mockImplementation(async (p: string) => ({
        url: `https://blob.test/${p}`,
      })),
      deleteBlob: jest.fn().mockResolvedValue(true),
    };
    (b.svc as any).blobService = blob;
    (b.svc as any).faceClient = {
      models: {
        generateContent: jest.fn().mockResolvedValue({ text: modelText }),
      },
    };
    return { ...b, blob };
  }
  const PATH = 'brand-manifests/bm1/scenes/bs1/photo.jpg';

  it('лица нет — сервер кладёт фото под путь с отметкой проверки, клиентский удаляет', async () => {
    const { svc, prisma, blob } = withScene('{"faces": 0}');
    const view = await svc.confirmScenePhoto(USER, 'bm1', 'bs1', {
      pathname: PATH,
    });
    const url = (prisma as any).brandScene.update.mock.calls[0][0].data
      .photoUrl;
    expect(url).toMatch(
      /^https:\/\/blob\.test\/brand-manifests\/bm1\/scenes\/bs1\/checked-[a-f0-9]+\.jpg$/,
    );
    expect(blob.deleteBlob).toHaveBeenCalledWith(PATH);
    expect(view.photoFaceChecked).toBe(true);
  });

  it.each([
    ['лицо есть', '{"faces": 1}'],
    ['проверка не ответила', 'мусор'],
  ])(
    '%s — фото остаётся непроверенным (в ролик только словами)',
    async (_n, text) => {
      const { svc, prisma, blob } = withScene(text);
      const view = await svc.confirmScenePhoto(USER, 'bm1', 'bs1', {
        pathname: PATH,
      });
      expect(
        (prisma as any).brandScene.update.mock.calls[0][0].data.photoUrl,
      ).toBe('https://blob.test/head-url');
      expect(blob.uploadBuffer).not.toHaveBeenCalled();
      expect(view.photoFaceChecked).toBe(false);
    },
  );

  it('режим выключен — проверки нет, как до волны', async () => {
    const { svc, blob } = withScene('{"faces": 0}', 'false');
    await svc.confirmScenePhoto(USER, 'bm1', 'bs1', { pathname: PATH });
    expect(blob.downloadBuffer).not.toHaveBeenCalled();
  });

  const CHECKED =
    'https://blob.test/brand-manifests/bm1/scenes/bs1/checked-aa11.jpg';

  it('удаление сцены удаляет серверный checked-файл, а не выдуманный photo.<ext> (аудит)', async () => {
    const { svc, blob } = withScene(null, 'true', CHECKED);
    await svc.removeScene(USER, 'bm1', 'bs1');
    expect(blob.deleteBlob).toHaveBeenCalledWith(
      'brand-manifests/bm1/scenes/bs1/checked-aa11.jpg',
    );
  });

  it('новое фото сцены удаляет прежний checked-файл', async () => {
    const { svc, blob } = withScene('{"faces": 0}', 'true', CHECKED);
    await svc.confirmScenePhoto(USER, 'bm1', 'bs1', { pathname: PATH });
    expect(blob.deleteBlob).toHaveBeenCalledWith(
      'brand-manifests/bm1/scenes/bs1/checked-aa11.jpg',
    );
  });

  it('прежний photo.<ext> при новом фото не трогается — его перезаписала загрузка', async () => {
    const { svc, blob } = withScene(
      '{"faces": 1}',
      'true',
      'https://blob.test/brand-manifests/bm1/scenes/bs1/photo.png',
    );
    await svc.confirmScenePhoto(USER, 'bm1', 'bs1', { pathname: PATH });
    expect(blob.deleteBlob).not.toHaveBeenCalled();
  });
});
