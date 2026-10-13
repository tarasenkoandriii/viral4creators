import { SiteIndexingService } from '../modules/assist-site-knowledge/site-indexing.service';
import { AdminIndexingService } from '../modules/assist-admin-knowledge/admin-indexing.service';
describe('indexing failure accounting', () => {
  it.each([SiteIndexingService, AdminIndexingService])(
    '%p retains failures and continues another site',
    async (Type) => {
      const service = Object.assign(Object.create(Type.prototype), {
        knowledge: {
          engine: {
            reapStaleBuilds: jest
              .fn()
              .mockRejectedValue(new Error('cleanup unavailable')),
          },
        },
        logger: { error: jest.fn() },
        candidates: jest
          .fn()
          .mockResolvedValue([{ siteId: 'failed' }, { siteId: 'healthy' }]),
        indexSite: jest
          .fn()
          .mockRejectedValueOnce(new Error('index unavailable'))
          .mockResolvedValue({
            embedded: 0,
            reused: 0,
            budgetExhausted: false,
          }),
      });
      const result = await service.tick(10000);
      expect(result).toMatchObject({
        failed: 1,
        cleanupErrors: 1,
        sitesTouched: 1,
      });
      expect(service.indexSite).toHaveBeenCalledTimes(2);
    },
  );
});
