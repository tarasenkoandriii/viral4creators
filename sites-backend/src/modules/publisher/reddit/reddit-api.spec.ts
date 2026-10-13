/**
 * P-R — контракт `contracts/reddit-api.ts` ↔ контроллер (метод, путь,
 * действие матрицы), первый гвард — флаг раздела; действия P-R в матрице §5.
 */
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { REDDIT_ROUTES } from '../contracts/reddit-api';
import { enumerateControllers } from '../core/route-enumerator';
import { PUB_PERMISSIONS } from '../core/roles';
import { PublisherRedditController } from './reddit.controller';
import { RedditEnabledGuard } from './reddit-flag.guard';

describe('contracts/reddit-api ↔ контроллер P-R', () => {
  it('REDDIT_ROUTES = маршруты контроллера (метод, путь, действие); 25 маршрутов', () => {
    const fromController = enumerateControllers([
      PublisherRedditController as never,
    ])
      .map((r) => `${r.method} ${r.path} ${JSON.stringify(r.pubActions)}`)
      .sort();
    const fromContract = Object.values(REDDIT_ROUTES)
      .map(
        (r) =>
          `${r.method} ${r.path} ${JSON.stringify(Array.isArray(r.action) ? r.action : [r.action])}`,
      )
      .sort();
    expect(fromController).toEqual(fromContract);
    expect(fromContract).toHaveLength(25);
  });

  it('первый гвард контроллера — флаг PUBLISHER_REDDIT_ENABLED (до членства и ролей)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      PublisherRedditController,
    ) as unknown[];
    expect(guards[0]).toBe(RedditEnabledGuard);
    expect(guards.length).toBeGreaterThan(1);
  });

  it('мутации — reddit.manage / reddit.rules.review, чтения — reddit.read; reddit.handoff объявлен для M2', () => {
    const wrong = Object.entries(REDDIT_ROUTES).filter(([, r]) =>
      r.method === 'GET'
        ? r.action !== 'reddit.read' || r.mutation
        : !['reddit.manage', 'reddit.rules.review'].includes(
            r.action as string,
          ) || !r.mutation,
    );
    expect(wrong.map(([k]) => k)).toEqual([]);
    expect(PUB_PERMISSIONS['reddit.handoff'].roles).toEqual([
      'product_owner',
      'operator',
    ]);
  });
});
