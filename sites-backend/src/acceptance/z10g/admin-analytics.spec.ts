/**
 * Заход 10, пакет Г — приёмка на НАСТОЯЩЕМ Postgres (стенд Э7):
 *  - №57 (ТЗ §5-тер.13 «Кто что видит», У-23/У-25): аналитика «Админки» —
 *    только `assistAdmin: owner`; менеджер «Сайта» и сотрудник «Админки» — 403;
 *  - разметка диалогов: резерв бюджета ДО модели (нет денег — модель не
 *    зовётся), вход замаскирован, факт — `assist-admin-label`, резерв снят;
 *  - экспорт CSV: ≤ 50 000 строк (больше — `too_many_rows`), без столбца
 *    сотрудника при выключенном разрезе, защита от CSV-инъекции;
 *  - отчёт недели и Р-З10-13 push тревоги компенсаций: только владельцам
 *    «Админки», каждому на его языке, дедуп (неделя / сутки);
 *  - Р-З10-15 / Р-З10-16: подпись кнопки в сниппете, флаг «админка — TMA».
 */
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AdminCompensationAlerts } from '../../modules/assist-admin-analytics/admin-alerts.service';
import { AdminExports } from '../../modules/assist-admin-analytics/admin-exports.service';
import { AdminLabeler } from '../../modules/assist-admin-analytics/admin-labeler.service';
import { AdminRollup } from '../../modules/assist-admin-analytics/admin-rollup.service';
import * as labelSchema from '../../modules/assist-admin-analytics/admin-label-schema';
import { AdminUnmaskedInputError } from '../../modules/assist-admin-analytics/admin-label-schema';
import { AdminWeekly } from '../../modules/assist-admin-analytics/admin-weekly.service';
import { AdminFrameController } from '../../modules/assist-admin-chat/admin-frame.controller';
import type {
  GenerateRequest,
  GenerateResult,
} from '../../modules/site-ai/text-model';
import { E7Stack, describeE7, type E7Site } from '../e7/e7-stack';

jest.setTimeout(60_000);

const LITE = 'gemini-2.5-flash-lite';
// Ответ API — в конверте `{ data }` (ResponseInterceptor).
const body = (r: request.Response) => r.body.data ?? r.body;

describeE7(
  'заход 10, пакет Г: аналитика «Админки» (№57, Р-З10-13/15/16)',
  () => {
    const st = new E7Stack();
    let s: E7Site;
    const calls: GenerateRequest[] = [];
    let labelReply = JSON.stringify({
      taskType: 'order_status',
      answerFound: 'yes',
      quality: 4,
    });
    const sent: Array<{ chat_id: string; text: string; url: string }> = [];
    const fetchImpl = async (
      _url: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ) => {
      const b = JSON.parse(init.body) as {
        chat_id: string;
        text: string;
        reply_markup: {
          inline_keyboard: Array<Array<{ web_app: { url: string } }>>;
        };
      };
      sent.push({
        chat_id: b.chat_id,
        text: b.text,
        url: b.reply_markup.inline_keyboard[0][0].web_app.url,
      });
      return { ok: true, status: 200 };
    };
    const botEnv = {
      ASSIST_BOT_TOKEN: 'tok',
      ASSIST_TMA_URL: 'https://tma.example.com/assist',
      ASSIST_LITE_MODEL: LITE,
    };
    let ownerRu: bigint;
    let adminOwnerEn: bigint;
    let siteManager: bigint;
    let employee: bigint;

    beforeAll(async () => {
      await st.init();
      // Фейк модели: разметка и выводы — по системному промпту.
      st.text.generate = async (
        req: GenerateRequest,
      ): Promise<GenerateResult> => {
        calls.push(req);
        const usage = {
          model: req.model ?? LITE,
          inputTokens: 1_000,
          cachedInputTokens: 0,
          outputTokens: 50,
        };
        if (/company EMPLOYEE/.test(req.system)) {
          return { ...usage, text: labelReply };
        }
        if (/weekly insights/.test(req.system)) {
          return {
            ...usage,
            text: JSON.stringify({
              items: [
                {
                  findingIds: ['refusals'],
                  uk: {
                    title: 'Багато «не знаю»',
                    action: 'Додайте регламент.',
                  },
                  ru: {
                    title: 'Много «не знаю»',
                    action: 'Добавьте регламент.',
                  },
                  en: { title: 'Many unknowns', action: 'Add the policy.' },
                },
              ],
            }),
          };
        }
        return { ...usage, text: '{}' };
      };
      s = await st.site({ plan: 'business' });
      await st.prisma.assistAdminSettings.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          adminModeEnabled: true,
          adminAccess: 'both',
          adminHostIds: [s.adminHostId],
        },
      });
      ownerRu = s.ownerTg;
      adminOwnerEn = await st.member(s, 'operator', { assistAdmin: 'owner' });
      siteManager = await st.member(s, 'manager', { assist: 'manager' });
      employee = await st.member(s, 'operator', { assistAdmin: 'employee' });
      for (const [tg, lang] of [
        [ownerRu, 'ru-RU'],
        [adminOwnerEn, 'en'],
        [siteManager, 'uk'],
        [employee, 'uk'],
      ] as const) {
        await st.prisma.assistBotUser.upsert({
          where: { telegramId: tg },
          create: { telegramId: tg, languageCode: lang },
          update: { languageCode: lang },
        });
      }
      for (const svc of [
        st.app.get(AdminLabeler),
        st.app.get(AdminWeekly),
        st.app.get(AdminCompensationAlerts),
      ]) {
        svc.env = { ...process.env, ...botEnv };
      }
      st.app.get(AdminWeekly).fetchImpl = fetchImpl;
      st.app.get(AdminCompensationAlerts).fetchImpl = fetchImpl;
    });

    afterAll(async () => {
      await st.close();
    });

    beforeEach(() => {
      calls.length = 0;
      sent.length = 0;
    });

    async function conversation(p: {
      role: string | null;
      hoursAgo: number;
      questions: string[];
      refused?: boolean;
      employeeRef?: string;
    }): Promise<string> {
      const at = new Date(Date.now() - p.hoursAgo * 3_600_000);
      const c = await st.prisma.assistAdminConversation.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          employeeRef: p.employeeRef ?? `jwt:${randomUUID()}`,
          channel: 'embed',
          employeeRole: p.role,
          lastActivityAt: at,
          createdAt: at,
        },
      });
      for (const q of p.questions) {
        await st.prisma.assistAdminMessage.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            conversationId: c.id,
            role: 'employee',
            text: q,
            createdAt: at,
          },
        });
        await st.prisma.assistAdminMessage.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            conversationId: c.id,
            role: 'assistant',
            text: p.refused ? 'Не знаю' : 'Замовлення відправлено.',
            answerPath: p.refused ? 'refused' : 'knowledge',
            costMicroUsd: 10,
            createdAt: at,
          },
        });
      }
      return c.id;
    }

    async function budgetRow(): Promise<{
      spent: number;
      reserved: number;
    } | null> {
      const rows = await st.prisma.$queryRawUnsafe<
        Array<{ spent: bigint; reserved: bigint }>
      >(
        `SELECT "spentMicroUsd" AS spent, "reservedMicroUsd" AS reserved
         FROM "sites"."assist_budget_days"
        WHERE "scope" = 'admin' AND "key" = $1 AND "day" = $2`,
        s.siteId,
        new Date().toISOString().slice(0, 10),
      );
      return rows[0]
        ? { spent: Number(rows[0].spent), reserved: Number(rows[0].reserved) }
        : null;
    }

    // ── Права (§5-тер.13 «Кто что видит») ────────────────────────────────

    it('аналитика «Админки» — только assistAdmin: owner; «Сайт» и сотрудник — 403', async () => {
      const paths: Array<['get' | 'post', string, object?]> = [
        ['get', `/assist/sites/${s.siteId}/admin-mode/stats/labels?days=7`],
        ['get', `/assist/sites/${s.siteId}/admin-mode/stats/insights`],
        ['get', `/assist/sites/${s.siteId}/admin-mode/exports`],
        [
          'post',
          `/assist/sites/${s.siteId}/admin-mode/exports`,
          { kind: 'daily', from: '2026-10-01', to: '2026-10-07' },
        ],
      ];
      for (const who of [siteManager, employee]) {
        for (const [m, path, body] of paths) {
          const r = request(st.srv())[m](path).set(st.as(who));
          await (body ? r.send(body) : r).expect(403);
        }
      }
      for (const who of [s.ownerTg, adminOwnerEn]) {
        await request(st.srv())
          .get(`/assist/sites/${s.siteId}/admin-mode/stats/labels?days=7`)
          .set(st.as(who))
          .expect(200);
      }
    });

    // ── Разметка: резерв до модели ───────────────────────────────────────

    it('нет денег в суточном потолке «Админки» — модель не зовётся, диалог ждёт', async () => {
      const id = await conversation({
        role: 'manager',
        hoursAgo: 9,
        questions: ['Статус замовлення 77?'],
      });
      const day = new Date().toISOString().slice(0, 10);
      await st.prisma.$executeRawUnsafe(
        `INSERT INTO "sites"."assist_budget_days" ("scope", "key", "day", "spentMicroUsd", "updatedAt")
       VALUES ('admin', $1, $2, 999999999999, now())
       ON CONFLICT ("scope", "key", "day") DO UPDATE SET "spentMicroUsd" = 999999999999`,
        s.siteId,
        day,
      );
      const r = await st.app.get(AdminLabeler).tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        max: 10,
        siteIds: [s.siteId],
      });
      expect(r.budgetDenied).toBe(1);
      expect(calls).toHaveLength(0);
      expect(
        await st.prisma.assistAdminConversationLabel.count({
          where: { conversationId: id },
        }),
      ).toBe(0);
      await st.prisma.$executeRawUnsafe(
        `UPDATE "sites"."assist_budget_days" SET "spentMicroUsd" = 0, "reservedMicroUsd" = 0
        WHERE "scope" = 'admin' AND "key" = $1`,
        s.siteId,
      );
    });

    it('разметка: закрытый диалог (8 ч), вход замаскирован, факт `assist-admin-label`, резерв снят', async () => {
      const open = await conversation({
        role: 'manager',
        hoursAgo: 1,
        questions: ['Ще відкритий діалог'],
      });
      const id = await conversation({
        role: 'support',
        hoursAgo: 10,
        questions: ['Клієнт boss@client.ua питає про замовлення 55'],
      });
      const r = await st.app.get(AdminLabeler).tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        max: 10,
        siteIds: [s.siteId],
      });
      expect(r.labeled).toBeGreaterThanOrEqual(1);
      const prompts = calls.map((c) => c.user).join('\n');
      expect(prompts).not.toContain('boss@client.ua');
      expect(calls.every((c) => c.model === LITE)).toBe(true);
      const label = await st.prisma.assistAdminConversationLabel.findUnique({
        where: { conversationId: id },
      });
      expect(label).toMatchObject({
        taskType: 'order_status',
        answerFound: 'yes',
        status: 'ok',
        employeeRole: 'support',
      });
      expect(
        await st.prisma.assistAdminConversationLabel.count({
          where: { conversationId: open },
        }),
      ).toBe(0);
      const usage = await st.prisma.siteAiUsage.findMany({
        where: { siteId: s.siteId, operation: 'assist-admin-label' },
      });
      expect(usage.length).toBeGreaterThanOrEqual(1);
      expect(usage[0].costMicroUsd).toBeGreaterThan(0);
      expect((await budgetRow())?.reserved).toBe(0);
    });

    it('невалидный ответ модели — одна повторная попытка, затем `failed` (больше не берётся)', async () => {
      labelReply = '{"taskType":"sales"}';
      const id = await conversation({
        role: null,
        hoursAgo: 12,
        questions: ['?'],
        refused: true,
      });
      await st.app.get(AdminLabeler).tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        max: 10,
        siteIds: [s.siteId],
      });
      expect(
        calls.filter((c) => /company EMPLOYEE/.test(c.system)),
      ).toHaveLength(2);
      expect(
        await st.prisma.assistAdminConversationLabel.findUnique({
          where: { conversationId: id },
        }),
      ).toMatchObject({ status: 'failed', answerFound: 'no' });
      labelReply = JSON.stringify({ taskType: 'lookup', answerFound: 'yes' });
      calls.length = 0;
      await st.app.get(AdminLabeler).tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        max: 10,
        siteIds: [s.siteId],
      });
      expect(calls).toHaveLength(0);
    });

    // ── Экспорт ──────────────────────────────────────────────────────────

    it('экспорт CSV: очередь → файл; > лимита строк — `too_many_rows`; лимит 50 000', async () => {
      const files = new Map<string, string>();
      const exportsSvc = st.app.get(AdminExports);
      (exportsSvc as unknown as { storage: object }).storage = {
        put: async (k: string, body: string) => void files.set(k, body),
        signedUrl: async (k: string) => `https://blob.example/${k}?sig=1`,
        remove: async (k: string) => void files.delete(k),
      };
      expect(exportsSvc.maxRows).toBe(50_000);
      // Роль из JWT заказчика — чужие данные: «=cmd» экранируется.
      await conversation({ role: '=cmd', hoursAgo: 11, questions: ['x'] });
      await st.app.get(AdminLabeler).tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        max: 10,
        siteIds: [s.siteId],
      });
      const today = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 3 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const req = await request(st.srv())
        .post(`/assist/sites/${s.siteId}/admin-mode/exports`)
        .set(st.as(s.ownerTg))
        .send({ kind: 'labels', from, to: today })
        .expect(202);
      expect(body(req).status).toBe('queued');
      await exportsSvc.process(5, new Date(), [s.siteId]);
      const done = await request(st.srv())
        .get(`/assist/sites/${s.siteId}/admin-mode/exports/${body(req).id}`)
        .set(st.as(s.ownerTg))
        .expect(200);
      expect(body(done).status).toBe('done');
      expect(body(done).url).toContain('admin-exports');
      const csv = [...files.values()][0];
      expect(csv.startsWith('﻿')).toBe(true);
      expect(csv).toContain("'=cmd");
      // Аудит P3 (7): без разреза «по сотруднику» — дата и без id диалога.
      const head = csv.split('\r\n')[0];
      expect(head).not.toContain('employee');
      expect(head).not.toContain('conversation_id');
      expect(head.replace('\uFEFF', '').startsWith('date,')).toBe(true);
      expect(csv.split('\r\n')[1]).toMatch(/^\d{4}-\d{2}-\d{2},/);
      // Больше лимита — failed, а не обрезанный файл.
      exportsSvc.maxRows = 1;
      const big = await request(st.srv())
        .post(`/assist/sites/${s.siteId}/admin-mode/exports`)
        .set(st.as(s.ownerTg))
        .send({ kind: 'labels', from, to: today })
        .expect(202);
      await exportsSvc.process(5, new Date(), [s.siteId]);
      const failed = await request(st.srv())
        .get(`/assist/sites/${s.siteId}/admin-mode/exports/${body(big).id}`)
        .set(st.as(s.ownerTg))
        .expect(200);
      expect(body(failed)).toMatchObject({
        status: 'failed',
        error: 'too_many_rows',
      });
      exportsSvc.maxRows = 50_000;
      // Период: не больше 400 дней, from ≤ to.
      await request(st.srv())
        .post(`/assist/sites/${s.siteId}/admin-mode/exports`)
        .set(st.as(s.ownerTg))
        .send({ kind: 'labels', from: today, to: from })
        .expect(400);
    });

    // ── Отчёт недели ─────────────────────────────────────────────────────

    it('отчёт недели: только владельцам «Админки», каждому на его языке; повтор не шлёт', async () => {
      const week = '2026-09-28';
      for (let i = 0; i < 7; i++) {
        const d = new Date(`${week}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        await st.prisma.assistAdminDailyStat.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            day: d.toISOString().slice(0, 10),
            role: '*',
            conversations: 2,
            questions: 6,
            refused: 2,
          },
        });
      }
      const weekly = st.app.get(AdminWeekly);
      const now = new Date('2026-10-05T07:00:00Z');
      const r = await weekly.tick({
        now,
        deadline: Date.now() + 20_000,
        maxSites: 5,
        siteIds: [s.siteId],
      });
      expect(r).toMatchObject({ week, sites: 1, reports: 1 });
      const to = new Map(sent.map((m) => [m.chat_id, m]));
      expect([...to.keys()].sort()).toEqual(
        [ownerRu.toString(), adminOwnerEn.toString()].sort(),
      );
      expect(to.get(ownerRu.toString())!.text).toContain('Неделя «Админки»');
      expect(to.get(ownerRu.toString())!.text).toContain('Много «не знаю»');
      expect(to.get(adminOwnerEn.toString())!.text).toContain(
        'Back-office assistant week',
      );
      expect(to.get(adminOwnerEn.toString())!.url).toContain(
        `#/sites/${s.siteId}/admin-mode/stats`,
      );
      const insight = await st.prisma.assistAdminInsight.findUnique({
        where: { siteId_weekStart: { siteId: s.siteId, weekStart: week } },
      });
      expect(insight?.model).toBe(LITE);
      expect(
        await st.prisma.siteAiUsage.count({
          where: { siteId: s.siteId, operation: 'assist-admin-insight' },
        }),
      ).toBe(1);
      sent.length = 0;
      const again = await weekly.tick({
        now: new Date('2026-10-05T09:00:00Z'),
        deadline: Date.now() + 20_000,
        maxSites: 5,
        siteIds: [s.siteId],
      });
      expect(again.sites).toBe(0);
      expect(sent).toHaveLength(0);
    });

    // ── Р-З10-13: push тревоги компенсаций ───────────────────────────────

    async function compensations(done: number, failed: number) {
      const now = Date.now();
      for (let i = 0; i < done + failed; i++) {
        await st.prisma.assistAdminActionProposal.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            channel: 'embed',
            actor: 'jwt:a',
            actorExternal: 'a',
            assistRole: '*',
            connectorId: 'cn',
            operationRowId: 'op',
            operation: 'shop.cancelOrder',
            kind: 'write',
            paramsHash: randomUUID(),
            compensationOf: 'p0',
            status: i < done ? 'done' : 'failed',
            attempts: 1,
            expiresAt: new Date(now + 3_600_000),
            executedAt: new Date(now - 3_600_000),
          },
        });
      }
    }

    it('Р-З10-13: тревога компенсаций — push владельцам на их языке, раз в сутки', async () => {
      const alerts = st.app.get(AdminCompensationAlerts);
      await compensations(8, 1); // 9 попыток — ниже минимума выборки
      let r = await alerts.tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        siteIds: [s.siteId],
      });
      expect(r.alerts).toBe(0);
      expect(sent).toHaveLength(0);
      await compensations(0, 2); // 8 из 11 < 80%
      r = await alerts.tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        siteIds: [s.siteId],
      });
      expect(r).toMatchObject({ alerts: 1, sent: 2 });
      const byChat = new Map(sent.map((m) => [m.chat_id, m.text]));
      expect(byChat.get(ownerRu.toString())).toContain('успешно 8 из 11');
      expect(byChat.get(adminOwnerEn.toString())).toContain('8 of 11');
      expect(byChat.has(siteManager.toString())).toBe(false);
      expect(byChat.has(employee.toString())).toBe(false);
      sent.length = 0;
      r = await alerts.tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        siteIds: [s.siteId],
      });
      expect(sent).toHaveLength(0);
      // Дедуп — по UTC-суткам последнего push: другие сутки — снова можно.
      await st.prisma.assistAdminSettings.updateMany({
        where: { siteId: s.siteId },
        data: { compensationAlertDay: '2000-01-01' },
      });
      r = await alerts.tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        siteIds: [s.siteId],
      });
      expect(r.sent).toBe(2);
    });

    // ── Р-З10-15 / Р-З10-16 ──────────────────────────────────────────────

    it('Р-З10-15/16: подпись кнопки — в сниппете `data-label`; флаг «админка — TMA» включает Telegram Web', async () => {
      const r = await request(st.srv())
        .patch(`/assist/sites/${s.siteId}/admin-mode`)
        .set(st.as(s.ownerTg))
        .send({ widgetLabel: 'Помічник "V4C"', adminTmaFrame: true })
        .expect(200);
      expect(body(r).widgetLabel).toBe('Помічник "V4C"');
      expect(body(r).snippet.tag).toContain(
        'data-label="Помічник &#34;V4C&#34;"',
      );
      await request(st.srv())
        .patch(`/assist/sites/${s.siteId}/admin-mode`)
        .set(st.as(s.ownerTg))
        .send({ widgetLabel: '<img src=x>' })
        .expect(400);
      await request(st.srv())
        .patch(`/assist/sites/${s.siteId}/admin-mode`)
        .set(st.as(s.ownerTg))
        .send({ analyticsTaskMinutes: { sales: 3 } })
        .expect(400);
      const frame = st.app.get(AdminFrameController);
      const anc = await frame.ancestorsFor(s.pk);
      expect(anc).toContain(`https://${s.adminHost}`);
      expect(anc).toContain('https://web.telegram.org');
      await request(st.srv())
        .patch(`/assist/sites/${s.siteId}/admin-mode`)
        .set(st.as(s.ownerTg))
        .send({ adminTmaFrame: false })
        .expect(200);
      expect(await frame.ancestorsFor(s.pk)).not.toContain(
        'https://web.telegram.org',
      );
      // Менеджер «Сайта» флаг не меняет.
      await request(st.srv())
        .patch(`/assist/sites/${s.siteId}/admin-mode`)
        .set(st.as(siteManager))
        .send({ adminTmaFrame: true })
        .expect(403);
    });

    it('свёртка дня по ролям из сырых строк (идемпотентна)', async () => {
      const rollup = st.app.get(AdminRollup);
      const day = new Date().toISOString().slice(0, 10);
      await rollup.day(s.accountId, s.siteId, day);
      await rollup.day(s.accountId, s.siteId, day);
      const rows = await st.prisma.assistAdminDailyStat.findMany({
        where: { siteId: s.siteId, day },
      });
      const total = rows.find((r) => r.role === '*');
      expect(total?.conversations).toBeGreaterThanOrEqual(1);
      expect(rows.filter((r) => r.role === '*')).toHaveLength(1);
    });

    // ── Аудит захода 10 ──────────────────────────────────────────────────

    async function convWith(hoursAgo: number, q: string, a: string) {
      const at = new Date(Date.now() - hoursAgo * 3_600_000);
      const c = await st.prisma.assistAdminConversation.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          employeeRef: `jwt:${randomUUID()}`,
          channel: 'embed',
          employeeRole: 'm',
          lastActivityAt: at,
          createdAt: at,
        },
      });
      for (const [role, text] of [
        ['employee', q],
        ['assistant', a],
      ] as const) {
        await st.prisma.assistAdminMessage.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            conversationId: c.id,
            role,
            text,
            answerPath: role === 'assistant' ? 'knowledge' : null,
            createdAt: at,
          },
        });
      }
      return c.id;
    }

    it('P1-1: числа на разных строках не ломают разметку — оба диалога размечены, тик не падает', async () => {
      labelReply = JSON.stringify({ taskType: 'lookup', answerFound: 'yes' });
      const poison = await convWith(
        13,
        'Скільки коштує?',
        'Сума: 1250\n\n3400 грн',
      );
      const normal = await convWith(12.5, 'Статус замовлення?', 'Відправлено.');
      const r = await st.app.get(AdminLabeler).tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        max: 30,
        siteIds: [s.siteId],
      });
      expect(r.errors).toBe(0);
      const labels = await st.prisma.assistAdminConversationLabel.findMany({
        where: { conversationId: { in: [poison, normal] } },
      });
      expect(labels.map((l) => l.status).sort()).toEqual(['ok', 'ok']);
    });

    it('P1-1: сбой подготовки одного диалога — `failed` по коду без модели и денег, очередь идёт дальше', async () => {
      const bad = await convWith(14, 'Перший', 'Відповідь один.');
      const good = await convWith(13.5, 'Другий', 'Відповідь два.');
      const usageBefore = await st.prisma.siteAiUsage.count({
        where: { siteId: s.siteId, operation: 'assist-admin-label' },
      });
      const spy = jest
        .spyOn(labelSchema, 'buildAdminLabelPrompt')
        .mockImplementationOnce(() => {
          throw new AdminUnmaskedInputError();
        });
      try {
        const r = await st.app.get(AdminLabeler).tick({
          now: new Date(),
          deadline: Date.now() + 20_000,
          max: 30,
          siteIds: [s.siteId],
        });
        expect(r).toMatchObject({ failed: 1, labeled: 1, errors: 0 });
      } finally {
        spy.mockRestore();
      }
      const byId = new Map(
        (
          await st.prisma.assistAdminConversationLabel.findMany({
            where: { conversationId: { in: [bad, good] } },
          })
        ).map((l) => [l.conversationId, l]),
      );
      expect(byId.get(bad)).toMatchObject({
        status: 'failed',
        costMicroUsd: 0,
      });
      expect(byId.get(good)).toMatchObject({ status: 'ok' });
      // Ровно один вызов модели — у нормального диалога.
      expect(
        calls.filter((c) => /company EMPLOYEE/.test(c.system)),
      ).toHaveLength(1);
      expect(
        await st.prisma.siteAiUsage.count({
          where: { siteId: s.siteId, operation: 'assist-admin-label' },
        }),
      ).toBe(usageBefore + 1);
    });

    it('P2-1/P3 (1): очередь выгрузок — 409 после трёх в работе; захват — одна на сайт за тик; попытки исчерпаны — failed', async () => {
      const exportsSvc = st.app.get(AdminExports);
      (exportsSvc as unknown as { storage: object }).storage = {
        put: async () => undefined,
        signedUrl: async (k: string) => `https://blob.example/${k}`,
        remove: async () => undefined,
      };
      await st.prisma.assistAdminExport.deleteMany({
        where: { siteId: s.siteId },
      });
      const today = new Date().toISOString().slice(0, 10);
      const post = () =>
        request(st.srv())
          .post(`/assist/sites/${s.siteId}/admin-mode/exports`)
          .set(st.as(s.ownerTg))
          .send({ kind: 'daily', from: today, to: today });
      for (let i = 0; i < 3; i++) await post().expect(202);
      const busy = await post().expect(409);
      expect(JSON.stringify(busy.body)).toContain('ADMIN_EXPORT_BUSY');
      const r = await exportsSvc.process(5, new Date(), [s.siteId]);
      expect(r.done).toBe(1);
      expect(
        await st.prisma.assistAdminExport.count({
          where: { siteId: s.siteId, status: 'queued' },
        }),
      ).toBe(2);
      // Зависшая после трёх попыток — failed, а не вечная очередь.
      const stuck = await st.prisma.assistAdminExport.findFirstOrThrow({
        where: { siteId: s.siteId, status: 'queued' },
      });
      await st.prisma.assistAdminExport.update({
        where: { id: stuck.id },
        data: {
          status: 'running',
          attempts: 3,
          lockedUntil: new Date(Date.now() - 1_000),
        },
      });
      await exportsSvc.process(5, new Date(), [s.siteId]);
      expect(
        await st.prisma.assistAdminExport.findUniqueOrThrow({
          where: { id: stuck.id },
        }),
      ).toMatchObject({ status: 'failed', error: 'attempts_exhausted' });
    });

    it('P3 (3): свёртка пересчитывает и день диалога, размеченного только что (старше трёх дней)', async () => {
      const at = new Date(Date.now() - 6 * 86_400_000);
      const day = at.toISOString().slice(0, 10);
      const c = await st.prisma.assistAdminConversation.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          employeeRef: `jwt:${randomUUID()}`,
          channel: 'embed',
          employeeRole: 'late',
          lastActivityAt: at,
          createdAt: at,
        },
      });
      await st.prisma.assistAdminConversationLabel.create({
        data: {
          conversationId: c.id,
          accountId: s.accountId,
          siteId: s.siteId,
          model: LITE,
          promptVersion: 'x',
          taskType: 'report',
          answerFound: 'yes',
          status: 'ok',
          employeeRole: 'late',
          conversationAt: at,
        },
      });
      const r = await st.app.get(AdminRollup).tick({
        now: new Date(),
        deadline: Date.now() + 20_000,
        siteIds: [s.siteId],
      });
      expect(r?.extraDays).toBeGreaterThanOrEqual(1);
      const row = await st.prisma.assistAdminDailyStat.findUnique({
        where: { siteId_day_role: { siteId: s.siteId, day, role: 'late' } },
      });
      expect(row).toMatchObject({ labeled: 1, answerYes: 1 });
    });
  },
);
