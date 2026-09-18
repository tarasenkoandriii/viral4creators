import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  castPhotoPathname,
  CastingService,
  normaliseCasting,
} from './casting.service';
import type { CharacterCasting } from '../../common/types/casting.types';
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

const session = {
  videoAnalysis: {
    characters: [
      {
        id: 'c1',
        label: 'Аня',
        role: null,
        appearance: 'a',
        prominence: 'main',
      },
      {
        id: 'c2',
        label: 'Лис',
        role: null,
        appearance: 'b',
        prominence: 'secondary',
      },
      {
        id: 'c3',
        label: 'Бариста',
        role: null,
        appearance: 'c',
        prominence: 'background',
      },
    ],
  },
  brandManifestSnapshot: {
    characters: [
      {
        sourceCharacterId: 'bc1',
        label: 'Бренд-Аня',
        photoUrl: 'https://blob.test/bc1.png',
        description: 'd',
      },
    ],
  },
} as unknown as Pick<Session, 'videoAnalysis' | 'brandManifestSnapshot'>;

const none = { kind: 'none' as const };
const now = new Date('2026-09-05T12:00:00Z');

describe('normaliseCasting', () => {
  it('keeps only known characters, densifies order by relative order, zeroes inactive', () => {
    const c = normaliseCasting(
      session,
      undefined,
      {
        casts: [
          { characterId: 'c3', active: true, order: 7, replacement: none },
          { characterId: 'c1', active: false, order: 5, replacement: none },
          { characterId: 'c2', active: true, order: 2, replacement: none },
        ],
      },
      now,
    );
    expect(c.updatedAt).toBe('2026-09-05T12:00:00.000Z');
    expect(c.casts.map((x) => [x.characterId, x.active, x.order])).toEqual([
      ['c3', true, 2],
      ['c1', false, 0],
      ['c2', true, 1],
    ]);
    expect(c.casts[0].replacement).toEqual({
      kind: 'none',
      photoUrl: null,
      photoPathname: null,
      description: null,
      brandCharacterId: null,
      label: null,
    });
  });

  it('rejects unknown and duplicate characters, and a session with no analysed characters', () => {
    expect(() =>
      normaliseCasting(session, undefined, {
        casts: [
          { characterId: 'c9', active: true, order: 1, replacement: none },
        ],
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      normaliseCasting(session, undefined, {
        casts: [
          { characterId: 'c1', active: true, order: 1, replacement: none },
          { characterId: 'c1', active: true, order: 2, replacement: none },
        ],
      }),
    ).toThrow(/Duplicate/);
    expect(() =>
      normaliseCasting({ videoAnalysis: undefined } as never, undefined, {
        casts: [],
      }),
    ).toThrow(/no characters/);
  });

  it('text replacement needs a description; it is trimmed', () => {
    expect(() =>
      normaliseCasting(session, undefined, {
        casts: [
          {
            characterId: 'c1',
            active: true,
            order: 1,
            replacement: { kind: 'text', description: '  ' },
          },
        ],
      }),
    ).toThrow(/needs a description/);
    const c = normaliseCasting(session, undefined, {
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: 1,
          replacement: { kind: 'text', description: '  рыжая  ' },
        },
      ],
    });
    expect(c.casts[0].replacement).toMatchObject({
      kind: 'text',
      description: 'рыжая',
      photoUrl: null,
    });
  });

  it('photo replacement can only KEEP a photo this session uploaded, never introduce one', () => {
    expect(() =>
      normaliseCasting(session, undefined, {
        casts: [
          {
            characterId: 'c1',
            active: true,
            order: 1,
            replacement: { kind: 'photo', photoUrl: 'https://evil.test/x.png' },
          },
        ],
      }),
    ).toThrow(/upload one/);
    const existing: CharacterCasting = {
      updatedAt: '',
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: 1,
          replacement: {
            kind: 'photo',
            photoUrl: 'https://blob.test/s/c1.jpg',
            photoPathname: 'sessions/s/characters/c1/photo.jpg',
            description: 'old',
            brandCharacterId: null,
            label: null,
          },
        },
      ],
    };
    const c = normaliseCasting(session, existing, {
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: 1,
          replacement: {
            kind: 'photo',
            photoUrl: 'https://evil.test/x.png',
            description: 'new words',
          },
        },
      ],
    });
    expect(c.casts[0].replacement).toEqual({
      kind: 'photo',
      photoUrl: 'https://blob.test/s/c1.jpg',
      photoPathname: 'sessions/s/characters/c1/photo.jpg',
      description: 'new words',
      brandCharacterId: null,
      label: null,
    });
  });

  it('brand replacement accepts only photos from the manifest snapshot and fills the label', () => {
    expect(() =>
      normaliseCasting(session, undefined, {
        casts: [
          {
            characterId: 'c1',
            active: true,
            order: 1,
            replacement: {
              kind: 'brand',
              photoUrl: 'https://blob.test/other.png',
            },
          },
        ],
      }),
    ).toThrow(/not a brand character photo/);
    expect(() =>
      normaliseCasting(session, undefined, {
        casts: [
          {
            characterId: 'c1',
            active: true,
            order: 1,
            replacement: { kind: 'brand' },
          },
        ],
      }),
    ).toThrow(/needs a photo or a description/);
    const c = normaliseCasting(session, undefined, {
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: 1,
          replacement: {
            kind: 'brand',
            photoUrl: 'https://blob.test/bc1.png',
            brandCharacterId: 'bc1',
          },
        },
      ],
    });
    expect(c.casts[0].replacement).toEqual({
      kind: 'brand',
      photoUrl: 'https://blob.test/bc1.png',
      photoPathname: null,
      description: null,
      brandCharacterId: 'bc1',
      label: 'Бренд-Аня',
    });
  });
});

describe('castPhotoPathname', () => {
  it('maps mime → extension under the session', () => {
    expect(castPhotoPathname('s1', 'c2', 'image/png')).toBe(
      'sessions/s1/characters/c2/photo.png',
    );
    expect(castPhotoPathname('s1', 'c2', 'image/jpeg')).toBe(
      'sessions/s1/characters/c2/photo.jpg',
    );
  });
});

describe('CastingService', () => {
  function build(sess: Partial<Session> | undefined) {
    const sessions = {
      getSession: jest.fn().mockResolvedValue(sess),
      updateSession: jest
        .fn()
        .mockImplementation(async (_id: string, u: Partial<Session>) => ({
          ...sess,
          ...u,
        })),
    };
    const blob = {
      createUploadUrl: jest
        .fn()
        .mockResolvedValue({ uploadUrl: 'https://blob.test/put' }),
    };
    return {
      service: new CastingService(
        sessions as never,
        blob as never,
        plansMock() as never,
      ),
      sessions,
      blob,
    };
  }

  it('404s for a missing session; returns an empty casting when none saved', async () => {
    const { service } = build(undefined);
    await expect(service.get('s0')).rejects.toThrow(NotFoundException);
    const { service: s2 } = build({ ...session } as Session);
    expect(await s2.get('s1')).toEqual({ casts: [], updatedAt: '' });
  });

  it('upload-url only for analysed characters, at the session-scoped pathname', async () => {
    const { service, blob } = build({ ...session } as Session);
    await expect(
      service.createPhotoUploadUrl('s1', 'c9', {
        fileName: 'a.png',
        fileSize: 10,
        mimeType: 'image/png',
      }),
    ).rejects.toThrow(NotFoundException);
    const r = await service.createPhotoUploadUrl('s1', 'c2', {
      fileName: 'a.png',
      fileSize: 10,
      mimeType: 'image/png',
    });
    expect(r).toEqual({
      uploadUrl: 'https://blob.test/put',
      pathname: 'sessions/s1/characters/c2/photo.png',
    });
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      'sessions/s1/characters/c2/photo.png',
      'image/png',
      10 * 1024 * 1024,
    );
  });

  it('confirmPhoto verifies the blob, activates the character and appends it to the order', async () => {
    mockedHead.mockResolvedValue({
      url: 'https://blob.test/sessions/s1/characters/c2/photo.png',
    } as never);
    const existing: CharacterCasting = {
      updatedAt: '',
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: 1,
          replacement: {
            kind: 'none',
            photoUrl: null,
            photoPathname: null,
            description: null,
            brandCharacterId: null,
            label: null,
          },
        },
      ],
    };
    const { service, sessions } = build({
      ...session,
      characterCasting: existing,
    } as Session);
    const c = await service.confirmPhoto('s1', 'c2', {
      pathname: 'sessions/s1/characters/c2/photo.png',
      description: 'в худи',
    });
    expect(c.casts.map((x) => [x.characterId, x.order])).toEqual([
      ['c1', 1],
      ['c2', 2],
    ]);
    expect(c.casts[1].replacement).toMatchObject({
      kind: 'photo',
      photoUrl: 'https://blob.test/sessions/s1/characters/c2/photo.png',
      photoPathname: 'sessions/s1/characters/c2/photo.png',
      description: 'в худи',
    });
    expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
      characterCasting: c,
    });
  });

  it('confirmPhoto rejects a pathname from another session/character and a missing blob', async () => {
    const { service } = build({ ...session } as Session);
    await expect(
      service.confirmPhoto('s1', 'c1', {
        pathname: 'sessions/s2/characters/c1/photo.png',
      }),
    ).rejects.toThrow(/must start with/);
    mockedHead.mockRejectedValueOnce(new Error('404'));
    await expect(
      service.confirmPhoto('s1', 'c1', {
        pathname: 'sessions/s1/characters/c1/photo.png',
      }),
    ).rejects.toThrow(/not found in storage/);
  });

  it('confirmPhoto проверяет тариф — «превью как фото» больше не обходит гейт (§6.8)', async () => {
    const plans = plansMock();
    plans.assertUser.mockRejectedValue(new ForbiddenException('Standard+'));
    const service = new CastingService(
      {
        getSession: jest.fn().mockResolvedValue({ ...session, userId: 'u1' }),
      } as never,
      {} as never,
      plans as never,
    );
    mockedHead.mockClear();
    await expect(
      service.confirmPhoto('s1', 'c1', {
        pathname: 'sessions/s1/characters/c1/photo.png',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'characterReplacement');
    expect(mockedHead).not.toHaveBeenCalled();
  });

  it('assertPreviewAllowed: персонаж из разбора, тариф, гость и бюджет', async () => {
    const plans = plansMock();
    const getSession = jest.fn();
    const service = new CastingService(
      { getSession } as never,
      {} as never,
      plans as never,
    );

    getSession.mockResolvedValue({ ...session, userId: 'u1' });
    await expect(service.assertPreviewAllowed('s1', 'c1')).resolves.toBe('u1');
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'characterReplacement');
    expect(plans.assertCanSpendUser).toHaveBeenCalledWith('u1');

    await expect(
      service.assertPreviewAllowed('s1', 'nope'),
    ).rejects.toBeInstanceOf(NotFoundException);

    getSession.mockResolvedValue({ ...session, userId: null });
    await expect(
      service.assertPreviewAllowed('s1', 'c1'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    plans.assertCanSpendUser.mockRejectedValue(
      new ForbiddenException('budget'),
    );
    getSession.mockResolvedValue({ ...session, userId: 'u1' });
    await expect(
      service.assertPreviewAllowed('s1', 'c1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
