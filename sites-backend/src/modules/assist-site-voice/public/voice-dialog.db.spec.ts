import { randomUUID } from 'crypto';
import { describeDb } from '../../assist-sandbox/testing/k3-stack.testing';
import { ChatStack } from '../../assist-site-chat/testing/chat-stack.testing';
import {
  setPlan,
  seedUsage,
  usageOf,
} from '../../assist-billing/testing/billing-fixtures.testing';
import { ASSIST_PLANS } from '../../assist-billing/plans';
import { markVoiceDialog } from './voice-dialog';
import { claimPlanAnswer } from '../../assist-site-voice-control/public/plan-billing';

jest.setTimeout(120_000);

describeDb('voice billing atomicity under assist_public', () => {
  const st = new ChatStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });

  async function fixture(units: number) {
    const site = await st.stand('shop');
    await setPlan(st.owner, site.accountId, 'business');
    const state = await seedUsage(st.owner, site.accountId, {
      units,
      dialogs: 1,
    });
    const conv = await st.owner.assistSiteConversation.create({
      data: {
        accountId: site.accountId,
        siteId: site.siteId,
        visitorId: randomUUID(),
        ipHash: 'test',
        parentOrigin: 'https://sandbox.example.test',
        answers: 1,
        dialogCounted: true,
      },
    });
    const params = {
      accountId: site.accountId,
      conversationId: conv.id,
      state,
      preview: false,
    };
    return { site, conv, params };
  }

  it('parallel denied upgrades never report an unpaid voice as already paid', async () => {
    const f = await fixture(ASSIST_PLANS.business.dialogsPerMonth);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => markVoiceDialog(st.publicDb, f.params)),
    );
    expect(results).toEqual(Array(8).fill('denied'));
    expect(
      (
        await st.owner.assistSiteConversation.findUniqueOrThrow({
          where: { id: f.conv.id },
        })
      ).voice,
    ).toBe(false);
  });

  it('parallel denied commands cannot run in an unpaid conversation', async () => {
    const f = await fixture(ASSIST_PLANS.business.dialogsPerMonth);
    await st.owner.assistSiteConversation.update({
      where: { id: f.conv.id },
      data: { answers: 0, dialogCounted: false },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimPlanAnswer(st.publicDb, f.params)),
    );
    expect(results).toEqual(Array(8).fill(false));
    expect(
      await st.owner.assistSiteConversation.findUniqueOrThrow({
        where: { id: f.conv.id },
      }),
    ).toMatchObject({ answers: 0, dialogCounted: false });
  });

  it('chat first-answer billing rejects every parallel attempt at an exhausted quota', async () => {
    const f = await fixture(ASSIST_PLANS.business.dialogsPerMonth);
    await st.owner.assistSiteConversation.update({
      where: { id: f.conv.id },
      data: { answers: 0, dialogCounted: false },
    });
    const billing = st.chat as unknown as {
      claimDialog: (
        account: string,
        conv: string,
        state: typeof f.params.state,
      ) => Promise<boolean>;
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        billing.claimDialog(f.site.accountId, f.conv.id, f.params.state),
      ),
    );
    expect(results).toEqual(Array(8).fill(false));
    expect(
      await st.owner.assistSiteConversation.findUniqueOrThrow({
        where: { id: f.conv.id },
      }),
    ).toMatchObject({ answers: 0, dialogCounted: false });
  });

  it('chat quota exceptions roll back both answer count and first-dialog flag', async () => {
    const f = await fixture(1);
    await st.owner.assistSiteConversation.update({
      where: { id: f.conv.id },
      data: { answers: 0, dialogCounted: false },
    });
    const billing = st.chat as unknown as {
      claimDialog: (
        account: string,
        conv: string,
        state: typeof f.params.state,
      ) => Promise<boolean>;
    };
    const fail = jest
      .spyOn(st.quota, 'claim')
      .mockRejectedValueOnce(new Error('injected chat quota failure'));
    try {
      await expect(
        billing.claimDialog(f.site.accountId, f.conv.id, f.params.state),
      ).rejects.toThrow('injected chat quota failure');
      expect(
        await st.owner.assistSiteConversation.findUniqueOrThrow({
          where: { id: f.conv.id },
        }),
      ).toMatchObject({ answers: 0, dialogCounted: false });
    } finally {
      fail.mockRestore();
    }
  });

  it('parallel successful upgrades reserve the difference exactly once', async () => {
    const f = await fixture(1);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => markVoiceDialog(st.publicDb, f.params)),
    );
    expect(results.filter((x) => x === 'marked')).toHaveLength(1);
    expect(results.filter((x) => x === 'already')).toHaveLength(7);
    expect((await usageOf(st.owner, f.site.accountId))?.units).toBe(2);
  });

  it('a database failure during the quota claim cannot leave the voice flag set', async () => {
    const f = await fixture(1);
    const injectFailure = (client: typeof st.publicDb) =>
      new Proxy(client, {
        get(target, key) {
          if (key === '$executeRawUnsafe')
            return async (sql: string, ...values: unknown[]) => {
              if (
                sql.startsWith('UPDATE "sites"."assist_account_usage"') &&
                sql.includes('"units" + $3')
              )
                throw new Error('injected quota failure');
              return target.$executeRawUnsafe(sql, ...values);
            };
          if (key === '$transaction')
            return (body: (tx: typeof st.publicDb) => Promise<unknown>) =>
              target.$transaction((tx) =>
                body(injectFailure(tx as typeof st.publicDb)),
              );
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    await expect(
      markVoiceDialog(injectFailure(st.publicDb), f.params),
    ).rejects.toThrow('injected quota failure');
    expect(
      (
        await st.owner.assistSiteConversation.findUniqueOrThrow({
          where: { id: f.conv.id },
        })
      ).voice,
    ).toBe(false);
    expect((await usageOf(st.owner, f.site.accountId))?.units).toBe(1);
  });
});
