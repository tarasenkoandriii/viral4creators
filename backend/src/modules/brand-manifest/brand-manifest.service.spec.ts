/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));

import { head } from '@vercel/blob';
import { Prisma } from '@prisma/client';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  BrandManifestService,
  characterPhotoPathname,
  manifestDataFromDto,
  scenePhotoPathname,
  toManifestView,
  toSummaryView,
} from './brand-manifest.service';

const plansMock = () => ({
  // §26.4: дневной лимит по умолчанию не выбран.
  assertCanSpendUser: jest.fn(),
  assertCanSpendSession: jest.fn(),
  assertUserNotBlocked: jest.fn(),
  assertSessionNotBlocked: jest.fn(),
  assertNotBlocked: jest.fn(),
  accessOf: jest.fn().mockResolvedValue({
    plan: 'PREMIUM',
    isBlocked: false,
    blockedReason: null,
  }),
  assertUser: jest.fn().mockResolvedValue(undefined),
  assertSession: jest.fn().mockResolvedValue(undefined),
  planOfUser: jest.fn().mockResolvedValue('PREMIUM'),
  planOfSession: jest.fn().mockResolvedValue('PREMIUM'),
});

const mockedHead = head as jest.MockedFunction<typeof head>;
const USER = 'u1';
const NOW = new Date('2026-09-05T12:00:00.000Z');

const manifestRow = (over: Record<string, unknown> = {}) => ({
  id: 'bm1',
  title: 'Мой бренд',
  styleNotes: null,
  filters: null,
  effects: null,
  createdAt: NOW,
  updatedAt: NOW,
  characters: [],
  _count: { projects: 0 },
  ...over,
});
const characterRow = (over: Record<string, unknown> = {}) => ({
  id: 'bc1',
  brandManifestId: 'bm1',
  label: 'Модель 1',
  photoUrl: null,
  description: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

function build() {
  const prisma = {
    brandManifest: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue(manifestRow()),
      delete: jest.fn(),
    },
    brandCharacter: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      delete: jest.fn(),
    },
    brandScene: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      delete: jest.fn(),
    },
    // Шестой аудит, Е-4.1: create/update проверяют, не свой ли это клон
    // на Resemble, прежде чем проставить ttsProvider — по умолчанию
    // «нет своего клона» (null), не влияет на тесты, где ttsVoiceId не
    // трогают вовсе.
    userVoice: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const blob = {
    createUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'https://put' }),
    deleteBlob: jest.fn().mockResolvedValue(undefined),
    deleteMany: jest.fn().mockResolvedValue(0),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plans = plansMock();
  const tts = { resolve: jest.fn().mockResolvedValue({ providerKey: 'elevenlabs' }) };
  const svc = new BrandManifestService(
    prisma as any,
    blob as any,
    plans as any,
    tts as any,
  );
  return { svc, prisma, blob, plans, tts };
}

describe('manifestDataFromDto', () => {
  it('includes only sent keys, trims, and maps Json null → Prisma.DbNull', () => {
    expect(manifestDataFromDto({}, 'elevenlabs')).toEqual({});
    expect(
      manifestDataFromDto({ title: ' B ', styleNotes: ' warm ' }, 'elevenlabs'),
    ).toEqual({ title: 'B', styleNotes: 'warm' });
    expect(
      manifestDataFromDto(
        { filters: { preset: 'warm' }, effects: null },
        'elevenlabs',
      ),
    ).toEqual({
      filters: { preset: 'warm' },
      effects: Prisma.DbNull,
    });
    expect(manifestDataFromDto({ styleNotes: null }, 'elevenlabs')).toEqual({
      styleNotes: null,
    });
  });

  it('doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.2: ttsVoiceId изменился — ttsProvider проставляется активным провайдером стенда, а не клиентом', () => {
    expect(manifestDataFromDto({ ttsVoiceId: 'v1' }, 'resemble')).toEqual({
      ttsVoiceId: 'v1',
      ttsProvider: 'resemble',
    });
  });

  it('ttsVoiceId очищен — ttsProvider тоже очищается', () => {
    expect(manifestDataFromDto({ ttsVoiceId: null }, 'resemble')).toEqual({
      ttsVoiceId: null,
      ttsProvider: null,
    });
  });

  it('ttsVoiceId не тронут в запросе — ttsProvider тоже не тронут', () => {
    expect(manifestDataFromDto({ title: 'x' }, 'resemble')).toEqual({
      title: 'x',
    });
  });

  it('Е-4.1 шестого аудита: свой клон на Resemble — ttsProvider безусловно resemble, даже при другом активном провайдере', () => {
    expect(
      manifestDataFromDto({ ttsVoiceId: 'clone-1' }, 'elevenlabs', true),
    ).toEqual({
      ttsVoiceId: 'clone-1',
      ttsProvider: 'resemble',
    });
  });

  it('Е-4.1: не свой клон — ttsProvider как раньше, активным провайдером стенда', () => {
    expect(
      manifestDataFromDto({ ttsVoiceId: 'v1' }, 'elevenlabs', false),
    ).toEqual({
      ttsVoiceId: 'v1',
      ttsProvider: 'elevenlabs',
    });
  });
});

describe('views', () => {
  it('coerces non-object Json to null and counts', () => {
    const v = toManifestView(
      manifestRow({
        filters: { a: 1 },
        effects: 'garbage',
        _count: { projects: 3 },
        characters: [characterRow()],
      }),
    );
    expect(v.filters).toEqual({ a: 1 });
    expect(v.effects).toBeNull();
    expect(v.projectCount).toBe(3);
    expect(v.characters[0].label).toBe('Модель 1');
    expect(v.createdAt).toBe('2026-09-05T12:00:00.000Z');
    expect(v.scenes).toEqual([]);
    const s = toSummaryView(
      manifestRow({ _count: { projects: 2, characters: 4, scenes: 1 } }),
    );
    expect(s).toMatchObject({
      projectCount: 2,
      characterCount: 4,
      sceneCount: 1,
    });
  });
  it('scenePhotoPathname lives under the manifest next to characters', () => {
    expect(scenePhotoPathname('bm1', 'bs1', 'image/png')).toBe(
      'brand-manifests/bm1/scenes/bs1/photo.png',
    );
  });
  it('characterPhotoPathname: png stays png, everything else jpg', () => {
    expect(characterPhotoPathname('bm1', 'bc1', 'image/png')).toBe(
      'brand-manifests/bm1/characters/bc1/photo.png',
    );
    expect(characterPhotoPathname('bm1', 'bc1', 'image/jpeg')).toBe(
      'brand-manifests/bm1/characters/bc1/photo.jpg',
    );
  });
});

describe('manifests', () => {
  it('create requires a title and stamps the owner', async () => {
    const { svc, prisma } = build();
    await expect(svc.create(USER, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.brandManifest.create.mockResolvedValue(manifestRow());
    await svc.create(USER, { title: 'Мой бренд', filters: { preset: 'warm' } });
    expect(prisma.brandManifest.create.mock.calls[0][0].data).toEqual({
      userId: USER,
      title: 'Мой бренд',
      filters: { preset: 'warm' },
    });
  });

  it('доп. запрос владельца продукта: create с voiceMode dub проверяет тариф voiceDub (Premium)', async () => {
    const { svc, prisma, plans } = build();
    prisma.brandManifest.create.mockResolvedValue(manifestRow());
    await svc.create(USER, { title: 'Мой бренд', voiceMode: 'dub' });
    expect(plans.assertUser).toHaveBeenCalledWith(USER, 'voiceDub');
  });

  it('voiceMode voiceover/veo при create — тариф voiceDub не спрашивается', async () => {
    const { svc, prisma, plans } = build();
    prisma.brandManifest.create.mockResolvedValue(manifestRow());
    await svc.create(USER, { title: 'Мой бренд', voiceMode: 'voiceover' });
    expect(plans.assertUser).not.toHaveBeenCalledWith(USER, 'voiceDub');
  });

  it('тариф не позволяет dub при create — падает раньше записи в базу', async () => {
    const { svc, prisma, plans } = build();
    plans.assertUser.mockImplementation(
      async (_userId: string, feature: string) => {
        if (feature === 'voiceDub') {
          throw new ForbiddenException('Дубляж доступен в режиме Premium');
        }
      },
    );
    await expect(
      svc.create(USER, { title: 'Мой бренд', voiceMode: 'dub' }),
    ).rejects.toThrow(/Premium/);
    expect(prisma.brandManifest.create).not.toHaveBeenCalled();
  });

  it('list/get are scoped to the owner; get 404s on a miss', async () => {
    const { svc, prisma } = build();
    prisma.brandManifest.findMany.mockResolvedValue([]);
    await svc.list(USER);
    expect(prisma.brandManifest.findMany.mock.calls[0][0]).toMatchObject({
      where: { userId: USER },
      orderBy: { updatedAt: 'desc' },
    });
    prisma.brandManifest.findFirst.mockResolvedValue(null);
    await expect(svc.get(USER, 'foreign')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.brandManifest.findFirst.mock.calls[0][0].where).toEqual({
      id: 'foreign',
      userId: USER,
    });
  });

  it('update: empty PATCH is a no-op read; null clears Json via DbNull', async () => {
    const { svc, prisma } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(manifestRow());
    await svc.update(USER, 'bm1', {});
    expect(prisma.brandManifest.update).not.toHaveBeenCalled();
    await svc.update(USER, 'bm1', { filters: null });
    expect(prisma.brandManifest.update.mock.calls[0][0].data).toEqual({
      filters: Prisma.DbNull,
    });
  });

  it('доп. запрос владельца продукта: update с voiceMode dub тоже проверяет voiceDub — не только create', async () => {
    const { svc, prisma, plans } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(manifestRow());
    await svc.update(USER, 'bm1', { voiceMode: 'dub' });
    expect(plans.assertUser).toHaveBeenCalledWith(USER, 'voiceDub');
  });

  it('тариф не позволяет dub при update — падает раньше записи, манифест не трогается', async () => {
    const { svc, prisma, plans } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(manifestRow());
    plans.assertUser.mockImplementation(
      async (_userId: string, feature: string) => {
        if (feature === 'voiceDub') {
          throw new ForbiddenException('Дубляж доступен в режиме Premium');
        }
      },
    );
    await expect(
      svc.update(USER, 'bm1', { voiceMode: 'dub' }),
    ).rejects.toThrow(/Premium/);
    expect(prisma.brandManifest.update).not.toHaveBeenCalled();
  });

  it('манифест уже был dub — повторное сохранение не переспрашивает тариф (даунгрейд не блокирует остальные правки)', async () => {
    const { svc, prisma, plans } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(
      manifestRow({ voiceMode: 'dub' }),
    );
    prisma.brandManifest.update.mockResolvedValue(
      manifestRow({ voiceMode: 'dub', styleNotes: 'новый стиль' }),
    );
    // Форма шлёт текущий voiceMode при каждом сохранении, не только
    // когда его действительно поменяли — пользователь мог уйти с
    // Premium и просто правит стиль.
    await svc.update(USER, 'bm1', {
      voiceMode: 'dub',
      styleNotes: 'новый стиль',
    });
    expect(plans.assertUser).not.toHaveBeenCalledWith(USER, 'voiceDub');
  });

  it('remove checks ownership then deletes (cascade/SetNull is the DB’s job)', async () => {
    const { svc, prisma } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(manifestRow());
    await svc.remove(USER, 'bm1');
    expect(prisma.brandManifest.delete).toHaveBeenCalledWith({
      where: { id: 'bm1' },
    });
  });

  it('Е-4.1 шестого аудита: свой клон на Resemble — ttsProvider безусловно resemble, а не активный на стенде провайдер', async () => {
    const { svc, prisma } = build();
    prisma.userVoice.findFirst.mockResolvedValue({ id: 'uv1' });
    prisma.brandManifest.create.mockResolvedValue(manifestRow());
    await svc.create(USER, { title: 'Мой бренд', ttsVoiceId: 'clone-1' });
    expect(prisma.userVoice.findFirst).toHaveBeenCalledWith({
      where: { userId: USER, resembleVoiceId: 'clone-1' },
      select: { id: true },
    });
    expect(prisma.brandManifest.create.mock.calls[0][0].data).toMatchObject({
      ttsVoiceId: 'clone-1',
      ttsProvider: 'resemble',
    });
  });

  it('Е-4.1: чужой/несуществующий voiceId — тегируется активным провайдером стенда, как раньше', async () => {
    const { svc, prisma } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(manifestRow());
    prisma.brandManifest.update.mockResolvedValue(manifestRow());
    await svc.update(USER, 'bm1', { ttsVoiceId: 'v1' });
    expect(prisma.userVoice.findFirst).toHaveBeenCalledWith({
      where: { userId: USER, resembleVoiceId: 'v1' },
      select: { id: true },
    });
    expect(prisma.brandManifest.update.mock.calls[0][0].data).toMatchObject({
      ttsVoiceId: 'v1',
      ttsProvider: 'elevenlabs',
    });
  });

  it('Е-4.1: ttsVoiceId не тронут в запросе — своих клонов не ищем вовсе', async () => {
    const { svc, prisma } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(manifestRow());
    prisma.brandManifest.update.mockResolvedValue(manifestRow());
    await svc.update(USER, 'bm1', { title: 'x' });
    expect(prisma.userVoice.findFirst).not.toHaveBeenCalled();
  });
});

describe('characters', () => {
  it('addCharacter requires a label, scopes through the manifest owner, bumps the manifest', async () => {
    const { svc, prisma } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(manifestRow());
    await expect(svc.addCharacter(USER, 'bm1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.brandCharacter.create.mockResolvedValue(characterRow());
    const v = await svc.addCharacter(USER, 'bm1', {
      label: ' Модель 1 ',
      description: 'блондинка, 25',
    });
    expect(prisma.brandCharacter.create.mock.calls[0][0].data).toEqual({
      brandManifestId: 'bm1',
      label: 'Модель 1',
      description: 'блондинка, 25',
    });
    expect(prisma.brandManifest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bm1' } }),
    );
    expect(v.label).toBe('Модель 1');
  });

  it('character lookups go through manifest → owner; 404 otherwise', async () => {
    const { svc, prisma } = build();
    prisma.brandCharacter.findFirst.mockResolvedValue(null);
    await expect(
      svc.updateCharacter(USER, 'bm1', 'bc9', { label: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.brandCharacter.findFirst.mock.calls[0][0].where).toEqual({
      id: 'bc9',
      brandManifestId: 'bm1',
      brandManifest: { userId: USER },
    });
  });

  it('removeCharacter also drops the photo blob when there was one', async () => {
    const { svc, prisma, blob } = build();
    prisma.brandCharacter.findFirst.mockResolvedValue(
      characterRow({ photoUrl: 'https://blob/.../photo.png' }),
    );
    await svc.removeCharacter(USER, 'bm1', 'bc1');
    expect(prisma.brandCharacter.delete).toHaveBeenCalledWith({
      where: { id: 'bc1' },
    });
    expect(blob.deleteBlob).toHaveBeenCalledWith(
      'brand-manifests/bm1/characters/bc1/photo.png',
    );
  });
});

describe('character photo', () => {
  beforeEach(() => {
    mockedHead.mockReset();
    mockedHead.mockResolvedValue({
      url: 'https://blob/cdn/photo.jpg',
    } as never);
  });

  it('upload-url under the character key, 10MB cap passed to Blob', async () => {
    const { svc, prisma, blob } = build();
    prisma.brandCharacter.findFirst.mockResolvedValue(characterRow());
    const r = await svc.createCharacterPhotoUploadUrl(USER, 'bm1', 'bc1', {
      fileName: 'a.jpg',
      fileSize: 100,
      mimeType: 'image/jpeg',
    });
    expect(r).toEqual({
      uploadUrl: 'https://put',
      pathname: 'brand-manifests/bm1/characters/bc1/photo.jpg',
    });
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      r.pathname,
      'image/jpeg',
      10 * 1024 * 1024,
    );
  });

  it('confirm: rejects a foreign pathname, 400 if nothing uploaded, else stores the public URL', async () => {
    const { svc, prisma } = build();
    prisma.brandCharacter.findFirst.mockResolvedValue(characterRow());
    await expect(
      svc.confirmCharacterPhoto(USER, 'bm1', 'bc1', {
        pathname: 'brand-manifests/bm1/characters/OTHER/photo.jpg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    mockedHead.mockRejectedValueOnce(new Error('does not exist'));
    await expect(
      svc.confirmCharacterPhoto(USER, 'bm1', 'bc1', {
        pathname: 'brand-manifests/bm1/characters/bc1/photo.jpg',
      }),
    ).rejects.toThrow(/upload it first/);
    prisma.brandCharacter.update.mockResolvedValue(
      characterRow({ photoUrl: 'https://blob/cdn/photo.jpg' }),
    );
    const v = await svc.confirmCharacterPhoto(USER, 'bm1', 'bc1', {
      pathname: 'brand-manifests/bm1/characters/bc1/photo.jpg',
    });
    expect(prisma.brandCharacter.update).toHaveBeenCalledWith({
      where: { id: 'bc1' },
      data: { photoUrl: 'https://blob/cdn/photo.jpg' },
    });
    expect(v.photoUrl).toBe('https://blob/cdn/photo.jpg');
  });
});

describe('brand scenes (§17.1) — same flow as characters, other table', () => {
  const sceneRow = (over: Record<string, unknown> = {}) =>
    characterRow({ id: 'bs1', label: 'Шоурум', ...over });

  beforeEach(() => {
    mockedHead.mockReset();
    mockedHead.mockResolvedValue({
      url: 'https://blob/cdn/scene.png',
    } as never);
  });

  it('addScene writes to brand_scenes, requires a label, bumps the manifest', async () => {
    const { svc, prisma } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(manifestRow());
    await expect(
      svc.addScene(USER, 'bm1', { description: 'без названия' }),
    ).rejects.toThrow(/label is required to add a scene/);
    prisma.brandScene.create.mockResolvedValue(sceneRow());
    const v = await svc.addScene(USER, 'bm1', {
      label: '  Шоурум ',
      description: 'белые стены',
    });
    expect(prisma.brandScene.create.mock.calls[0][0].data).toEqual({
      brandManifestId: 'bm1',
      label: 'Шоурум',
      description: 'белые стены',
    });
    expect(prisma.brandCharacter.create).not.toHaveBeenCalled();
    expect(v.label).toBe('Шоурум');
    expect(prisma.brandManifest.update).toHaveBeenCalled();
  });

  it('scene lookups are scoped through the manifest owner; 404 names the scene', async () => {
    const { svc, prisma } = build();
    prisma.brandScene.findFirst.mockResolvedValue(null);
    await expect(
      svc.updateScene(USER, 'bm1', 'bs1', { label: 'x' }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      svc.updateScene(USER, 'bm1', 'bs1', { label: 'x' }),
    ).rejects.toThrow(/Scene bs1 not found/);
    expect(prisma.brandScene.findFirst.mock.calls[0][0].where).toEqual({
      id: 'bs1',
      brandManifestId: 'bm1',
      brandManifest: { userId: USER },
    });
  });

  it('removeScene drops the row and the photo blob under the scenes/ key', async () => {
    const { svc, prisma, blob } = build();
    prisma.brandScene.findFirst.mockResolvedValue(
      sceneRow({ photoUrl: 'https://blob/cdn/x/photo.png' }),
    );
    await svc.removeScene(USER, 'bm1', 'bs1');
    expect(prisma.brandScene.delete).toHaveBeenCalledWith({
      where: { id: 'bs1' },
    });
    expect(blob.deleteBlob).toHaveBeenCalledWith(
      'brand-manifests/bm1/scenes/bs1/photo.png',
    );
  });

  it('photo upload-url/confirm use the scenes/ prefix and reject a characters/ pathname', async () => {
    const { svc, prisma } = build();
    prisma.brandScene.findFirst.mockResolvedValue(sceneRow());
    const r = await svc.createScenePhotoUploadUrl(USER, 'bm1', 'bs1', {
      fileName: 'a.png',
      fileSize: 100,
      mimeType: 'image/png',
    });
    expect(r.pathname).toBe('brand-manifests/bm1/scenes/bs1/photo.png');
    await expect(
      svc.confirmScenePhoto(USER, 'bm1', 'bs1', {
        pathname: 'brand-manifests/bm1/characters/bs1/photo.png',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.brandScene.update.mockResolvedValue(
      sceneRow({ photoUrl: 'https://blob/cdn/scene.png' }),
    );
    const v = await svc.confirmScenePhoto(USER, 'bm1', 'bs1', {
      pathname: 'brand-manifests/bm1/scenes/bs1/photo.png',
    });
    expect(prisma.brandScene.update).toHaveBeenCalledWith({
      where: { id: 'bs1' },
      data: { photoUrl: 'https://blob/cdn/scene.png' },
    });
    expect(v.photoUrl).toBe('https://blob/cdn/scene.png');
  });
});

describe('удаление манифеста убирает фото за каскадом БД (этап 27)', () => {
  it('собирает фото персонажей и сцен ДО удаления и чистит хранилище', async () => {
    const { svc, prisma, blob } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(manifestRow());
    const order: string[] = [];
    prisma.brandCharacter.findMany.mockImplementation(async () => {
      order.push('read-characters');
      return [
        {
          photoUrl: 'https://cdn/brand-manifests/bm1/characters/bc1/photo.png',
        },
        { photoUrl: null },
      ];
    });
    prisma.brandScene.findMany.mockImplementation(async () => {
      order.push('read-scenes');
      return [
        { photoUrl: 'https://cdn/brand-manifests/bm1/scenes/bs1/photo.jpg' },
      ];
    });
    prisma.brandManifest.delete.mockImplementation(async () => {
      order.push('delete');
      return {};
    });

    await svc.remove(USER, 'bm1');

    expect(order[order.length - 1]).toBe('delete');
    expect(blob.deleteMany).toHaveBeenCalledWith([
      'brand-manifests/bm1/characters/bc1/photo.png',
      'brand-manifests/bm1/scenes/bs1/photo.jpg',
    ]);
  });

  it('чужой префикс в URL не даёт удалить посторонний файл', async () => {
    const { svc, prisma, blob } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(manifestRow());
    prisma.brandCharacter.findMany.mockResolvedValue([
      { photoUrl: 'https://cdn/brand-manifests/OTHER/characters/x/photo.png' },
    ]);
    prisma.brandScene.findMany.mockResolvedValue([]);
    await svc.remove(USER, 'bm1');
    expect(blob.deleteMany).not.toHaveBeenCalled();
  });
});
