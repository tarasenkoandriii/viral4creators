/**
 * P-R — контракт `contracts/reddit-api.ts` ↔ контроллер (метод, путь,
 * действие матрицы), первый гвард — флаг раздела; действия P-R в матрице §5.
 */
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  REDDIT_M1_ROUTE_NAMES,
  REDDIT_M2_ROUTE_NAMES,
  REDDIT_ROUTES,
} from '../contracts/reddit-api';
import { enumerateControllers } from '../core/route-enumerator';
import { PUB_PERMISSIONS } from '../core/roles';
import { PublisherRedditController } from './reddit.controller';
import { RedditEnabledGuard } from './reddit-flag.guard';

describe('contracts/reddit-api ↔ контроллер P-R', () => {
  it('REDDIT_ROUTES = маршруты контроллера (метод, путь, действие); 40 маршрутов (M1 26 + M2 14; +restoreProject, Р-RD-AUD-1)', () => {
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
    expect(fromContract).toHaveLength(40);
    expect([
      REDDIT_M1_ROUTE_NAMES.length,
      REDDIT_M2_ROUTE_NAMES.length,
    ]).toEqual([26, 14]);
  });

  it('первый гвард контроллера — флаг PUBLISHER_REDDIT_ENABLED (до членства и ролей)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      PublisherRedditController,
    ) as unknown[];
    expect(guards[0]).toBe(RedditEnabledGuard);
    expect(guards.length).toBeGreaterThan(1);
  });

  it('мутации — reddit.manage / reddit.rules.review, чтения — reddit.read; M2: генерация ai.generate, проверка qa.technical, копирование и отчёт reddit.handoff', () => {
    const M2_ACTIONS: Record<string, string> = {
      generateDraft: 'ai.generate',
      checkContent: 'qa.technical',
      copyContent: 'reddit.handoff',
      reportPublication: 'reddit.handoff',
    };
    const wrong = Object.entries(REDDIT_ROUTES).filter(([k, r]) =>
      r.method === 'GET'
        ? r.action !== 'reddit.read' || r.mutation
        : (M2_ACTIONS[k]
            ? r.action !== M2_ACTIONS[k]
            : !['reddit.manage', 'reddit.rules.review'].includes(
                r.action as string,
              )) || !r.mutation,
    );
    expect(wrong.map(([k]) => k)).toEqual([]);
    expect(PUB_PERMISSIONS['reddit.handoff'].roles).toEqual([
      'product_owner',
      'operator',
    ]);
  });
});
