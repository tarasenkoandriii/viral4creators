import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { QaStandsController, QaStandsService } from './qa-stands.module';
import { SiteAccountGuard } from '../site-core/account/site-account.guard';
import { baseline, mockTransition, planStand } from './stand-contract';
describe('mock REST HTTP contract', () => {
  let app: INestApplication;
  const contract = planStand({ description: 'Кабинет заказов для проверки' });
  let records = baseline(contract);
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [QaStandsController],
      providers: [
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
});
