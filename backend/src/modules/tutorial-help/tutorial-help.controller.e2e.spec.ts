/**
 * Контракт публичного `GET /api/tutorial-help/:subjectKey` по HTTP:
 * параметры доезжают до сервиса, ответ — ровно поля справки, кеш
 * публичный. Модульные тесты сервиса этого не видят: имя параметра
 * запроса живёт в декораторе контроллера.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { TutorialHelpController } from './tutorial-help.controller';
import { TutorialHelpService } from './tutorial-help.service';

const findFirst = jest.fn();
const prisma = { tutorialVideoAsset: { findFirst } };

const ROW = {
  blobUrl: 'https://blob/v.mp4',
  externalUrl: null,
  durationMs: 31000,
  width: 1080,
  height: 1080,
  posterUrl: 'https://blob/tutorial-video-posters/p.png',
  theme: 'light',
  capturedAt: new Date('2026-10-05T08:00:00.000Z'),
  captureBuild: '1a2b3c4',
};

describe('GET /api/tutorial-help/:subjectKey (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TutorialHelpController],
      providers: [
        TutorialHelpService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => findFirst.mockReset());

  it('метаданные ролика в ответе, публичный кеш на пять минут', async () => {
    findFirst.mockResolvedValue(ROW);
    const res = await request(app.getHttpServer())
      .get('/api/tutorial-help/greeting-brief?locale=ru')
      .expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body.data).toEqual({
      subjectKey: 'greeting-brief',
      locale: 'ru',
      title: expect.any(String),
      text: expect.any(String),
      videoUrl: ROW.blobUrl,
      durationMs: 31000,
      width: 1080,
      height: 1080,
      posterUrl: ROW.posterUrl,
      theme: 'light',
      capturedAt: '2026-10-05T08:00:00.000Z',
      captureBuild: '1a2b3c4',
      // Обе темы одним запросом (заход 3); тёмного ролика нет — и ключа нет.
      variants: {
        light: {
          videoUrl: ROW.blobUrl,
          posterUrl: ROW.posterUrl,
          width: 1080,
          height: 1080,
          durationMs: 31000,
          capturedAt: '2026-10-05T08:00:00.000Z',
          captureBuild: '1a2b3c4',
        },
      },
    });
  });

  it('?theme=dark доезжает до выборки; нет такого — запасной без темы', async () => {
    findFirst.mockImplementation(async (args: { where: { theme?: string } }) =>
      args.where.theme === 'dark' ? null : ROW,
    );
    const res = await request(app.getHttpServer())
      .get('/api/tutorial-help/2?locale=ru&theme=dark')
      .expect(200);
    const themes = findFirst.mock.calls.map(
      ([a]: [{ where: { theme?: string } }]) => a.where.theme,
    );
    expect(themes).toEqual(['light', 'dark', undefined]);
    expect(res.body.data.theme).toBe('light');
    expect(Object.keys(res.body.data.variants)).toEqual(['light']);
  });

  it('?theme=мусор — 200 и обычная выдача', async () => {
    findFirst.mockResolvedValue(null);
    const res = await request(app.getHttpServer())
      .get('/api/tutorial-help/2?locale=ru&theme=%3Cscript%3E')
      .expect(200);
    expect(
      findFirst.mock.calls.some(
        ([a]: [{ where: { theme?: string } }]) => a.where.theme === '<script>',
      ),
    ).toBe(false);
    expect(res.body.data.videoUrl).toBeNull();
    expect(res.body.data.width).toBeNull();
    expect(res.body.data.variants).toEqual({});
  });

  it('client-site — 404 и база не спрашивается (ролики сайтов заказчиков не публичны)', async () => {
    findFirst.mockResolvedValue({ ...ROW, clientSiteDraftId: 'draft_1' });
    await request(app.getHttpServer())
      .get('/api/tutorial-help/client-site?locale=ru')
      .expect(404);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('слот демо обучающего лендинга: текст есть, без отметки оператора — роликов нет', async () => {
    // Сервиса настроек в модуле теста нет — семейство закрыто, и даже
    // «одобренная» строка из базы не выдаётся.
    findFirst.mockResolvedValue({
      ...ROW,
      id: 'a1',
      subjectKey: 'site-tutorial-demo-1',
      clientSiteDraftId: null,
    });
    const res = await request(app.getHttpServer())
      .get('/api/tutorial-help/site-tutorial-demo-1?locale=en')
      .expect(200);
    expect(res.body.data.subjectKey).toBe('site-tutorial-demo-1');
    expect(res.body.data.title).toEqual(expect.any(String));
    expect(res.body.data.videoUrl).toBeNull();
    expect(res.body.data.variants).toEqual({});
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('несуществующая тема — 404', async () => {
    await request(app.getHttpServer())
      .get('/api/tutorial-help/nonsense-topic?locale=ru')
      .expect(404);
  });
});
