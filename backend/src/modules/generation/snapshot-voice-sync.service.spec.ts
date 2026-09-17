/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));

import { SnapshotVoiceSyncService } from './snapshot-voice-sync.service';
import { syncSnapshotVoice } from '../project-session/snapshot';
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

describe('SnapshotVoiceSyncService', () => {
  function build(session: any, manifest: any = francesca) {
    const sessions = {
      getSession: jest.fn().mockResolvedValue(session),
      updateSession: jest.fn().mockResolvedValue(session),
    };
    const prisma = {
      brandManifest: { findUnique: jest.fn().mockResolvedValue(manifest) },
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
});
