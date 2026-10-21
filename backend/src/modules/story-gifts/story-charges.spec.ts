/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma mock */
import { HttpException } from '@nestjs/common';
import { detailsOf } from '../../common/filters/http-exception.filter';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import { StoryChargesService } from './story-charges.service';
import type { StoryAccessFacts } from './story-access';
import {
  STORY_PRICE_FLOOR_MICRO_USD,
  storyCreditMicroUsd,
  storyCreditPrice,
  storyPriceFromUsd,
  storyPriceMicroUsd,
} from './story-pricing';

describe('ST3 Story price in credits (pure)', () => {
  it('P = max($2.99, reserve / (1 − 0.30 − 0.50))', () => {
    expect(storyPriceMicroUsd(0)).toBe(STORY_PRICE_FLOOR_MICRO_USD);
    expect(storyPriceMicroUsd(500_000)).toBe(STORY_PRICE_FLOOR_MICRO_USD);
    expect(storyPriceMicroUsd(598_000)).toBe(2_990_000);
    expect(storyPriceMicroUsd(600_000)).toBe(3_000_000);
    expect(storyPriceMicroUsd(1_000_001)).toBe(5_000_005);
    expect(storyPriceMicroUsd(-5)).toBe(STORY_PRICE_FLOOR_MICRO_USD);
  });
  it('one credit at the cheapest real pack price (default: 900★ / 20 = $0.675)', () => {
    expect(storyCreditMicroUsd({})).toBe(675_000);
    // A cheaper WayForPay pack wins; promo/zero packs are ignored.
    expect(
      storyCreditMicroUsd({
        CREDIT_PACK_SMALL_UAH_KOPECKS: '10000',
        CREDIT_PACK_LARGE_STARS: '0',
      }),
    ).toBe(480_000);
    expect(
      storyCreditMicroUsd({
        CREDIT_PACK_SMALL_CREDITS: '0',
        CREDIT_PACK_LARGE_CREDITS: '0',
      }),
    ).toBeNull();
  });
  it('rounds credits up and reports the USD equivalent', () => {
    expect(storyCreditPrice(0, {})).toEqual({
      credits: 5,
      priceMicroUsd: 2_990_000,
      usdEquivalent: 3.38,
    });
    // $1.30 reserve → $6.50 → 9.63 credits → 10.
    expect(storyCreditPrice(1_300_000, {})).toMatchObject({
      credits: 10,
      priceMicroUsd: 6_500_000,
      usdEquivalent: 6.75,
    });
    // An exactly divisible price is not bumped by float noise: $2.99 / $0.598 = 5.
    expect(
      storyCreditPrice(0, {
        FX_MICRO_USD_PER_STAR: '11960',
        CREDIT_PACK_SMALL_UAH_KOPECKS: '0',
        CREDIT_PACK_LARGE_CREDITS: '0',
      }),
    ).toMatchObject({ credits: 5, usdEquivalent: 2.99 });
    expect(
      storyCreditPrice(0, {
        CREDIT_PACK_SMALL_CREDITS: '0',
        CREDIT_PACK_LARGE_CREDITS: '0',
      }),
    ).toBeNull();
    expect(storyPriceFromUsd({})).toBe(3.38);
  });
});

function world(opts: { balance?: number; member?: any } = {}) {
  const ledger: any[] = opts.balance
    ? [
        {
          userId: 'u1',
          delta: opts.balance,
          reason: 'PURCHASE',
          generatedVideoId: null,
        },
      ]
    : [];
  const charges: any[] = [];
  let member = opts.member
    ? {
        userId: 'u1',
        revokedAt: null,
        freeGiftId: null,
        freeGiftUsedAt: null,
        ...opts.member,
      }
    : null;
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([k, v]: [string, any]) =>
      v && typeof v === 'object' && !(v instanceof Date) && 'in' in v
        ? v.in.includes(row[k])
        : row[k] === v,
    );
  const prisma: any = {
    creditLedger: {
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          delta: ledger
            .filter((r) => r.userId === where.userId)
            .reduce((s, r) => s + r.delta, 0),
        },
      })),
      findFirst: jest.fn(
        async ({ where }: any) => ledger.find((r) => matches(r, where)) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        if (
          ledger.some(
            (r) =>
              r.generatedVideoId &&
              r.generatedVideoId === data.generatedVideoId &&
              r.reason === data.reason,
          )
        )
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        ledger.push({ ...data });
        return data;
      }),
    },
    storyCreditCharge: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          charges.find((c) => c.key === where.key) ?? null,
      ),
      findFirst: jest.fn(
        async ({ where }: any) =>
          charges.find((c) => matches(c, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        charges.filter((c) => matches(c, where)),
      ),
      count: jest.fn(
        async ({ where }: any) =>
          charges.filter((c) => matches(c, where)).length,
      ),
      create: jest.fn(async ({ data }: any) => {
        charges.push({ status: 'RESERVED', refundedAt: null, ...data });
        return data;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = charges.filter((c) => matches(c, where));
        hit.forEach((c) => Object.assign(c, data));
        return { count: hit.length };
      }),
    },
    storyPilotMember: {
      findUnique: jest.fn(async () => (member ? { ...member } : null)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!member || !matches(member, where)) return { count: 0 };
        member = { ...member, ...data };
        return { count: 1 };
      }),
    },
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const credit = new CreditLedgerService(prisma, { alert: jest.fn() } as any);
  const service = new StoryChargesService(prisma, credit);
  const facts = (over: Partial<StoryAccessFacts> = {}): StoryAccessFacts => ({
    mode: 'pilot',
    isOwner: false,
    member: member ? { id: 'm1', since: new Date(0), ...member } : null,
    application: null,
    termsAccepted: true,
    termsEverAccepted: true,
    ...over,
  });
  const balance = () =>
    ledger.filter((r) => r.userId === 'u1').reduce((s, r) => s + r.delta, 0);
  return {
    prisma,
    service,
    facts,
    ledger,
    charges,
    balance,
    member: () => member,
  };
}
const audio = {
  kind: 'audio' as const,
  giftId: 'g1',
  reserveMicroUsd: 120_000,
};
const video = (renderId: string, giftId = 'g1') => ({
  kind: 'video' as const,
  giftId,
  renderId,
  reserveMicroUsd: 600_000,
});

describe('ST3 StoryChargesService (Р-ST3-2)', () => {
  it('owner and owner mode pay 0 and write nothing', async () => {
    const w = world({ balance: 0 });
    for (const f of [w.facts({ isOwner: true }), w.facts({ mode: 'owner' })]) {
      expect(await w.service.quote(f, 'u1', audio)).toEqual({
        credits: 0,
        usdEquivalent: 0,
        free: false,
      });
      expect(await w.service.reserve(w.prisma, f, 'u1', audio)).toEqual({
        credits: 0,
        usdEquivalent: 0,
        free: false,
      });
    }
    expect(w.charges).toHaveLength(0);
    expect(w.ledger).toHaveLength(0);
  });
  it('a paying user: quote = reserve, credits leave the ledger once; a repeat is idempotent', async () => {
    const w = world({ balance: 12 });
    const f = w.facts({ mode: 'public' });
    expect(await w.service.quote(f, 'u1', audio)).toEqual({
      credits: 5,
      usdEquivalent: 3.38,
      free: false,
    });
    expect(await w.service.reserve(w.prisma, f, 'u1', audio)).toEqual({
      credits: 5,
      usdEquivalent: 3.38,
      free: false,
    });
    expect(await w.service.reserve(w.prisma, f, 'u1', audio)).toMatchObject({
      credits: 5,
    });
    expect(w.balance()).toBe(7);
    expect(w.ledger.filter((r) => r.reason === 'CONSUME')).toEqual([
      expect.objectContaining({
        delta: -5,
        generatedVideoId: 'story:audio:g1:1',
      }),
    ]);
    // The card now shows the reserved charge.
    expect(await w.service.quote(f, 'u1', audio)).toMatchObject({
      credits: 5,
      status: 'reserved',
    });
  });
  it('not enough credits: 402 STORY_CREDITS_REQUIRED with required and balance, nothing written', async () => {
    const w = world({ balance: 3 });
    const err = await w.service
      .reserve(w.prisma, w.facts({ mode: 'public' }), 'u1', audio)
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(402);
    expect(err.getResponse()).toMatchObject({
      code: 'STORY_CREDITS_REQUIRED',
      upstreamDetails: { required: 5, balance: 3 },
    });
    expect(w.charges).toHaveLength(0);
    expect(w.balance()).toBe(3);
    // The client receives error.details {code, required, balance}.
    expect(detailsOf(err.getResponse())).toEqual({
      code: 'STORY_CREDITS_REQUIRED',
      required: 5,
      balance: 3,
    });
  });
  it('member: the first gift is free (audio + its first video), the next ones are paid', async () => {
    const w = world({ balance: 20, member: {} });
    expect(await w.service.quote(w.facts(), 'u1', audio)).toEqual({
      credits: 0,
      usdEquivalent: 0,
      free: true,
    });
    expect(await w.service.reserve(w.prisma, w.facts(), 'u1', audio)).toEqual({
      credits: 0,
      usdEquivalent: 0,
      free: true,
    });
    expect(w.member()).toMatchObject({
      freeGiftId: 'g1',
      freeGiftUsedAt: expect.any(Date),
    });
    expect(
      await w.service.reserve(w.prisma, w.facts(), 'u1', video('r1')),
    ).toMatchObject({ free: true });
    // Second video of the free gift — paid; another gift — paid.
    expect(
      await w.service.reserve(w.prisma, w.facts(), 'u1', video('r2')),
    ).toMatchObject({ free: false, credits: 5 });
    expect(
      await w.service.reserve(w.prisma, w.facts(), 'u1', {
        ...audio,
        giftId: 'g2',
      }),
    ).toMatchObject({ free: false, credits: 5 });
    expect(w.balance()).toBe(10);
  });
  it('refund on a final FAILED: exact credits back once; free charge restores the free gift', async () => {
    const w = world({
      balance: 10,
      member: { freeGiftId: 'g0', freeGiftUsedAt: new Date() },
    });
    await w.service.reserve(w.prisma, w.facts(), 'u1', video('r9', 'g5'));
    expect(w.balance()).toBe(5);
    expect(await w.service.refund('video:r9')).toEqual({
      refunded: true,
      credits: 5,
    });
    expect(await w.service.refund('video:r9')).toEqual({
      refunded: false,
      credits: 0,
    });
    expect(w.balance()).toBe(10);
    expect(w.charges[0]).toMatchObject({
      status: 'REFUNDED',
      refundedAt: expect.any(Date),
    });

    const f = world({ member: {} });
    await f.service.reserve(f.prisma, f.facts(), 'u1', audio);
    expect(f.member()!.freeGiftId).toBe('g1');
    await f.service.refund('audio:g1:1');
    expect(f.member()).toMatchObject({
      freeGiftId: null,
      freeGiftUsedAt: null,
    });
    expect(await f.service.refund('audio:unknown')).toEqual({
      refunded: false,
      credits: 0,
    });
  });
  it('ST3-R-05: after a refund the same gift is voiced again with a new attempt key', async () => {
    const w = world({ balance: 10 });
    const f = w.facts({ mode: 'public' });
    await w.service.reserve(w.prisma, f, 'u1', audio);
    expect(await w.service.refundAudio('g1')).toEqual({
      refunded: true,
      credits: 5,
    });
    await w.service.reserve(w.prisma, f, 'u1', audio);
    expect(w.charges.map((c) => [c.key, c.status])).toEqual([
      ['audio:g1:1', 'REFUNDED'],
      ['audio:g1:2', 'RESERVED'],
    ]);
    expect(w.balance()).toBe(5);
    // A RESERVED audio charge (operator reopen) is reused, not charged twice.
    await w.service.reserve(w.prisma, f, 'u1', audio);
    expect(w.charges).toHaveLength(2);
  });
  it('a refunded video render is never re-reserved (STORY_CHARGE_CLOSED)', async () => {
    const w = world({ balance: 10 });
    const f = w.facts({ mode: 'public' });
    await w.service.reserve(w.prisma, f, 'u1', video('r1'));
    await w.service.refund('video:r1');
    await expect(
      w.service.reserve(w.prisma, f, 'u1', video('r1')),
    ).rejects.toMatchObject({ response: { code: 'STORY_CHARGE_CLOSED' } });
  });
  it('ST3-S-12: expectedCredits ≠ the charge → 409 STORY_PRICE_CHANGED with {charge}, nothing written', async () => {
    const w = world({ balance: 10 });
    const f = w.facts({ mode: 'public' });
    const err = await w.service
      .reserve(w.prisma, f, 'u1', audio, 4)
      .catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(detailsOf(err.getResponse())).toEqual({
      code: 'STORY_PRICE_CHANGED',
      charge: { credits: 5, usdEquivalent: 3.38, free: false },
    });
    expect(w.ledger).toHaveLength(1);
    expect(w.charges).toHaveLength(0);
    await expect(
      w.service.reserve(w.prisma, f, 'u1', audio, 5),
    ).resolves.toMatchObject({ credits: 5 });
    // Owner: 0; a free member gift: 0.
    await expect(
      w.service.reserve(w.prisma, w.facts({ isOwner: true }), 'u1', audio, 5),
    ).rejects.toMatchObject({ response: { code: 'STORY_PRICE_CHANGED' } });
    const m = world({ member: {} });
    await expect(
      m.service.reserve(m.prisma, m.facts(), 'u1', audio, 0),
    ).resolves.toMatchObject({ free: true });
  });
  it('a failed refund after FAILED is logged, never thrown', async () => {
    const w = world({ balance: 10 });
    w.prisma.$transaction = jest.fn(async () => {
      throw new Error('db down');
    });
    await expect(w.service.refundQuietly('video:r1')).resolves.toBeUndefined();
  });
  it('ST3-S-14: capture marks a delivered step paid; a captured charge is never refunded; a captured free video stays used', async () => {
    const w = world({ balance: 10, member: {} });
    await w.service.reserve(w.prisma, w.facts(), 'u1', audio);
    await w.service.reserve(w.prisma, w.facts(), 'u1', video('r1'));
    expect(await w.service.captureAudio('g1')).toBe(1);
    expect(await w.service.capture('video:r1')).toBe(1);
    expect(w.charges.map((c) => c.status)).toEqual(['CAPTURED', 'CAPTURED']);
    expect(w.charges[0].capturedAt).toBeInstanceOf(Date);
    expect(await w.service.refund('video:r1')).toEqual({
      refunded: false,
      credits: 0,
    });
    // The free first video was used: the next video of the gift is paid.
    expect(
      await w.service.reserve(w.prisma, w.facts(), 'u1', video('r2')),
    ).toMatchObject({ free: false, credits: 5 });
    expect((await w.service.audioCharges(['g1'])).get('g1')).toMatchObject({
      status: 'captured',
    });
  });
  it('a video charge requires the render id', async () => {
    const w = world({ balance: 10 });
    await expect(
      w.service.reserve(w.prisma, w.facts({ mode: 'public' }), 'u1', {
        kind: 'video',
        giftId: 'g1',
        reserveMicroUsd: 1,
      }),
    ).rejects.toThrow('render id');
  });
  it('audio charges of the list come in one query', async () => {
    const w = world({ balance: 10 });
    await w.service.reserve(w.prisma, w.facts({ mode: 'public' }), 'u1', audio);
    const map = await w.service.audioCharges(['g1', 'g2']);
    expect([...map.keys()]).toEqual(['g1']);
    expect(w.prisma.storyCreditCharge.findMany).toHaveBeenCalledTimes(1);
    expect(await w.service.audioCharges([])).toEqual(new Map());
  });
});

describe('Story stale refund rechecks the step after the sweep selected it', () => {
  it.each(['audio', 'video'])(
    '%s delivered before refund transaction is not refunded',
    async (kind) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ status: 'READY' }]),
        storyOperatorAction: { create: jest.fn() },
      };
      const db = {
        $queryRaw: jest
          .fn()
          .mockResolvedValue([
            { key: 'selected', kind, giftId: 'g', renderId: 'r' },
          ]),
        $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
          fn(tx),
        ),
      };
      const service = new StoryChargesService(db as never, {} as never);
      const refund = jest
        .spyOn(service, 'refund')
        .mockResolvedValue({ refunded: true, credits: 5 });
      expect(await service.autoRefundStale()).toBe(0);
      expect(refund).not.toHaveBeenCalled();
      expect(tx.storyOperatorAction.create).not.toHaveBeenCalled();
    },
  );
});
