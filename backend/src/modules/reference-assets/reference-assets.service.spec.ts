import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ReferenceAssetsService,
  scenePathname,
} from './reference-assets.service';
import type { Session } from '../../common/types/session.types';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));
import { head } from '@vercel/blob';

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

const scene = (id: string, label = id) => ({
  id,
  label,
  description: null,
  photoUrl: `https://blob.test/sessions/s1/scenes/${id}/photo.jpg`,
  photoPathname: `sessions/s1/scenes/${id}/photo.jpg`,
  createdAt: '',
});
const base = {
  sessionId: 's1',
  videoAnalysis: {
    characters: [
      {
        id: 'c1',
        label: 'Аня',
        role: null,
        appearance: 'a',
        prominence: 'main',
      },
    ],
  },
  characterCasting: {
    updatedAt: '',
    casts: [
      {
        characterId: 'c1',
        active: true,
        order: 1,
        replacement: {
          kind: 'photo',
          photoUrl: 'https://blob.test/c1.jpg',
          photoPathname: 'sessions/s1/characters/c1/photo.jpg',
          description: null,
          brandCharacterId: null,
          label: null,
        },
      },
    ],
  },
  productInformation: {
    productName: 'Кружка',
    productDescription: 'd',
    productImagePathname: 'p/photo.jpg',
    addedAt: new Date(),
  },
} as unknown as Session;

function build(session: Partial<Session> | undefined) {
  let stored = session ? { ...session } : undefined;
  const sessions = {
    getSession: jest.fn(async () => stored),
    updateSession: jest.fn(async (_id: string, u: Partial<Session>) => {
      stored = { ...stored, ...u } as Session;
      return stored;
    }),
  };
  const blob = {
    createUploadUrl: jest
      .fn()
      .mockResolvedValue({ uploadUrl: 'https://blob.test/put' }),
    deleteBlob: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new ReferenceAssetsService(
      plansMock() as never,
      sessions as never,
      blob as never,
    ),
    sessions,
    blob,
    stored: () => stored,
  };
}

describe('scenes', () => {
  it('upload-url mints a scene id under the session; cap 5', async () => {
    const { service, blob } = build(base);
    const r = await service.createUploadUrl('s1', {
      fileName: 'k.jpg',
      fileSize: 10,
      mimeType: 'image/jpeg',
    });
    expect(r.pathname).toBe(scenePathname('s1', r.sceneId, 'image/jpeg'));
    expect(r.pathname).toMatch(
      /^sessions\/s1\/scenes\/sc_[0-9a-f]{12}\/photo\.jpg$/,
    );
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      r.pathname,
      'image/jpeg',
      10 * 1024 * 1024,
    );
    const full = build({
      ...base,
      scenes: ['a', 'b', 'c', 'd', 'e'].map((x) => scene(x)),
    });
    await expect(
      full.service.createUploadUrl('s1', {
        fileName: 'k.jpg',
        fileSize: 10,
        mimeType: 'image/jpeg',
      }),
    ).rejects.toThrow(/At most 5/);
  });

  it('confirm verifies the blob, appends the scene; rejects foreign paths and duplicates', async () => {
    mockedHead.mockResolvedValue({
      url: 'https://blob.test/sessions/s1/scenes/sc_1/photo.png',
    } as never);
    const { service, stored } = build(base);
    const list = await service.confirmScene('s1', {
      pathname: 'sessions/s1/scenes/sc_1/photo.png',
      label: ' Кухня ',
      description: ' светлая ',
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'sc_1',
      label: 'Кухня',
      description: 'светлая',
      photoUrl: 'https://blob.test/sessions/s1/scenes/sc_1/photo.png',
    });
    expect(stored()?.scenes).toHaveLength(1);
    await expect(
      service.confirmScene('s1', {
        pathname: 'sessions/s1/scenes/sc_1/photo.png',
        label: 'x',
      }),
    ).rejects.toThrow(/already confirmed/);
    await expect(
      service.confirmScene('s1', {
        pathname: 'sessions/s2/scenes/sc_9/photo.png',
        label: 'x',
      }),
    ).rejects.toThrow(/must start with/);
    mockedHead.mockRejectedValueOnce(new Error('404'));
    await expect(
      service.confirmScene('s1', {
        pathname: 'sessions/s1/scenes/sc_2/photo.png',
        label: 'x',
      }),
    ).rejects.toThrow(/not found in storage/);
  });

  it('update edits label/description; delete removes the scene, its blob and its slot', async () => {
    const { service, blob, stored } = build({
      ...base,
      scenes: [scene('sc_a', 'Кухня'), scene('sc_b', 'Улица')],
      referenceSelection: {
        slots: ['scene:sc_b', 'character:c1'],
        updatedAt: '',
      },
    });
    const upd = await service.updateScene('s1', 'sc_a', {
      description: 'дерево',
    });
    expect(upd[0].description).toBe('дерево');
    await expect(
      service.updateScene('s1', 'nope', { label: 'x' }),
    ).rejects.toThrow(NotFoundException);

    const left = await service.deleteScene('s1', 'sc_b');
    expect(left.map((s) => s.id)).toEqual(['sc_a']);
    expect(blob.deleteBlob).toHaveBeenCalledWith(
      'sessions/s1/scenes/sc_b/photo.jpg',
    );
    expect(stored()?.referenceSelection?.slots).toEqual(['character:c1']);
  });
});

describe('slots', () => {
  it('GET reports candidates + default slots', async () => {
    const { service } = build({ ...base, scenes: [scene('sc_a', 'Кухня')] });
    const v = await service.getSlots('s1');
    expect(v.isDefault).toBe(true);
    expect(v.max).toBe(3);
    expect(v.candidates.map((c) => c.id)).toEqual([
      'character:c1',
      'scene:sc_a',
      'product',
    ]);
    expect(v.slots).toEqual(['character:c1', 'scene:sc_a', 'product']);
  });

  it('PUT validates ids and duplicates, stores the order; DELETE resets to default', async () => {
    const { service, stored } = build({
      ...base,
      scenes: [scene('sc_a', 'Кухня')],
    });
    await expect(
      service.putSlots('s1', { slots: ['scene:nope'] }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.putSlots('s1', { slots: ['product', 'product'] }),
    ).rejects.toThrow(/Duplicate/);
    const v = await service.putSlots('s1', {
      slots: ['product', 'scene:sc_a'],
    });
    expect(v.isDefault).toBe(false);
    expect(v.slots).toEqual(['product', 'scene:sc_a']);
    expect(stored()?.referenceSelection?.slots).toEqual([
      'product',
      'scene:sc_a',
    ]);
    const empty = await service.putSlots('s1', { slots: [] });
    expect(empty.slots).toEqual([]);
    const reset = await service.resetSlots('s1');
    expect(reset.isDefault).toBe(true);
    expect(reset.slots).toEqual(['character:c1', 'scene:sc_a', 'product']);
  });

  it('404 for a missing session', async () => {
    await expect(build(undefined).service.getSlots('s0')).rejects.toThrow(
      NotFoundException,
    );
  });
});
