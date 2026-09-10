/**
 * Boots a real Nest app with ONLY ReferenceModule (no Prisma → runs in
 * the sandbox) plus the same global prefix/interceptor as main.ts, and
 * hits the route over HTTP — verifies routing, the response envelope the
 * frontend expects, and the cache header.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { ReferenceModule } from './reference.module';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';

describe('GET /api/reference/countries (e2e, ReferenceModule only)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ReferenceModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });
  afterAll(() => app.close());

  it('serves the wrapped list with a long public cache header', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/reference/countries')
      .expect(200);
    expect(res.headers['cache-control']).toMatch(/public, max-age=86400/);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(240);
    expect(
      res.body.data.find((c: { code: string }) => c.code === 'PL'),
    ).toEqual({
      code: 'PL',
      currency: 'PLN',
      nameEn: 'Poland',
      nameRu: 'Польша',
    });
    expect(res.body.meta.timestamp).toBeDefined();
  });

  it('is public — no identity header needed (unlike /api/projects)', async () => {
    await request(app.getHttpServer())
      .get('/api/reference/countries')
      .expect(200);
  });
});
