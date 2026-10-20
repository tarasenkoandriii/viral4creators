/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma mock */
import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  STORY_TERMS_VERSION,
  loadStoryAccess,
  storyAccessView,
  storyPilotMaxMembers,
  storyTalesMode,
} from './story-access';
import {
  StoryAccessGuard,
  StoryOwnerOnlyGuard,
  StoryPublicAccessGuard,
} from './story-access.guard';
import {
  PublicStoryGiftController,
  StoryGiftsController,
} from './story-gifts.controller';
import { StoryReferenceLibraryController } from './story-reference-library.controller';
import { NarratorLooksController } from '../brand-manifest/narrator-looks.controller';
import { StoryAccessController } from './story-pilot.controller';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';

type Member = {
  revokedAt?: Date | null;
  freeGiftUsedAt?: Date | null;
} | null;
function world(
  opts: {
    member?: Member;
    application?: string | null;
    terms?: string[];
  } = {},
) {
  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 'owner-id' && where.telegramId === 'owner-tg'
          ? { id: 'owner-id' }
          : null,
      ),
    },
    storyPilotMember: {
      findUnique: jest.fn(async () =>
        opts.member
          ? {
              id: 'm1',
              since: new Date('2026-10-01'),
              revokedAt: opts.member.revokedAt ?? null,
              freeGiftUsedAt: opts.member.freeGiftUsedAt ?? null,
              freeGiftId: opts.member.freeGiftUsedAt ? 'g0' : null,
            }
          : null,
      ),
    },
    storyPilotApplication: {
      findUnique: jest.fn(async () =>
        opts.application
          ? {
              id: 'a1',
              status: opts.application,
              createdAt: new Date('2026-10-02T00:00:00Z'),
            }
          : null,
      ),
    },
    storyTermsAcceptance: {
      findMany: jest.fn(async () =>
        (opts.terms ?? []).map((termsVersion) => ({ termsVersion })),
      ),
    },
  };
  return prisma;
}
const ctx = (userId: string | undefined, method = 'GET', res?: any) => {
  const req: any = { telegramUserId: userId, method };
  return {
    req,
    context: {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext,
  };
};

describe('ST3 Story-Tales access modes (StoryAccessGuard)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.STORY_TALES_OWNER_TELEGRAM_ID = 'owner-tg';
    delete process.env.STORY_TALES_ACCESS;
    delete process.env.STORY_PILOT_MAX_MEMBERS;
  });
  afterAll(() => {
    process.env = saved;
  });
  const run = async (
    prisma: any,
    userId: string | undefined,
    method = 'GET',
  ) => {
    const guard = new StoryAccessGuard(prisma);
    const { context, req } = ctx(userId, method);
    try {
      return { ok: await guard.canActivate(context), req };
    } catch (e) {
      return { error: e, req };
    }
  };

  it('mode: owner by default and for any unknown value; pilot/public as written', () => {
    expect(storyTalesMode({})).toBe('owner');
    expect(storyTalesMode({ STORY_TALES_ACCESS: 'PUBLIC ' })).toBe('public');
    expect(storyTalesMode({ STORY_TALES_ACCESS: 'pilot' })).toBe('pilot');
    for (const v of ['', 'open', 'true', '1', 'owners'])
      expect(storyTalesMode({ STORY_TALES_ACCESS: v })).toBe('owner');
  });
  it('pilot seats: default 15, invalid → 15, 0 allowed, never above 15 (правила 2.1)', () => {
    expect(storyPilotMaxMembers({})).toBe(15);
    expect(storyPilotMaxMembers({ STORY_PILOT_MAX_MEMBERS: '10' })).toBe(10);
    expect(storyPilotMaxMembers({ STORY_PILOT_MAX_MEMBERS: '0' })).toBe(0);
    for (const v of ['-1', '2.5', 'many'])
      expect(storyPilotMaxMembers({ STORY_PILOT_MAX_MEMBERS: v })).toBe(15);
    // ST3-R-06: above the rules' cap → 15 (with a warning in the log).
    for (const v of ['16', '20', '100000'])
      expect(storyPilotMaxMembers({ STORY_PILOT_MAX_MEMBERS: v })).toBe(15);
  });

  describe('owner mode', () => {
    it('the owner reads and builds without rules', async () => {
      const p = world();
      expect((await run(p, 'owner-id', 'POST')).ok).toBe(true);
      expect((await run(p, 'owner-id', 'GET')).ok).toBe(true);
    });
    it('anyone else — 404 for every method, even a member with accepted rules', async () => {
      const p = world({ member: {}, terms: [STORY_TERMS_VERSION] });
      for (const m of ['GET', 'POST', 'DELETE'])
        expect((await run(p, 'member-id', m)).error).toBeInstanceOf(
          NotFoundException,
        );
      // Owner mode costs a non-owner one query, nothing about the pilot.
      expect(p.storyPilotMember.findUnique).not.toHaveBeenCalled();
    });
    it('fails closed without the owner configuration and for anonymous requests', async () => {
      delete process.env.STORY_TALES_OWNER_TELEGRAM_ID;
      const p = world();
      expect((await run(p, 'owner-id', 'GET')).error).toBeInstanceOf(
        NotFoundException,
      );
      expect((await run(p, undefined, 'GET')).error).toBeInstanceOf(
        NotFoundException,
      );
      expect(p.user.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('pilot mode', () => {
    beforeEach(() => {
      process.env.STORY_TALES_ACCESS = 'pilot';
    });
    it('owner: full access', async () => {
      expect((await run(world(), 'owner-id', 'POST')).ok).toBe(true);
    });
    it('active member with current rules: full access; facts on the request', async () => {
      const r = await run(
        world({ member: {}, terms: [STORY_TERMS_VERSION] }),
        'm-id',
        'POST',
      );
      expect(r.ok).toBe(true);
      expect(r.req.storyAccess).toMatchObject({
        mode: 'pilot',
        isOwner: false,
      });
    });
    it('active member without rules: reads, POST — 403 STORY_TERMS_REQUIRED', async () => {
      const p = world({ member: {}, terms: ['story-rules-old'] });
      expect((await run(p, 'm-id', 'GET')).ok).toBe(true);
      const { error } = await run(p, 'm-id', 'POST');
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'STORY_TERMS_REQUIRED',
      });
    });
    it('revoked member: GET/DELETE own data, never a new build (404)', async () => {
      const p = world({
        member: { revokedAt: new Date() },
        terms: [STORY_TERMS_VERSION],
      });
      expect((await run(p, 'm-id', 'GET')).ok).toBe(true);
      expect((await run(p, 'm-id', 'DELETE')).ok).toBe(true);
      expect((await run(p, 'm-id', 'POST')).error).toBeInstanceOf(
        NotFoundException,
      );
    });
    it('not invited / pending application: 404 everywhere', async () => {
      for (const application of [null, 'pending', 'rejected']) {
        const p = world({ application, terms: [STORY_TERMS_VERSION] });
        for (const m of ['GET', 'POST'])
          expect((await run(p, 'x-id', m)).error).toBeInstanceOf(
            NotFoundException,
          );
      }
    });
  });

  describe('public mode', () => {
    beforeEach(() => {
      process.env.STORY_TALES_ACCESS = 'public';
    });
    it('any user after 18+ and rules: full access', async () => {
      expect(
        (await run(world({ terms: [STORY_TERMS_VERSION] }), 'u-id', 'POST')).ok,
      ).toBe(true);
    });
    it('user without rules: 403 on POST, 404 on GET (nothing to read yet)', async () => {
      const p = world();
      expect((await run(p, 'u-id', 'POST')).error).toBeInstanceOf(
        ForbiddenException,
      );
      expect((await run(p, 'u-id', 'GET')).error).toBeInstanceOf(
        NotFoundException,
      );
    });
    it('rules updated: an earlier acceptance still reads its data, builds need the new version', async () => {
      const p = world({ terms: ['story-rules-old'] });
      expect((await run(p, 'u-id', 'GET')).ok).toBe(true);
      expect((await run(p, 'u-id', 'POST')).error).toBeInstanceOf(
        ForbiddenException,
      );
    });
    it('ST3-U-01: a revoked pilot member is an ordinary user in public', async () => {
      const p = world({
        member: { revokedAt: new Date() },
        terms: [STORY_TERMS_VERSION],
      });
      expect((await run(p, 'm-id', 'POST')).ok).toBe(true);
      expect((await run(p, 'm-id', 'GET')).ok).toBe(true);
      expect(
        storyAccessView(await loadStoryAccess(p as any, 'm-id')),
      ).toMatchObject({
        allowed: true,
        role: 'user',
        readOnly: false,
        freeGiftAvailable: false,
      });
    });
  });

  describe('GET /story-gifts/access view', () => {
    const view = async (prisma: any, userId: string, seats?: any) =>
      storyAccessView(await loadStoryAccess(prisma, userId), seats);
    it('owner mode, not the owner: closed, nothing else', async () => {
      expect(await view(world({ member: {} }), 'x')).toEqual({
        mode: 'owner',
        allowed: false,
        role: null,
        reason: 'closed',
        freeGiftAvailable: false,
        readOnly: false,
        termsVersion: STORY_TERMS_VERSION,
      });
    });
    it('ST3-U-01: pilot, revoked member — role revoked, reason pilot_revoked, readOnly', async () => {
      process.env.STORY_TALES_ACCESS = 'pilot';
      expect(
        await view(
          world({
            member: { revokedAt: new Date() },
            application: 'approved',
            terms: [STORY_TERMS_VERSION],
          }),
          'x',
          { active: 3, max: 15 },
        ),
      ).toMatchObject({
        allowed: false,
        role: 'revoked',
        reason: 'pilot_revoked',
        readOnly: true,
        freeGiftAvailable: false,
      });
    });
    it('owner: allowed, no free gift, no rules needed', async () => {
      process.env.STORY_TALES_ACCESS = 'pilot';
      expect(
        await view(world(), 'owner-id', { active: 3, max: 15 }),
      ).toMatchObject({
        mode: 'pilot',
        allowed: true,
        role: 'owner',
        freeGiftAvailable: false,
        seatsLeft: 12,
        maxMembers: 15,
      });
    });
    it('pilot: pending application, not invited, terms required, member with free gift', async () => {
      process.env.STORY_TALES_ACCESS = 'pilot';
      expect(await view(world({ application: 'pending' }), 'x')).toMatchObject({
        allowed: false,
        role: 'user',
        reason: 'application_pending',
        application: {
          status: 'pending',
          createdAt: '2026-10-02T00:00:00.000Z',
        },
      });
      expect(await view(world({ application: 'rejected' }), 'x')).toMatchObject(
        {
          allowed: false,
          reason: 'not_invited',
          application: { status: 'rejected' },
        },
      );
      expect(await view(world({ member: {} }), 'x')).toMatchObject({
        allowed: false,
        role: 'member',
        reason: 'terms_required',
        freeGiftAvailable: true,
      });
      const ready = await view(
        world({ member: {}, terms: [STORY_TERMS_VERSION] }),
        'x',
        { active: 15, max: 15 },
      );
      expect(ready).toMatchObject({
        allowed: true,
        role: 'member',
        freeGiftAvailable: true,
        seatsLeft: 0,
      });
      expect(ready.reason).toBeUndefined();
      expect(
        await view(
          world({
            member: { freeGiftUsedAt: new Date() },
            terms: [STORY_TERMS_VERSION],
          }),
          'x',
        ),
      ).toMatchObject({ freeGiftAvailable: false });
    });
    it('public: user role, no seats, terms gate', async () => {
      process.env.STORY_TALES_ACCESS = 'public';
      const v = await view(world(), 'x', { active: 1, max: 15 });
      expect(v).toMatchObject({
        mode: 'public',
        allowed: false,
        role: 'user',
        reason: 'terms_required',
      });
      expect(v.seatsLeft).toBeUndefined();
    });
  });

  it('every user Story route and narrator looks use StoryAccessGuard; access only identity', () => {
    for (const controller of [
      StoryGiftsController,
      StoryReferenceLibraryController,
      NarratorLooksController,
    ])
      expect(
        Reflect.getMetadata(GUARDS_METADATA, controller).slice(0, 2),
      ).toEqual([TelegramIdentityGuard, StoryAccessGuard]);
    // Р-ST3-BE-18: Gemini features are owner-only until priced in credits.
    for (const controller of [
      StoryReferenceLibraryController,
      NarratorLooksController,
    ])
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)[2]).toBe(
        StoryOwnerOnlyGuard,
      );
    for (const method of ['referenceList', 'referenceAnalyze'] as const)
      expect(
        Reflect.getMetadata(
          GUARDS_METADATA,
          StoryGiftsController.prototype[method],
        ),
      ).toEqual([StoryOwnerOnlyGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, StoryAccessController)).toEqual(
      [TelegramIdentityGuard],
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PublicStoryGiftController),
    ).toEqual([StoryPublicAccessGuard]);
  });

  it('public gift guard: 404 in owner mode, open in pilot/public; headers always set', () => {
    const guard = new StoryPublicAccessGuard();
    for (const mode of [undefined, 'pilot', 'public']) {
      if (mode) process.env.STORY_TALES_ACCESS = mode;
      else delete process.env.STORY_TALES_ACCESS;
      const res = { set: jest.fn() };
      const { context } = ctx(undefined, 'GET', res);
      let outcome: unknown;
      try {
        outcome = guard.canActivate(context);
      } catch (e) {
        outcome = e;
      }
      expect(
        mode ? outcome === true : outcome instanceof NotFoundException,
      ).toBe(true);
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
          'Referrer-Policy': 'no-referrer',
        }),
      );
    }
  });

  it('owner-only guard: owner passes, a member gets 403 STORY_FEATURE_OWNER_ONLY', () => {
    const guard = new StoryOwnerOnlyGuard();
    const at = (storyAccess: any) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ storyAccess }) }),
      }) as unknown as ExecutionContext;
    expect(guard.canActivate(at({ isOwner: true }))).toBe(true);
    let err: unknown;
    try {
      guard.canActivate(at({ isOwner: false, mode: 'pilot' }));
    } catch (e) {
      err = e;
    }
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'STORY_FEATURE_OWNER_ONLY',
    });
    expect(() => guard.canActivate(at(undefined))).toThrow(NotFoundException);
  });

  it('share route: 404 in owner mode before the service is called', async () => {
    delete process.env.STORY_TALES_ACCESS;
    const service = { share: jest.fn() };
    const controller = new StoryGiftsController(
      service as any,
      {} as any,
      {} as any,
    );
    await expect(
      controller.share({ telegramUserId: 'owner-id' } as any, 'g1', {
        acknowledgePublic: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(service.share).not.toHaveBeenCalled();
  });
});
