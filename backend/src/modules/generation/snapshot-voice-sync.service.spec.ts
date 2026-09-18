/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));

import { SnapshotVoiceSyncService } from './snapshot-voice-sync.service';
import {
  syncSnapshotSketches,
  syncSnapshotVoice,
} from '../project-session/snapshot';
import { BrandManifestSnapshot } from '../../common/types/brand-manifest.types';

const snap = (over: Partial<BrandManifestSnapshot> = {}) =>
  ({
    brandManifestId: 'bm1',
    title: 'Бренд',
    styleNotes: null,
    voiceNotes: null,
    voiceMode: 'dub',
    ttsVoiceId: null,
    ttsModel: null,
    ttsProvider: null,
    filters: null,
    effects: null,
    characters: [],
    snapshotAt: '2026-09-17T06:39:03.000Z',
    editedAt: null,
    ...over,
  }) as BrandManifestSnapshot;

const francesca = {
  ttsVoiceId: 'francesca',
  ttsModel: null,
  ttsProvider: 'resemble',
};

describe('syncSnapshotVoice', () => {
  it('подтягивает голос бренда, режим озвучки не трогает', () => {
    const next = syncSnapshotVoice(snap({ voiceMode: 'dub' }), francesca);
    expect(next).toMatchObject({
      ttsVoiceId: 'francesca',
      ttsProvider: 'resemble',
      voiceMode: 'dub',
    });
  });

  it('голос выбран в сессии вручную — не трогает', () => {
    expect(
      syncSnapshotVoice(
        snap({ voiceEditedAt: '2026-09-17T06:41:00.000Z' }),
        francesca,
      ),
    ).toBeNull();
  });

  it('правка стиля (editedAt) голос не замораживает', () => {
    expect(
      syncSnapshotVoice(
        snap({ editedAt: '2026-09-17T06:41:00.000Z' }),
        francesca,
      )?.ttsVoiceId,
    ).toBe('francesca');
  });

  it('уже совпадает — null', () => {
    expect(
      syncSnapshotVoice(
        snap({ ttsVoiceId: 'francesca', ttsProvider: 'resemble' }),
        francesca,
      ),
    ).toBeNull();
  });
});

describe('syncSnapshotSketches (§4 п.8 ТЗ скетча)', () => {
  const sketchRow = {
    id: 'sk1',
    url: 'https://blob/sketches/u1/sk1.png',
    pathname: 'sketches/u1/sk1.png',
    mimeType: 'image/png',
    style: 'pencil',
    options: {},
    appliedAt: new Date('2026-09-17T10:00:00.000Z'),
  };

  it('подтягивает скетч персонажа бренда, чужие слоты не трогает', () => {
    const next = syncSnapshotSketches(
      snap({
        characters: [
          {
            sourceCharacterId: 'bc1',
            label: 'Аня',
            photoUrl: 'u',
            description: null,
          },
          {
            sourceCharacterId: 'bc2',
            label: 'Лис',
            photoUrl: 'u',
            description: null,
          },
        ],
      }),
      {
        characters: [
          { id: 'bc1', activeSketch: sketchRow },
          { id: 'bc2', activeSketch: null },
        ],
      },
    );
    expect(next?.characters[0].sketch?.sketchId).toBe('sk1');
    expect(next?.characters[1].sketch).toBeUndefined();
  });

  it('свой скетч сессии сильнее бренда; без изменений — null', () => {
    const own = {
      sketchId: 'own',
      url: 'u',
      pathname: 'p',
      mimeType: 'image/png',
      style: 'flat' as const,
      sketchRendering: 'realistic' as const,
      appliedAt: '',
    };
    const next = syncSnapshotSketches(
      snap({
        characters: [
          {
            sourceCharacterId: 'bc1',
            label: 'Аня',
            photoUrl: 'u',
            description: null,
            sketch: own,
          },
        ],
      }),
      { characters: [{ id: 'bc1', activeSketch: sketchRow }] },
    );
    expect(next).toBeNull();
  });
});

describe('SnapshotVoiceSyncService', () => {
  function build(session: any, manifest: any = francesca) {
    const sessions = {
      getSession: jest.fn().mockResolvedValue(session),
      updateSession: jest.fn().mockResolvedValue(session),
    };
    const prisma = {
      brandManifest: { findUnique: jest.fn().mockResolvedValue(manifest) },
      productItem: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new SnapshotVoiceSyncService(
      sessions as any,
      prisma as any,
    );
    return { service, sessions, prisma };
  }

  it('до первого рендера — пишет голос бренда в сессию', async () => {
    const { service, sessions } = build({ brandManifestSnapshot: snap() });
    await service.syncBeforeRender('s1');
    expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
      brandManifestSnapshot: expect.objectContaining({
        ttsVoiceId: 'francesca',
      }),
    });
  });

  it('ролик уже есть — ничего не меняет', async () => {
    const { service, sessions, prisma } = build({
      brandManifestSnapshot: snap(),
      generatedVideo: { status: 'complete' },
    });
    await service.syncBeforeRender('s1');
    expect(prisma.brandManifest.findUnique).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('бренд удалён или сессия без бренда — ничего не меняет', async () => {
    const a = build({ brandManifestSnapshot: snap() }, null);
    await a.service.syncBeforeRender('s1');
    expect(a.sessions.updateSession).not.toHaveBeenCalled();

    const b = build({});
    await b.service.syncBeforeRender('s1');
    expect(b.sessions.updateSession).not.toHaveBeenCalled();
  });

  it('ошибка не роняет генерацию', async () => {
    const { service, sessions } = build({ brandManifestSnapshot: snap() });
    sessions.updateSession.mockRejectedValue(new Error('db down'));
    await expect(service.syncBeforeRender('s1')).resolves.toBeUndefined();
  });

  it('подтягивает применённый скетч товара проекта (§4 п.8 ТЗ скетча)', async () => {
    const session = {
      productItemId: 'item-1',
      productInformation: { productName: 'Пиво', productDescription: '' },
    };
    const { service, sessions, prisma } = build(session as any, null);
    prisma.productItem.findUnique.mockResolvedValue({
      activeSketch: {
        id: 'sk1',
        url: 'https://blob/sketches/u1/sk1.png',
        pathname: 'sketches/u1/sk1.png',
        mimeType: 'image/png',
        style: 'pencil',
        options: { sketchRendering: 'realistic' },
        appliedAt: new Date('2026-09-17T10:00:00.000Z'),
      },
    });

    await service.syncBeforeRender('s1');

    const call = sessions.updateSession.mock.calls.find(
      (c: any) => c[1].productInformation,
    );
    expect(call[1].productInformation.sketch).toMatchObject({
      sketchId: 'sk1',
      pathname: 'sketches/u1/sk1.png',
    });
  });

  it('ролик уже есть — скетчи не подтягиваются', async () => {
    const { service, sessions, prisma } = build(
      {
        productItemId: 'item-1',
        productInformation: { productName: 'x', productDescription: '' },
        generatedVideo: { status: 'complete' },
      } as any,
      null,
    );
    await service.syncBeforeRender('s1');
    expect(prisma.productItem.findUnique).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });
});
