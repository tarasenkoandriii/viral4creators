/**
 * Тест-инвариант «Админка → Сайт» Э7 на РЕАЛЬНЫХ знаниях «Админки»
 * пилотного сайта (план, приёмка Э7; ТЗ §4.3-бис п.1–4, §4-тер.15 п.15):
 *  - знания «Админки»: регламенты с канарейками и «секретами» (индексатор
 *    настоящий), проверенный ответ «Админки» (golden) с канарейкой —
 *    опубликован через очередь обучения, кластер очереди «Админки» с
 *    канарейкой, диалоги сотрудников (ответы с канарейкой);
 *  - 256 вопросов посетителя (прямые, косвенные, инъекции) через НАСТОЯЩИЙ
 *    конвейер виджета «Сайта» под ролью assist_public, честная и «злая»
 *    модель → 0 маркеров в ответах, источниках, кнопках, промптах модели
 *    «Сайта», семантическом кэше, очереди/кластерах и сообщениях «Сайта»;
 *  - контроль: та же канарейка находится чатом сотрудника (иначе «0 утечек»
 *    значило бы «канареек нет»);
 *  - обратное направление (Р-34): проверенный ответ «Сайта» не действует в
 *    «Админке».
 */
import * as request from 'supertest';
import { ADMIN_SESSION_HEADER } from '../../brand';
import { signEmployeeJwt } from '../../modules/assist-admin-mode/identity-jwt';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { describeE7, E7Stack, type E7Site } from './e7-stack';
import {
  PILOT_PUBLIC_PAGES,
  pilotCanaries,
  pilotQuestions,
  pilotRegulations,
} from './pilot-admin-knowledge';

jest.setTimeout(300_000);

describeE7(
  'Э7: тест-инвариант «Админка → Сайт» на знаниях пилотного сайта',
  () => {
    const admin = new E7Stack();
    const site = new ChatStack();
    let S: E7Site;
    let W: ChatSite;
    const { canary, markers } = pilotCanaries();
    let session = '';
    const body = (r: request.Response) => r.body.data ?? r.body;

    const leaks = (text: string): string[] =>
      markers.filter((m) => text.toLowerCase().includes(m.toLowerCase()));

    beforeAll(async () => {
      await admin.init();
      await site.init();
      S = await admin.site();
      // Публичная часть пилота — версия 1 «Сайта» (как после индексации K2).
      await admin.prisma.assistSite.update({
        where: { siteId: S.siteId },
        data: { knowledgeVersion: 1, widgetVersion: 1 },
      });
      W = {
        accountId: S.accountId,
        siteId: S.siteId,
        host: S.host,
        origin: `https://${S.host}`,
        ownerTelegramId: S.ownerTg,
        url: (p) => `https://${S.host}${p}`,
        ctx: (over = {}) => ({
          accountId: S.accountId,
          siteId: S.siteId,
          knowledgeVersion: 1,
          configVersion: 0,
          widgetVersion: 1,
          parentOrigin: `https://${S.host}`,
          keyKind: 'live',
          preview: false,
          ...over,
        }),
      };
      await site.pages(W, PILOT_PUBLIC_PAGES);
      // Проверенный ответ «Сайта» с маркером — для обратного направления.
      await site.faq(W, {
        question: 'Чи є самовивіз?',
        answer: 'Так, самовивіз з магазину SITEGOLDEN на Хрещатику.',
        lang: 'uk',
      });

      // «Админка»: регламенты пилота — настоящим индексатором.
      for (const doc of pilotRegulations(canary))
        await admin.adminDocument(S, doc);
      await request(admin.srv())
        .patch(`/assist/sites/${S.siteId}/admin-mode`)
        .set(admin.as(S.ownerTg))
        .send({ enabled: true, access: 'both', adminHostIds: [S.adminHostId] })
        .expect(200);
      const sec = body(
        await request(admin.srv())
          .post(`/assist/sites/${S.siteId}/admin-mode/identity-secret`)
          .set(admin.as(S.ownerTg))
          .expect(200),
      ).secret;
      const t = Math.floor(Date.now() / 1000);
      session = body(
        await request(admin.srv())
          .post('/assist-admin/v1/session')
          .send({
            pk: S.pk,
            jwt: signEmployeeJwt(
              {
                sub: 'emp-1',
                role: 'manager',
                aud: S.siteId,
                iat: t,
                exp: t + 600,
              },
              sec,
            ),
          })
          .expect(200),
      ).session;

      // Диалоги сотрудников с канарейкой + 👎 с «правильно так» (кластер очереди).
      for (const q of [
        'Як менеджер створює повернення в CRM?',
        'Яка внутрішня знижка для оптових клієнтів?',
      ]) {
        const r = await request(admin.srv())
          .post('/assist-admin/v1/chat')
          .set(ADMIN_SESSION_HEADER, session)
          .send({ text: q })
          .expect(200);
        await request(admin.srv())
          .post(`/assist-admin/v1/messages/${body(r).answer.id}/feedback`)
          .set(ADMIN_SESSION_HEADER, session)
          .send({
            rating: -1,
            correction: `ADMCLUSTER ${canary}: уточнення від співробітника`,
          })
          .expect(200);
      }
      // Проверенный ответ «Админки» с канарейкой — через очередь (owner).
      const q = body(
        await request(admin.srv())
          .get(`/assist/sites/${S.siteId}/learning/admin/queue`)
          .set(admin.as(S.ownerTg))
          .expect(200),
      );
      const fix = q.find((x: { kind: string }) => x.kind === 'employee_fix');
      await request(admin.srv())
        .post(`/assist/sites/${S.siteId}/learning/admin/queue/${fix.id}/accept`)
        .set(admin.as(S.ownerTg))
        .send({
          question: 'Хто погоджує знижку?',
          answer: `ADMGOLDEN ${canary}: знижку погоджує комерційний директор.`,
        })
        .expect(200);
    });

    afterAll(async () => {
      await site.close();
      await admin.close();
    });

    it('контроль: канарейки есть в «Админке» и находятся чатом сотрудника', async () => {
      const r = await request(admin.srv())
        .post('/assist-admin/v1/chat')
        .set(ADMIN_SESSION_HEADER, session)
        .send({ text: 'Як менеджер створює повернення в CRM? Код процедури?' })
        .expect(200);
      // Канарейка дошла до модели «Админки» как знание (S#) и ответ на неё сослался.
      expect(admin.text.calls[admin.text.calls.length - 1].user).toContain(
        canary,
      );
      expect(body(r).answer.answerPath).toBe('knowledge');
      expect(body(r).answer.sources.length).toBeGreaterThan(0);
      const golden = await admin.prisma.assistAdminFaq.count({
        where: {
          siteId: S.siteId,
          origin: 'golden',
          answer: { contains: canary },
        },
      });
      expect(golden).toBe(1);
      const cluster = await admin.prisma.assistAdminLearningItem.count({
        where: { siteId: S.siteId, proposedAnswer: { contains: 'ADMCLUSTER' } },
      });
      expect(cluster).toBeGreaterThanOrEqual(2);
    });

    it('256 вопросов посетителя (честная и «злая» модель) — 0 утечек в ответах, источниках, кнопках, промптах', async () => {
      const qs = pilotQuestions();
      expect(qs.length).toBeGreaterThanOrEqual(200);
      const found: string[] = [];
      let i = 0;
      for (const q of qs) {
        site.model.mode = i++ % 2 === 0 ? 'honest' : 'evil';
        const r = await site.ask(W, q);
        const blob = [
          r.text,
          JSON.stringify(r.sources),
          JSON.stringify(r.actions),
          r.error?.message ?? '',
        ].join('\n');
        for (const l of leaks(blob)) found.push(`${q} → ${l}`);
      }
      site.model.mode = 'honest';
      expect(found).toEqual([]);
      // Знания «Админки» не дошли даже до модели «Сайта».
      const prompts = site.model.calls
        .map(
          (c) => `${c.system}\n${c.contents.map((x) => x.content).join('\n')}`,
        )
        .join('\n');
      expect(leaks(prompts)).toEqual([]);
      // Публичное при этом отвечается (иначе «0 утечек» — от пустого конвейера).
      const ok = await site.ask(W, 'Скільки коштує доставка?');
      expect(ok.text).toContain('70 грн');
    });

    it('производные «Сайта»: семантический кэш, очередь и кластеры, сообщения — без маркеров', async () => {
      const tables = [
        'assist_site_semantic_cache',
        'assist_site_learning_items',
        'assist_site_learning_clusters',
        'assist_site_messages',
        'assist_site_conversations',
        'assist_site_faq',
      ];
      for (const t of tables) {
        const rows = await admin.prisma.$queryRawUnsafe<unknown[]>(
          `SELECT * FROM "sites"."${t}" WHERE "siteId" = $1`,
          S.siteId,
        );
        const blob = JSON.stringify(rows, (_k, v) =>
          typeof v === 'bigint' ? String(v) : v,
        );
        expect({ table: t, leaks: leaks(blob) }).toEqual({
          table: t,
          leaks: [],
        });
      }
    });

    it('Р-34 обратно: проверенный ответ «Сайта» не действует в «Админке»', async () => {
      const r = await request(admin.srv())
        .post('/assist-admin/v1/chat')
        .set(ADMIN_SESSION_HEADER, session)
        .send({ text: 'Чи є самовивіз?' })
        .expect(200);
      expect(body(r).answer.text).not.toContain('SITEGOLDEN');
      const prompts = admin.text.calls.map((c) => c.user).join('\n');
      expect(prompts).not.toContain('SITEGOLDEN');
    });
  },
);
