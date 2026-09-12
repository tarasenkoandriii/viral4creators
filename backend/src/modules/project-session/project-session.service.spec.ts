import { NotFoundException } from '@nestjs/common';
import {
  applySnapshotEdit,
  ProjectSessionService,
} from './project-session.service';
import { BrandManifestSnapshot } from '../../common/types/brand-manifest.types';
import type { SessionSeed } from '../../common/session.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({ Prisma: {} }));

const itemRow = {
  id: 'i1',
  projectId: 'p1',
  title: 'Размер 42',
  photoUrl:
    'https://s.public.blob.vercel-storage.com/projects/p1/items/i1/photo.jpg',
  description: 'Лёгкие беговые',
  category: 'кроссовки',
  price: '4799.00',
  project: {
    id: 'p1',
    title: 'Pegasus',
    currency: 'UAH',
    countryCode: 'UA',
    brandManifest: {
      id: 'bm1',
      title: 'Бренд',
      styleNotes: 'тёплые тона',
      filters: null,
      effects: null,
      characters: [
        { id: 'c1', label: 'Аня', photoUrl: null, description: 'рыжая' },
      ],
    },
  },
};

function build(overrides: { item?: unknown; sessionRows?: unknown[] } = {}) {
  const prisma = {
    productItem: {
      findFirst: jest
        .fn()
        .mockResolvedValue('item' in overrides ? overrides.item : itemRow),
    },
    session: {
      findMany: jest.fn().mockResolvedValue(overrides.sessionRows ?? []),
    },
    // Шестой аудит, Е-4.1: updateSnapshot проверяет, не свой ли это клон
    // на Resemble, прежде чем проставить ttsProvider — по умолчанию «нет
    // своего клона» (null), не влияет на тесты без userId/ttsVoiceId.
    userVoice: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const sessions = {
    createSession: jest.fn(async (userId: string, seed: SessionSeed) => ({
      sessionId: 's1',
      status: 'created',
      userId,
      ...seed,
    })),
    getSession: jest.fn(),
    updateSession: jest.fn(),
  };
  const tts = { resolve: jest.fn().mockResolvedValue({ providerKey: 'elevenlabs' }) };
  const plans = { assertUser: jest.fn().mockResolvedValue(undefined) };
  const service = new ProjectSessionService(
    prisma as never,
    sessions as never,
    tts as never,
    plans as never,
  );
  return { service, prisma, sessions, tts, plans };
}

describe('ProjectSessionService.createFromItem', () => {
  it('checks ownership through the parent project', async () => {
    const { service, prisma } = build();
    await service.createFromItem('u1', 'p1', 'i1');
    expect(prisma.productItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'i1', projectId: 'p1', project: { userId: 'u1' } },
      }),
    );
  });

  it('404s when the item is not the caller’s', async () => {
    const { service } = build({ item: null });
    await expect(service.createFromItem('u2', 'p1', 'i1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('seeds the session with product + manifest snapshots and the source ids', async () => {
    const { service, sessions } = build();
    await service.createFromItem('u1', 'p1', 'i1');
    expect(sessions.createSession).toHaveBeenCalledTimes(1);
    const [userId, seed] = sessions.createSession.mock.calls[0];
    expect(userId).toBe('u1');
    expect(seed.projectId).toBe('p1');
    expect(seed.productItemId).toBe('i1');
    expect(seed.productInformation).toMatchObject({
      productName: 'Размер 42',
      productDescription: 'Лёгкие беговые',
      productImagePathname: 'projects/p1/items/i1/photo.jpg',
      productImageMimeType: 'image/jpeg',
      price: 4799,
      currency: 'UAH',
    });
    expect(seed.brandManifestSnapshot).toMatchObject({
      brandManifestId: 'bm1',
      styleNotes: 'тёплые тона',
      characters: [
        { sourceCharacterId: 'c1', label: 'Аня', description: 'рыжая' },
      ],
      editedAt: null,
    });
  });

  it('omits the manifest snapshot when the project has none', async () => {
    const { service, sessions } = build({
      item: {
        ...itemRow,
        project: { ...itemRow.project, brandManifest: null },
      },
    });
    await service.createFromItem('u1', 'p1', 'i1');
    const seed = sessions.createSession.mock.calls[0][1];
    expect(seed.brandManifestSnapshot).toBeUndefined();
    expect(seed.productInformation?.productName).toBe('Размер 42');
  });
});

describe('ProjectSessionService.listForItem', () => {
  it('maps rows to summaries, newest first, with the video URL when present', async () => {
    const { service, prisma } = build({
      sessionRows: [
        {
          id: 's2',
          status: 'video_complete',
          createdAt: new Date('2026-09-05T10:00:00Z'),
          lastActivityAt: new Date('2026-09-05T10:05:00Z'),
          data: {
            generatedVideo: { downloadUrl: 'https://x.test/v.mp4' },
            brandManifestSnapshot: { brandManifestId: 'bm1' },
          },
        },
        {
          id: 's1',
          status: 'created',
          createdAt: new Date('2026-09-05T09:00:00Z'),
          lastActivityAt: new Date('2026-09-05T09:00:00Z'),
          data: {},
        },
      ],
    });
    const list = await service.listForItem('u1', 'p1', 'i1');
    expect(prisma.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productItemId: 'i1' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(list).toEqual([
      {
        sessionId: 's2',
        status: 'video_complete',
        createdAt: '2026-09-05T10:00:00.000Z',
        lastActivityAt: '2026-09-05T10:05:00.000Z',
        videoUrl: 'https://x.test/v.mp4',
        hasBrandManifest: true,
      },
      {
        sessionId: 's1',
        status: 'created',
        createdAt: '2026-09-05T09:00:00.000Z',
        lastActivityAt: '2026-09-05T09:00:00.000Z',
        videoUrl: null,
        hasBrandManifest: false,
      },
    ]);
  });

  it('404s for a foreign item before touching sessions', async () => {
    const { service, prisma } = build({ item: null });
    await expect(service.listForItem('u1', 'p1', 'i1')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.session.findMany).not.toHaveBeenCalled();
  });
});

describe('ProjectSessionService.updateSnapshot', () => {
  const snapshot: BrandManifestSnapshot = {
    brandManifestId: 'bm1',
    title: 'Бренд',
    styleNotes: 'old',
    voiceNotes: null,
    filters: { a: 1 },
    effects: null,
    characters: [
      {
        sourceCharacterId: 'c1',
        label: 'Аня',
        photoUrl: null,
        description: null,
      },
    ],
    snapshotAt: '2026-09-05T10:00:00.000Z',
    editedAt: null,
  };

  it('404s when the session is missing or has no snapshot', async () => {
    const { service, sessions } = build();
    sessions.getSession.mockResolvedValueOnce(undefined);
    await expect(service.updateSnapshot('s0', {})).rejects.toThrow(
      NotFoundException,
    );
    sessions.getSession.mockResolvedValueOnce({ sessionId: 's1' });
    await expect(service.updateSnapshot('s1', {})).rejects.toThrow(
      /no brand manifest snapshot/,
    );
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('merges the edit into the session copy only (never the manifest)', async () => {
    const { service, sessions, prisma } = build();
    sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      brandManifestSnapshot: snapshot,
    });
    sessions.updateSession.mockImplementation(
      async (
        _id: string,
        u: { brandManifestSnapshot: BrandManifestSnapshot },
      ) => ({
        sessionId: 's1',
        brandManifestSnapshot: u.brandManifestSnapshot,
      }),
    );
    const result = await service.updateSnapshot('s1', {
      styleNotes: 'new',
      characters: [{ label: 'Лис', description: 'плюшевый' }],
    });
    expect(result.styleNotes).toBe('new');
    expect(result.filters).toEqual({ a: 1 });
    expect(result.characters).toEqual([
      {
        sourceCharacterId: null,
        label: 'Лис',
        photoUrl: null,
        description: 'плюшевый',
      },
    ]);
    expect(result.editedAt).not.toBeNull();
    // Nothing but sessions was written.
    expect(Object.keys(prisma)).toEqual([
      'productItem',
      'session',
      'userVoice',
    ]);
    expect(prisma.productItem.findFirst).not.toHaveBeenCalled();
    // Анонимная сессия (userId нет в моке) — своих клонов не ищем вовсе.
    expect(prisma.userVoice.findFirst).not.toHaveBeenCalled();
  });

  it('Е-4.1 шестого аудита: свой клон на Resemble в снимке — ttsProvider безусловно resemble, а не активный на стенде провайдер', async () => {
    const { service, sessions, prisma } = build();
    sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      brandManifestSnapshot: snapshot,
    });
    prisma.userVoice.findFirst.mockResolvedValue({ id: 'uv1' });
    sessions.updateSession.mockImplementation(
      async (
        _id: string,
        u: { brandManifestSnapshot: BrandManifestSnapshot },
      ) => ({
        sessionId: 's1',
        brandManifestSnapshot: u.brandManifestSnapshot,
      }),
    );
    const result = await service.updateSnapshot('s1', {
      ttsVoiceId: 'clone-1',
    });
    expect(prisma.userVoice.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', resembleVoiceId: 'clone-1' },
      select: { id: true },
    });
    expect(result.ttsProvider).toBe('resemble');
  });

  it('доп. запрос владельца продукта: voiceMode dub проверяет тариф voiceDub (Premium)', async () => {
    const { service, sessions, plans } = build();
    sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      brandManifestSnapshot: snapshot,
    });
    sessions.updateSession.mockImplementation(
      async (
        _id: string,
        u: { brandManifestSnapshot: BrandManifestSnapshot },
      ) => ({ sessionId: 's1', brandManifestSnapshot: u.brandManifestSnapshot }),
    );
    await service.updateSnapshot('s1', { voiceMode: 'dub' });
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'voiceDub');
  });

  it('voiceMode voiceover/veo — тариф voiceDub не спрашивается вовсе', async () => {
    const { service, sessions, plans } = build();
    sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      brandManifestSnapshot: snapshot,
    });
    sessions.updateSession.mockImplementation(
      async (
        _id: string,
        u: { brandManifestSnapshot: BrandManifestSnapshot },
      ) => ({ sessionId: 's1', brandManifestSnapshot: u.brandManifestSnapshot }),
    );
    await service.updateSnapshot('s1', { voiceMode: 'voiceover' });
    expect(plans.assertUser).not.toHaveBeenCalledWith('u1', 'voiceDub');
  });

  it('снимок уже был dub — повторное сохранение не переспрашивает тариф (даунгрейд не блокирует остальные правки)', async () => {
    const { service, sessions, plans } = build();
    sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      brandManifestSnapshot: { ...snapshot, voiceMode: 'dub' },
    });
    sessions.updateSession.mockImplementation(
      async (
        _id: string,
        u: { brandManifestSnapshot: BrandManifestSnapshot },
      ) => ({ sessionId: 's1', brandManifestSnapshot: u.brandManifestSnapshot }),
    );
    // Правит другое поле, voiceMode шлётся тем же ('dub'), как всегда
    // делает форма — но пользователь мог давно уйти с Premium.
    await service.updateSnapshot('s1', {
      voiceMode: 'dub',
      styleNotes: 'новый стиль',
    });
    expect(plans.assertUser).not.toHaveBeenCalledWith('u1', 'voiceDub');
  });

  it('тариф не позволяет dub — ForbiddenException, снимок не пишется', async () => {
    const { service, sessions, plans } = build();
    sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      brandManifestSnapshot: snapshot,
    });
    plans.assertUser.mockRejectedValueOnce(
      Object.assign(new Error('Дубляж доступен в режиме Premium'), {
        name: 'ForbiddenException',
      }),
    );
    await expect(
      service.updateSnapshot('s1', { voiceMode: 'dub' }),
    ).rejects.toThrow(/Premium/);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });
});

describe('applySnapshotEdit', () => {
  const base: BrandManifestSnapshot = {
    brandManifestId: 'bm1',
    title: 't',
    styleNotes: 's',
    voiceNotes: null,
    filters: { a: 1 },
    effects: { b: 2 },
    characters: [],
    snapshotAt: '2026-09-05T10:00:00.000Z',
    editedAt: null,
  };
  const now = new Date('2026-09-05T11:00:00Z');

  it('keeps omitted fields, applies explicit null as "clear"', () => {
    const next = applySnapshotEdit(
      base,
      { filters: null },
      'elevenlabs',
      false,
      now,
    );
    expect(next.filters).toBeNull();
    expect(next.effects).toEqual({ b: 2 });
    expect(next.styleNotes).toBe('s');
    expect(next.editedAt).toBe('2026-09-05T11:00:00.000Z');
    expect(next.snapshotAt).toBe(base.snapshotAt);
  });

  it('doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.2: ttsVoiceId изменился в снимке — ttsProvider проставляется активным провайдером, не клиентом', () => {
    const next = applySnapshotEdit(
      base,
      { ttsVoiceId: 'v1' },
      'resemble',
      false,
      now,
    );
    expect(next.ttsVoiceId).toBe('v1');
    expect(next.ttsProvider).toBe('resemble');
  });

  it('ttsVoiceId очищен в снимке (null) — ttsProvider тоже очищается', () => {
    const next = applySnapshotEdit(
      { ...base, ttsVoiceId: 'old', ttsProvider: 'elevenlabs' },
      { ttsVoiceId: null },
      'resemble',
      false,
      now,
    );
    expect(next.ttsVoiceId).toBeNull();
    expect(next.ttsProvider).toBeNull();
  });

  it('ttsVoiceId не тронут — ttsProvider снимка не меняется', () => {
    const next = applySnapshotEdit(
      { ...base, ttsVoiceId: 'v1', ttsProvider: 'elevenlabs' },
      { styleNotes: 'x' },
      'resemble',
      false,
      now,
    );
    expect(next.ttsProvider).toBe('elevenlabs');
  });

  it('Е-4.1 шестого аудита: свой клон на Resemble — ttsProvider безусловно resemble, даже при другом активном провайдере', () => {
    const next = applySnapshotEdit(
      base,
      { ttsVoiceId: 'clone-1' },
      'elevenlabs',
      true,
      now,
    );
    expect(next.ttsProvider).toBe('resemble');
  });

  it('replaces the character list wholesale', () => {
    const next = applySnapshotEdit(
      {
        ...base,
        characters: [
          {
            sourceCharacterId: 'c1',
            label: 'x',
            photoUrl: null,
            description: null,
          },
        ],
      },
      { characters: [] },
      'elevenlabs',
      false,
      now,
    );
    expect(next.characters).toEqual([]);
  });
});
