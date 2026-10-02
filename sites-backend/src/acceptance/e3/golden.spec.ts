/**
 * Приёмка Э3 (L): проверенные ответы — ТЗ §4-тер.4, §4-тер.10, §4-тер.13,
 * §4-тер.15 п.11 и п.14. Реальный Postgres + pgvector; знания — настоящий
 * индексатор Э1, ответ посетителю — настоящий конвейер виджета (ChatStack)
 * под ролью assist_public; маршруты — по HTTP с настоящими гвардами.
 *
 *  1. п.11: источник проверенного ответа изменился в новой версии →
 *     needs_review, прямой путь выключен (ответ уже не из FAQ), документ
 *     остаётся в поиске (путь (3)), «На сайте теперь: …»; «Проверено,
 *     верно» снимает пересмотр и закрепляет новый источник.
 *  2. Источник без хеша (мастер Э2) — сверка чисел; срок пересмотра истёк →
 *     needs_review.
 *  3. п.14 по HTTP: оператор — 403 на публикацию/правку/архив/решение;
 *     читает список; менеджер — публикует; чужой кабинет — 404.
 *  4. Копирование между сайтами одного кабинета и endClient; другой
 *     endClient и чужой кабинет — COPY_TARGET_FORBIDDEN; цитаты посетителей
 *     и источники не копируются; дубль пропускается.
 *  5. Архив: документ уходит из индекса, кейс eval — archived; восстановление.
 */
import {
  Global,
  INestApplication,
  Logger,
  Module,
  type DynamicModule,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { GoldenAnswersService } from '../../modules/assist-site-learning/golden.service';
import { SiteLearningQueueController } from '../../modules/assist-site-learning/learning.controller';
import { LearningQueueService } from '../../modules/assist-site-learning/learning-queue.service';
import { LearningQualityService } from '../../modules/assist-site-learning/quality.service';
import {
  DAY,
  LearnStack,
  RAW_URL,
  describeWithoutDb,
  type LSite,
} from '../../modules/assist-site-learning/testing/learning-stack.testing';
import { SiteCoreModule } from '../../modules/site-core/site-core.module';
import { TelegramAuthModule } from '../../modules/telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../../modules/telegram-auth/test-init-data';

@Global()
@Module({})
class LInfra {
  static with(prisma: PrismaService): DynamicModule {
    return {
      module: LInfra,
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: SitesDb, useValue: new SitesDb(prisma) },
      ],
      exports: [PrismaService, SitesDb],
    };
  }
}

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'ALLOW_DEV_AUTH',
] as const;

const DELIVERY_70 =
  'Доставка Новою Поштою по Україні, вартість доставки 70 грн, термін 1–3 дні.';
const DELIVERY_90 =
  'Доставка Новою Поштою по Україні, вартість доставки 90 грн, термін 1–3 дні.';
const QD = 'Скільки коштує доставка?';

// Реальная база, индексация и конвейер: при параллельных наборах дольше 5 с.
jest.setTimeout(60_000);

if (!RAW_URL) {
  describeWithoutDb('проверенные ответы (Э3, L)');
} else {
  describe('проверенные ответы «Сайта» (Э3, L), реальный Postgres', () => {
    let st: LearnStack;
    let chat: ChatStack;
    let app: INestApplication;
    const saved: Record<string, string | undefined> = {};

    beforeAll(async () => {
      Logger.overrideLogger(false);
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
      process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
      delete process.env.ALLOW_DEV_AUTH;
      st = await new LearnStack().init();
      chat = await new ChatStack().init();
      const mod = await Test.createTestingModule({
        imports: [LInfra.with(st.prisma), TelegramAuthModule, SiteCoreModule],
        controllers: [SiteLearningQueueController],
        providers: [
          { provide: LearningQueueService, useValue: st.queue },
          { provide: GoldenAnswersService, useValue: st.golden },
          { provide: LearningQualityService, useValue: st.quality },
        ],
      }).compile();
      app = mod.createNestApplication();
      configureApp(app, loadConfiguration({}));
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
      await chat.close();
      await st.close();
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    const srv = () => app.getHttpServer();
    const as = (tg: bigint) => ({
      'X-Telegram-App': 'assist',
      'X-Telegram-Init-Data': signInitData({
        botToken: TEST_ASSIST_TOKEN,
        userId: Number(tg),
      }),
    });

    async function asChatSite(s: LSite): Promise<ChatSite> {
      const v = await st.version(s);
      return {
        accountId: s.accountId,
        siteId: s.siteId,
        host: new URL(s.origin).host,
        origin: s.origin,
        ownerTelegramId: s.owner.telegramId,
        url: (path) => `${s.origin}${path}`,
        ctx: (over = {}) => ({
          accountId: s.accountId,
          siteId: s.siteId,
          knowledgeVersion: v,
          configVersion: 0,
          widgetVersion: 1,
          parentOrigin: s.origin,
          keyKind: 'live',
          preview: false,
          ...over,
        }),
      };
    }

    async function widgetPath(s: LSite, q: string): Promise<string | null> {
      const c = await chat.ask(await asChatSite(s), q, {
        clientRequestId: randomUUID(),
      });
      const m = await st.prisma.assistSiteMessage.findFirst({
        where: { id: c.meta!.messageId, siteId: s.siteId },
        select: { answerPath: true },
      });
      return m?.answerPath ?? null;
    }

    async function pageChunkHash(s: LSite, path: string): Promise<string> {
      const v = await st.version(s);
      const c = await st.prisma.assistSiteChunk.findFirst({
        where: {
          siteId: s.siteId,
          url: `${s.origin}${path}`,
          versions: { has: v },
        },
        select: { contentHash: true },
      });
      return c!.contentHash;
    }

    it('п.11: источник изменился → needs_review, прямой путь выключен, «На сайте теперь: …»; «проверено» — снова active', async () => {
      const s = await st.site();
      await st.pages(s, [
        { path: '/dostavka', title: 'Доставка', paragraphs: [DELIVERY_70] },
      ]);
      const hash70 = await pageChunkHash(s, '/dostavka');
      const g = await st.golden.create(s.manager, s.siteId, {
        question: QD,
        answer: 'Доставка коштує 70 грн, від 1500 грн — безкоштовно.',
        lang: 'uk',
        sourceRefs: [
          { documentId: null, url: `${s.origin}/dostavka`, chunkHash: hash70 },
        ],
      });
      expect(g).toMatchObject({ status: 'active', origin: 'owner' });
      expect(g.sourceRefs[0]).toMatchObject({ chunkHash: hash70 });
      expect(await widgetPath(s, QD)).toBe('faq');

      // Ночью без изменений сайта — конфликта нет.
      let r = await st.rollupRun([s]);
      expect(r.conflicts).toBe(0);

      // Переобход: на сайте теперь 90 грн → новая версия.
      await st.pages(s, [
        { path: '/dostavka', title: 'Доставка', paragraphs: [DELIVERY_90] },
      ]);
      r = await st.rollupRun([s]);
      expect(r.conflicts).toBe(1);
      const [view] = await st.golden.list(s.manager, s.siteId, {
        status: 'needs_review',
      });
      expect(view.id).toBe(g.id);
      expect(view.conflictNote).toMatch(/^На сайте теперь: «/);
      expect(view.conflictNote).toContain('90 грн');
      // Прямой путь выключен — но ответ остаётся в поиске (путь (3)).
      expect(await widgetPath(s, QD)).not.toBe('faq');
      expect((await st.faqChunkTexts(s)).some((t) => t.startsWith(QD))).toBe(
        true,
      );
      // Повторная ночь — тот же пересмотр, без новых «конфликтов».
      r = await st.rollupRun([s]);
      expect(r.conflicts).toBe(0);

      // «Проверено, верно» (владелец знает, что 70 — правда).
      const ok = await st.golden.patch(s.manager, s.siteId, g.id, {
        reviewed: true,
      });
      expect(ok).toMatchObject({ status: 'active', conflictNote: null });
      expect(ok.sourceRefs[0].chunkHash).toBe(
        await pageChunkHash(s, '/dostavka'),
      );
      r = await st.rollupRun([s]);
      expect(r.conflicts).toBe(0);
      expect(await widgetPath(s, QD)).toBe('faq');
    });

    it('источник без хеша (мастер Э2): сверка чисел и закрепление; срок пересмотра истёк → needs_review', async () => {
      const s = await st.site();
      await st.pages(s, [
        { path: '/dostavka', title: 'Доставка', paragraphs: [DELIVERY_90] },
      ]);
      const stale = await st.golden.create(s.manager, s.siteId, {
        question: QD,
        answer: 'Доставка коштує 70 грн.',
      });
      const fine = await st.golden.create(s.manager, s.siteId, {
        question: 'Скільки триває доставка?',
        answer: 'Термін доставки 1–3 дні.',
      });
      const old = await st.golden.create(s.manager, s.siteId, {
        question: 'Чи є гарантія?',
        answer: 'Так, гарантія діє.',
      });
      for (const id of [stale.id, fine.id]) {
        await st.prisma.assistSiteFaq.updateMany({
          where: { id, siteId: s.siteId },
          data: {
            sourceRefs: [{ url: `${s.origin}/dostavka`, title: 'Доставка' }],
          },
        });
      }
      await st.prisma.assistSiteFaq.updateMany({
        where: { id: old.id, siteId: s.siteId },
        data: { reviewAt: new Date(Date.now() - DAY) },
      });
      const r = await st.rollupRun([s]);
      expect(r).toMatchObject({ conflicts: 1, needsReview: 2 });
      const rows = await st.golden.list(s.manager, s.siteId, { status: 'all' });
      const byId = new Map(rows.map((x) => [x.id, x]));
      expect(byId.get(stale.id)).toMatchObject({ status: 'needs_review' });
      expect(byId.get(stale.id)!.conflictNote).toContain('90 грн');
      expect(byId.get(fine.id)).toMatchObject({
        status: 'active',
        conflictNote: null,
      });
      // Источник закреплён хешем — следующая ночь сверяет по хешу.
      expect(byId.get(fine.id)!.sourceRefs[0].chunkHash).toBe(
        await pageChunkHash(s, '/dostavka'),
      );
      expect(byId.get(old.id)).toMatchObject({
        status: 'needs_review',
        conflictNote: null,
      });
      // reviewAt: 180 дней без чисел.
      const days =
        (new Date(byId.get(fine.id)!.reviewAt!).getTime() - Date.now()) / DAY;
      expect(days).toBeLessThan(31);
      const noNumbers = await st.golden.create(s.manager, s.siteId, {
        question: 'Чи є подарункова упаковка?',
        answer: 'Так, упакуємо безкоштовно.',
      });
      const d2 = (new Date(noNumbers.reviewAt!).getTime() - Date.now()) / DAY;
      expect(d2).toBeGreaterThan(179);
    });

    it('источник — только документ этого сайта и не UGC; контакт в варианте — отказ', async () => {
      const s = await st.site();
      await st.pages(s, [
        {
          path: '/vidguky',
          title: 'Відгуки',
          blocks: [
            { t: 'h', level: 1, text: 'Відгуки', path: [] },
            {
              t: 'p',
              text: 'Доставили за 1 день безкоштовно!',
              path: ['Відгуки'],
              ugc: true,
            },
          ],
        },
      ]);
      const ugc = await pageChunkHash(s, '/vidguky');
      await expect(
        st.golden.create(s.manager, s.siteId, {
          question: QD,
          answer: 'Безкоштовно',
          sourceRefs: [{ documentId: null, url: null, chunkHash: ugc }],
        }),
      ).rejects.toMatchObject({ response: { code: 'GOLDEN_INVALID' } });
      await expect(
        st.golden.create(s.manager, s.siteId, {
          question: QD,
          answer: 'x',
          sourceRefs: [
            {
              documentId: null,
              url: 'https://evil.example/x',
              chunkHash: null,
            },
          ],
        }),
      ).rejects.toMatchObject({ response: { code: 'GOLDEN_INVALID' } });
      await expect(
        st.golden.create(s.manager, s.siteId, {
          question: QD,
          answer: 'x',
          variants: ['подзвоніть +380671234567'],
        }),
      ).rejects.toMatchObject({ response: { code: 'GOLDEN_INVALID' } });
      expect(
        await st.prisma.assistSiteFaq.count({ where: { siteId: s.siteId } }),
      ).toBe(0);
    });

    it('п.14 по HTTP: оператор — 403 на публикацию и решения, читает; менеджер — публикует; чужой кабинет — 404', async () => {
      const s = await st.site();
      const base = `/assist/sites/${s.siteId}/learning/site`;
      const body = { question: 'Чи є самовивіз?', answer: 'Так, з 10 до 18.' };

      const denied = await request(srv())
        .post(`${base}/golden`)
        .set(as(s.operator.telegramId))
        .send(body);
      expect(denied.status).toBe(403);
      expect(denied.body.success).toBe(false);

      const created = await request(srv())
        .post(`${base}/golden`)
        .set(as(s.manager.telegramId))
        .send(body);
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        question: 'Чи є самовивіз?',
        status: 'active',
        approvedByMe: true,
      });
      const gid = created.body.data.id as string;

      const list = await request(srv())
        .get(`${base}/golden?status=active`)
        .set(as(s.operator.telegramId));
      expect(list.status).toBe(200);
      expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([gid]);
      expect(list.body.data[0].approvedByMe).toBe(false);

      for (const [method, path, payload] of [
        ['patch', `${base}/golden/${gid}`, { answer: 'Ні' }],
        ['delete', `${base}/golden/${gid}`, undefined],
        ['post', `${base}/golden/copy-to/${s.siteId}`, { ids: [gid] }],
        ['post', `${base}/queue/x/resolve`, { action: 'ignore' }],
        ['post', `${base}/queue/x/draft`, undefined],
        ['get', `${base}/quality`, undefined],
        ['post', `${base}/eval-run`, undefined],
        ['post', `${base}/simulate`, undefined],
      ] as const) {
        const req = request(srv())[method](path).set(as(s.operator.telegramId));
        const res = payload ? await req.send(payload) : await req;
        expect([method, path, res.status]).toEqual([method, path, 403]);
      }
      // Очередь оператор читает (свои кандидаты).
      const q = await request(srv())
        .get(`${base}/queue`)
        .set(as(s.operator.telegramId));
      expect(q.status).toBe(200);
      expect(q.body.data.entries).toEqual([]);

      const patched = await request(srv())
        .patch(`${base}/golden/${gid}`)
        .set(as(s.manager.telegramId))
        .send({
          answer: 'Так, з 9 до 18.',
          variants: ['Можна забрати самому?'],
        });
      expect(patched.status).toBe(200);
      expect(patched.body.data).toMatchObject({
        answer: 'Так, з 9 до 18.',
        variants: ['Можна забрати самому?'],
      });
      const bad = await request(srv())
        .post(`${base}/golden`)
        .set(as(s.manager.telegramId))
        .send({ question: '', answer: 'x' });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('GOLDEN_INVALID');

      // Чужой кабинет: сайт «не найден».
      const other = await st.site();
      const foreign = await request(srv())
        .get(`${base}/golden`)
        .set(as(other.manager.telegramId));
      expect(foreign.status).toBe(404);

      const del = await request(srv())
        .delete(`${base}/golden/${gid}`)
        .set(as(s.manager.telegramId));
      expect(del.status).toBe(200);
      expect(del.body.data).toEqual({ ok: true });
    });

    it('копирование: один кабинет и endClient; цитаты и источники не копируются; дубль — пропуск; чужое — 403', async () => {
      const client = `ec-${randomUUID()}`;
      const a = await st.site({ endClientId: client });
      const b = await st.site({ accountId: a.accountId, endClientId: client });
      const c = await st.site({ accountId: a.accountId, endClientId: null });
      const foreign = await st.site({ endClientId: client });
      await st.pages(a, [
        { path: '/dostavka', title: 'Доставка', paragraphs: [DELIVERY_70] },
      ]);
      const g1 = await st.golden.create(a.manager, a.siteId, {
        question: QD,
        answer: 'Доставка коштує 70 грн.',
        variants: ['Ціна доставки'],
        sourceRefs: [
          {
            documentId: null,
            url: `${a.origin}/dostavka`,
            chunkHash: await pageChunkHash(a, '/dostavka'),
          },
        ],
      });
      // Цитата посетителя (как из очереди): в копию не идёт.
      await st.prisma.assistSiteFaq.updateMany({
        where: { id: g1.id, siteId: a.siteId },
        data: {
          variants: ['Ціна доставки', 'скільки за доставку?'],
          variantRefs: [
            { variant: 'скільки за доставку?', conversationId: 'conv-x' },
          ],
        },
      });
      const g2 = await st.golden.create(a.manager, a.siteId, {
        question: 'Чи є гарантія?',
        answer: 'Так, 12 місяців.',
      });
      await st.golden.create(b.manager, b.siteId, {
        question: 'чи є гарантія?',
        answer: 'Своя відповідь сайту B.',
      });

      const res = await st.golden.copyTo(a.manager, a.siteId, b.siteId, {
        ids: [g1.id, g2.id, 'нет-такого'],
      });
      expect(res.copied).toBe(1);
      expect(res.skipped).toEqual(
        expect.arrayContaining([
          { id: g2.id, reason: 'duplicate' },
          { id: 'нет-такого', reason: 'not_found' },
        ]),
      );
      const copies = await st.golden.list(b.manager, b.siteId, {
        status: 'all',
      });
      const copy = copies.find((x) => x.question === QD)!;
      expect(copy).toMatchObject({
        origin: 'copied',
        answer: 'Доставка коштує 70 грн.',
        variants: ['Ціна доставки'],
        sourceRefs: [],
      });
      // Копия независима: правка оригинала её не меняет.
      await st.golden.patch(a.manager, a.siteId, g1.id, {
        answer: 'Тепер 80 грн.',
      });
      expect(
        (await st.golden.list(b.manager, b.siteId, { status: 'all' })).find(
          (x) => x.id === copy.id,
        )!.answer,
      ).toBe('Доставка коштує 70 грн.');

      for (const target of [c.siteId, foreign.siteId, a.siteId]) {
        await expect(
          st.golden.copyTo(a.manager, a.siteId, target, { ids: [g1.id] }),
        ).rejects.toMatchObject({
          status: 403,
          response: { code: 'COPY_TARGET_FORBIDDEN' },
        });
      }
      await expect(
        st.golden.copyTo(a.operator, a.siteId, b.siteId, { ids: [g1.id] }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('архив: документ уходит из индекса, кейс eval — archived; восстановление возвращает', async () => {
      const s = await st.site();
      const g = await st.golden.create(s.manager, s.siteId, {
        question: 'Чи працюєте у свята?',
        answer: 'Ні, у свята вихідний.',
      });
      expect(
        (await st.faqChunkTexts(s)).some((t) => t.startsWith('Чи працюєте')),
      ).toBe(true);
      await st.golden.archive(s.manager, s.siteId, g.id);
      expect(
        (await st.faqChunkTexts(s)).some((t) => t.startsWith('Чи працюєте')),
      ).toBe(false);
      const cases = await st.prisma.assistSiteEvalCase.findMany({
        where: { siteId: s.siteId, faqId: g.id },
      });
      expect(cases.map((x) => [x.kind, x.status])).toEqual([
        ['golden', 'archived'],
      ]);
      await expect(
        st.golden.patch(s.manager, s.siteId, g.id, { answer: 'Так' }),
      ).rejects.toMatchObject({ response: { code: 'GOLDEN_INVALID' } });
      const back = await st.golden.patch(s.manager, s.siteId, g.id, {
        status: 'active',
      });
      expect(back.status).toBe('active');
      expect(
        (await st.faqChunkTexts(s)).some((t) => t.startsWith('Чи працюєте')),
      ).toBe(true);
      expect(
        (
          await st.prisma.assistSiteEvalCase.findFirst({
            where: { siteId: s.siteId, faqId: g.id },
          })
        )?.status,
      ).toBe('active');
      await expect(
        st.golden.patch(s.manager, s.siteId, 'нет-такого', { answer: 'x' }),
      ).rejects.toMatchObject({ response: { code: 'GOLDEN_NOT_FOUND' } });
    });
  });
}
