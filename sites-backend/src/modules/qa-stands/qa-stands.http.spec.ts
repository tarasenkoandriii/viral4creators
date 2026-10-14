import { parseGenerated } from './generated-contract';
import { generatedFixture } from './generated-fixture.testing';
import type { StandContract } from './stand-contract';
import { QaStandsGenerator } from './qa-stands-generator.service';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { QaStandsController, QaStandsService } from './qa-stands.module';
import { SiteAccountGuard } from '../site-core/account/site-account.guard';
import { baseline, mockTransition, planStand } from './stand-contract';
describe('mock REST HTTP contract', () => {
  let app: INestApplication;
  let contract: StandContract = planStand({
    description: 'Кабинет заказов для проверки',
  });
  let records = baseline(contract);
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [QaStandsController],
      providers: [
        { provide: QaStandsGenerator, useValue: {} },
        {
          provide: QaStandsService,
          useValue: {
            command: async (
              _m: unknown,
              _site: string,
              _id: string,
              input: unknown,
            ) => {
              const r = mockTransition(contract, records, input);
              records = r.records;
              return r;
            },
          },
        },
      ],
    })
      .overrideGuard(SiteAccountGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp(): { getRequest(): { siteMember: unknown } };
        }) => {
          context.switchToHttp().getRequest().siteMember = {
            accountId: 'test',
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app?.close());
  const path = '/qa/sites/test/stands/test/mock/records';
  it('returns genuine HTTP errors and created records', async () => {
    await request(app.getHttpServer())
      .get(path + '?scenario=429')
      .expect(429);
    await request(app.getHttpServer())
      .get(path + '?scenario=500')
      .expect(500);
    await request(app.getHttpServer())
      .post(path)
      .send({ role: 'viewer', values: ['a', 'b'] })
      .expect(403);
    await request(app.getHttpServer())
      .post(path)
      .send({ role: 'editor', values: [] })
      .expect(422);
    const created = await request(app.getHttpServer())
      .post(path)
      .send({ role: 'editor', values: ['a', 'b'] })
      .expect(201);
    const list = await request(app.getHttpServer()).get(path).expect(200);
    expect(list.body.items).toHaveLength(2);
    await request(app.getHttpServer())
      .delete(path + '/' + created.body.id + '?role=editor')
      .expect(403);
    await request(app.getHttpServer())
      .delete(path + '/' + created.body.id + '?role=admin')
      .expect(200);
  });
  it('serves independently generated entity namespaces through REST', async () => {
    contract = parseGenerated(generatedFixture(), 'Кабинет заказов и клиентов');
    records = [];
    await request(app.getHttpServer())
      .post(path)
      .send({ entityId: 'orders', role: 'editor', values: ['Order', '42.5'] })
      .expect(201);
    const clients = await request(app.getHttpServer())
      .get(path + '?entity=clients')
      .expect(200);
    expect(clients.body.items).toEqual([]);
    const orders = await request(app.getHttpServer())
      .get(path + '?entity=orders')
      .expect(200);
    expect(orders.body.items).toHaveLength(1);
    await request(app.getHttpServer())
      .get(path + '?entity=missing')
      .expect(400);
  });
});
