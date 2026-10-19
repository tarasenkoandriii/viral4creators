import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request = require('supertest');
import { AccountService } from '../site-core/account/account.service';
import { NO_PRODUCT_ROLES } from '../site-core/account/roles';
import { SiteAccountGuard } from '../site-core/account/site-account.guard';
import { QaArtifactController } from './qa-artifact.controller';
import { QaArtifactService } from './qa-artifact.service';
import { QaCatalogController, QaFindingsController } from './qa-catalog.module';
import { QaCatalogService } from './qa-catalog.service';
import { QaFindingService } from './qa-finding.service';
import { QaInventoryController } from './qa-inventory.controller';
import { QaInventoryService } from './qa-inventory.service';
import { QaPlanController } from './qa-plan.controller';
import { QaPlanService } from './qa-plan.service';
import { QaRunService } from './qa-run.service';
import type { IdentifiedRequest } from '../telegram-auth/identity';

// Only identity resolution/storage are fixtures. The real account guard and
// actual route decorators run, so a missing QA_WRITE decorator is observable.
// This is not a production Telegram login or proof of browser viewer access.
describe('QA viewer HTTP boundaries', () => {
  let app: INestApplication;
  const hit = jest.fn(() => ({ ok: true }));
  const service = Object.fromEntries(
    [
      'list',
      'get',
      'history',
      'create',
      'replace',
      'start',
      'upload',
      'download',
      'remove',
      'import',
      'importReport',
      'attempts',
      'record',
    ].map((name) => [name, hit]),
  );
  const root = '/qa/sites/test';
  const reads = [
    '/cases',
    '/cases/case',
    '/cases/case/history',
    '/runs',
    '/runs/run',
    '/runs/run/attempts',
    '/findings',
    '/findings/finding',
    '/findings/finding/history',
    '/findings/finding/artifacts',
    '/findings/finding/artifacts/file/download',
    '/plans',
    '/plans/plan',
    '/plans/plan/history',
    '/inventory?search=QA',
  ];
  const writes: Array<['post' | 'put' | 'delete', string]> = [
    ['post', '/cases'],
    ['put', '/cases/case'],
    ['post', '/runs'],
    ['post', '/runs/run/reports'],
    ['post', '/runs/run/attempts'],
    ['post', '/findings'],
    ['put', '/findings/finding'],
    ['post', '/findings/finding/artifacts'],
    ['delete', '/findings/finding/artifacts/file'],
    ['post', '/plans'],
    ['put', '/plans/plan'],
    ['post', '/plans/plan/runs'],
    ['post', '/inventory/import'],
  ];
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        QaCatalogController,
        QaFindingsController,
        QaArtifactController,
        QaPlanController,
        QaInventoryController,
      ],
      providers: [
        SiteAccountGuard,
        {
          provide: AccountService,
          useValue: {
            resolveMembership: async (id: bigint) => ({
              accountId: 'test',
              memberId: 'member',
              telegramId: id,
              role: 'operator',
              productRoles: {
                ...NO_PRODUCT_ROLES,
                qa: id === 1n ? 'viewer' : id === 2n ? 'admin' : 'none',
              },
            }),
          },
        },
        ...[
          QaCatalogService,
          QaFindingService,
          QaRunService,
          QaArtifactService,
          QaPlanService,
          QaInventoryService,
        ].map((provide) => ({ provide, useValue: service })),
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      // Test-only middleware: never included in the application module.
      const id = req.headers['x-test-identity'];
      if (id === '1' || id === '2' || id === '3') {
        (req as IdentifiedRequest).identity = {
          app: 'qa',
          telegramId: BigInt(id),
          username: null,
          firstName: null,
          languageCode: null,
        };
      }
      next();
    });
    await app.init();
  });
  afterAll(async () => app?.close());
  beforeEach(() => hit.mockClear());
  it.each(reads)('viewer may read %s through the real guard', async (path) => {
    await request(app.getHttpServer())
      .get(root + path)
      .set('x-test-identity', '1')
      .expect(200);
    expect(hit).toHaveBeenCalledTimes(1);
  });
  it.each(writes)(
    'viewer cannot %s %s even with forged write fields',
    async (method, path) => {
      await request(app.getHttpServer())
        [method](root + path)
        .set('x-test-identity', '1')
        .send({
          role: 'owner',
          productRoles: { qa: 'admin' },
          source: { runId: 'run', caseKey: 'QA', attemptId: 'attempt' },
        })
        .expect(403);
      expect(hit).not.toHaveBeenCalled();
    },
  );
  it.each(reads)('no QA role cannot read %s', async (path) => {
    await request(app.getHttpServer())
      .get(root + path)
      .set('x-test-identity', '3')
      .expect(403);
    expect(hit).not.toHaveBeenCalled();
  });
  it('anonymous requests cannot read private evidence', async () => {
    await request(app.getHttpServer())
      .get(root + '/findings/finding/artifacts/file/download')
      .expect(401);
    expect(hit).not.toHaveBeenCalled();
  });
  it.each(writes)('QA admin reaches %s %s', async (method, path) => {
    await request(app.getHttpServer())
      [method](root + path)
      .set('x-test-identity', '2')
      .send({})
      .expect(method === 'post' ? 201 : 200);
    expect(hit).toHaveBeenCalledTimes(1);
  });
});
