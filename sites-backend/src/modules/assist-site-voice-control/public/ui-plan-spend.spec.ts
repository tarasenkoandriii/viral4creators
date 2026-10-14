import { Logger } from '@nestjs/common';
import { SiteUiPlanService, UiPlanCtx } from './ui-plan.service';
import { TextModelError } from '../../site-ai/text-model';
import { estimateCost } from '../../../shared/ai-pricing';
import type { SubscriptionState } from '../../assist-billing/subscription-state';

type Dependencies = ConstructorParameters<typeof SiteUiPlanService>;
describe('planner provider spend after ledger failure', () => {
  beforeAll(() => Logger.overrideLogger(false));
  it.each(['success', 'empty'] as const)(
    '%s keeps paid usage in budget settlement',
    async (kind) => {
      const spent = {
        model: 'gemini-3.1-flash-lite',
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 100,
      };
      const settle = jest.fn().mockResolvedValue(undefined);
      const record = jest
        .fn()
        .mockRejectedValue(new Error('ledger unavailable'));
      const service = new SiteUiPlanService(
        {
          $queryRawUnsafe: jest.fn().mockResolvedValue([{ cap: null }]),
        } as unknown as Dependencies[0],
        {
          reserve: jest
            .fn()
            .mockResolvedValue({ ok: true, reservation: 'reservation' }),
          settle,
        } as unknown as Dependencies[1],
        { record } as unknown as Dependencies[2],
        {
          generate: jest.fn().mockImplementation(async () => {
            if (kind === 'empty') throw new TextModelError('empty', spent);
            return { text: '{}', ...spent };
          }),
        } as unknown as Dependencies[3],
        {} as Dependencies[4],
      );
      await expect(
        service['paidModelCall'](
          { site: { siteId: 'sandbox', accountId: 'owner' } } as UiPlanCtx,
          { planId: 'pro' } as SubscriptionState,
          {
            system: 's',
            user: 'u',
            estMicroUsd: 1000,
            maxOutputTokens: 100,
            timeoutMs: 1000,
            now: new Date(),
          },
        ),
      ).rejects.toMatchObject({ failure: 'upstream' });
      expect(record).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(
        expect.anything(),
        'reservation',
        estimateCost(spent.model, spent).costMicroUsd,
      );
    },
  );
});
