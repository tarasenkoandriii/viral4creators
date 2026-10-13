/**
 * [AT-CORE-09] Интеграция Z-2b: сквозной поиск ПД по ВСЕМ пакетам Publisher
 * (проектный документ §17.1, §18.1 AT-CORE-09; аудит P2-23). Полный стенд
 * (все модули этапа 1 на настоящих портах). Сценарий:
 *  - посетитель по метке с email/телефоном в UTM и пути → события и сессия;
 *  - заявка с контактом (имя, телефон, email в задаче, самоотчёт) → приём,
 *    обогащение, уведомления, переходы с заметками, заметка проспекта,
 *    оплата, ретенция, CSV заявок;
 *  - AI: источник с ДРУГИМ контактом (материал владельца) → вопрос помощнику
 *    с контактом заявителя; модель «возвращает» оба контакта → журнал вызова;
 *  - отказы с контактом в полях (форма, тест-флаг, материал) — тела ошибок;
 *  - отчёт `ad_hoc` за период заявки;
 *  - раскрытие контакта и заметок — первым шагом проверки (§17.1).
 * Затем сырой поиск синтетических значений во ВСЕХ колонках ВСЕХ таблиц
 * `pub_*` (включая `pub_idempotency_keys`, `pub_audit_events`, журнал AI),
 * кроме явного списка разрешённых колонок `PII_ALLOWED_COLUMNS` (шифротексты
 * `ENCRYPTED_COLUMNS` реестра таблиц + материал источника
 * `pub_sources.fragment` — только для контакта ИЗ источника), в журналах
 * процесса (перехват stdout/stderr/console/Logger), в ответах всех запросов
 * (кроме двух маршрутов раскрытия) и в текстах уведомлений — 0 совпадений.
 */
import { ConsoleLogger, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { AiGatewayService } from '../../modules/publisher/ai/ai-gateway.service';
import { PublisherAiModule } from '../../modules/publisher/ai/ai.module';
import {
  AI_PARAMS,
  ScriptedModel,
  approveParams,
  helperJson,
  openAiMonth,
} from '../../modules/publisher/ai/testing/ai-kit.testing';
import { PublisherContentModule } from '../../modules/publisher/content/content.module';
import { ENCRYPTED_COLUMNS } from '../../modules/publisher/core/table-registry';
import {
  asMember,
  coreStack,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import { PublisherDistributionModule } from '../../modules/publisher/distribution/distribution.module';
import { LeadEnrichJob } from '../../modules/publisher/leads/lead-enrich.job';
import { PublisherLeadsModule } from '../../modules/publisher/leads/leads.module';
import {
  BotNotifyTransport,
  NotificationsDeliverJob,
  type NotifyMessage,
} from '../../modules/publisher/leads/notifications.service';
import {
  intakeProduct,
  leadBody,
  postEvent,
  postLead,
  randomIp,
  syntheticPerson,
  testSessionRef,
  trustLocalProxy,
  useTestSecrets,
  type IntakeWorld,
} from '../../modules/publisher/leads/testing/leads-fixtures.testing';
import { PublisherContentPublicModule } from '../../modules/publisher/public/content-public.module';
import { PublisherIntakePublicModule } from '../../modules/publisher/public/intake-public.module';
import { PublisherReportsModule } from '../../modules/publisher/reports/reports.module';
import {
  seedMembers,
  type SeededMembers,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(300_000);

const MODULES = [
  PublisherContentModule,
  PublisherAiModule,
  PublisherDistributionModule,
  PublisherLeadsModule,
  PublisherReportsModule,
  PublisherContentPublicModule,
  PublisherIntakePublicModule,
];

/**
 * Явный список колонок, где синтетическое значение МОЖЕТ лежать (§6.1:
 * контакты и заметки — только шифротекстом; материал источника — данные
 * владельца, в AI уходит под маской, §12.3). Всё остальное — 0 совпадений.
 */
const PII_ALLOWED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ...ENCRYPTED_COLUMNS,
};
/** Только для контакта из источника — его собственная колонка. */
const SOURCE_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  ...ENCRYPTED_COLUMNS,
  pub_sources: ['fragment'],
};

const FLAG = 'PUBLISHER_AI_ALLOW_UNEVALUATED';

ciDescribe(
  '[AT-CORE-09] z-pii-scan: синтетические контакты во всех пакетах — только в шифре и разрешённых колонках; журналы, ответы, ключи, аудит, ошибки чистые',
  () => {
    let s: CoreStack;
    let w: IntakeWorld;
    let team: SeededMembers;
    let model: ScriptedModel;
    let restore: Array<() => void>;
    const saved = process.env[FLAG];
    const logs: string[] = [];
    const responses: Array<{ route: string; text: string }> = [];
    const srv = () => s.app!.getHttpServer();

    beforeAll(async () => {
      restore = [useTestSecrets(), trustLocalProxy()];
      process.env[FLAG] = 'true';
      s = await coreStack({ http: true, imports: MODULES });
      w = await intakeProduct(s, { kind: 'working', analytics: 'session' });
      team = await seedMembers(s.prisma, w.product, w.account.owner);
      await approveParams(
        s.prisma,
        {
          accountId: w.account.accountId,
          ownerMemberId: w.account.owner.memberId,
        },
        w.product.id,
        AI_PARAMS,
      );
      await openAiMonth(s.prisma, w.product, 20_000_000n);
      model = new ScriptedModel();
      s.mod.get(AiGatewayService).useModel(model);
      await s.prisma.$executeRaw`
        UPDATE "sites"."pub_products"
           SET "mode" = 'live', "liveSince" = now(),
               "paramsPublicPublishOk" = true, "paramsRealLeadsOk" = true
         WHERE "id" = ${w.product.id}`;
    });
    afterAll(async () => {
      if (saved === undefined) delete process.env[FLAG];
      else process.env[FLAG] = saved;
      await s.close();
      restore.forEach((r) => r());
    });

    /** Поиск значений в строках таблиц `pub_*` вне разрешённых колонок. */
    async function scan(
      needles: string[],
      allowed: Readonly<Record<string, readonly string[]>>,
    ): Promise<string[]> {
      const tables = await s.prisma.$queryRaw<Array<{ t: string }>>`
        SELECT tablename AS "t" FROM pg_tables
         WHERE schemaname = 'sites' AND tablename LIKE 'pub\\_%' ORDER BY 1`;
      expect(tables.length).toBeGreaterThanOrEqual(60);
      const hits: string[] = [];
      for (const { t } of tables) {
        const minus = (allowed[t] ?? [])
          .map((c) => ` - '${c.replace(/'/g, "''")}'`)
          .join('');
        const where = needles
          .map((_v, i) => `j LIKE '%' || $${i + 1} || '%'`)
          .join(' OR ');
        const rows = await s.prisma.$queryRawUnsafe<Array<{ j: string }>>(
          `SELECT j FROM (SELECT (to_jsonb(x)${minus})::text AS j FROM "sites"."${t}" x) y WHERE ${where}`,
          ...needles.map((v) => JSON.stringify(v).slice(1, -1)),
        );
        for (const r of rows) hits.push(`${t}: ${r.j.slice(0, 240)}`);
      }
      return hits;
    }

    it('полный путь по пакетам, затем сырой поиск: таблицы pub_*, ключи, аудит, журнал AI, ответы, ошибки, логи', async () => {
      const p = syntheticPerson();
      const srcPerson = syntheticPerson();
      const phoneDigits = p.phone.replace(/\D/g, '');
      const leadNeedles = [
        p.name,
        p.email,
        p.phone,
        phoneDigits,
        phoneDigits.slice(-9),
        p.task,
        p.business,
        p.note,
      ];
      const srcDigits = srcPerson.phone.replace(/\D/g, '');
      const sourceNeedles = [srcPerson.email, srcPerson.phone, srcDigits];
      const capture = (chunk: unknown) =>
        logs.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString('utf8')
              : String(chunk),
        );
      const spies = [
        jest
          .spyOn(process.stdout, 'write')
          .mockImplementation((c: unknown) => (capture(c), true)),
        jest
          .spyOn(process.stderr, 'write')
          .mockImplementation((c: unknown) => (capture(c), true)),
        ...(['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
          jest
            .spyOn(console, m)
            .mockImplementation((...a: unknown[]) =>
              capture(a.map(String).join(' ')),
            ),
        ),
      ];
      Logger.overrideLogger(new ConsoleLogger());
      const sent: NotifyMessage[] = [];
      jest
        .spyOn(BotNotifyTransport.prototype, 'send')
        .mockImplementation(async (m: NotifyMessage) => {
          sent.push(m);
          return 'sent';
        });
      const P = `/publisher/products/${w.product.id}`;
      const keep = (route: string, res: request.Response) => {
        responses.push({ route, text: res.text ?? JSON.stringify(res.body) });
        return res;
      };
      const sa = asMember(team.sales.telegramId, w.account.accountId);
      const ed = asMember(team.editor.telegramId, w.account.accountId);
      const owner = asMember(w.account.owner.telegramId, w.account.accountId);
      try {
        // ── Публичный путь: метка с контактом, заявка ────────────────────
        const sessionRef = testSessionRef();
        const ip = randomIp();
        keep(
          'events',
          await postEvent(
            s,
            {
              key: w.product.publicKey,
              eventId: randomUUID(),
              name: 'content_view',
              path: `/materials/demo?email=${encodeURIComponent(p.email)}&tel=${phoneDigits}`,
              contentSlug: 'demo-material',
              sessionRef,
              referrerHost: 'facebook.com',
              utm: {
                utm_source: p.email,
                utm_medium: 'social',
                utm_campaign: p.phone,
                utm_content: `wa.me/${phoneDigits}`,
              },
              consentState: 'not_required',
            },
            { origin: w.origin, ip },
          ),
        );
        const body = leadBody(w.product.publicKey, {
          name: p.name,
          contactMethod: 'phone',
          contact: p.phone,
          task: `${p.task}; пишіть на ${p.email}`,
          business: p.business,
          selfReported: { channel: 'social', note: `Самозвіт ${p.email}` },
          sessionRef,
          utm: { utm_source: p.phone },
        });
        const lr = keep(
          'leads',
          await postLead(s, body, { origin: w.origin, ip }),
        );
        expect(lr.status).toBe(201);
        // Отказ формы: контакт в поле без контакта.
        const badLead = keep(
          'leads 400',
          await postLead(
            s,
            leadBody(w.product.publicKey, {
              contactMethod: 'email',
              contact: p.phone,
              business: p.email,
            }),
            { origin: w.origin, ip: randomIp() },
          ),
        );
        expect(badLead.status).toBe(400);
        const lead = await s.prisma.pubLead.findFirstOrThrow({
          where: { submissionKey: body.submissionKey },
        });
        const cron = {
          now: new Date(),
          scope: { siteIds: [w.account.siteId] },
          deadline: new Date(Date.now() + 30_000),
        };
        await s.mod.get(LeadEnrichJob).run(cron);
        await s.mod.get(NotificationsDeliverJob).run(cron);
        expect(sent.length).toBeGreaterThan(0);

        // ── Кабинет: заявка, проспект, оплата, ретенция, CSV ────────────
        let card = keep(
          'lead card',
          await request(srv()).get(`${P}/leads/${lead.id}`).set(sa),
        ).body.data;
        let r = keep(
          'transition contacted',
          await request(srv())
            .post(`${P}/leads/${lead.id}/transition`)
            .set(sa)
            .send({
              opKey: randomUUID(),
              to: 'contacted',
              note: `${p.note} ${p.phone}`,
              expectedRevision: card.revision,
            }),
        );
        expect(r.status).toBe(200);
        card = r.body.data;
        r = keep(
          'transition qualified',
          await request(srv())
            .post(`${P}/leads/${lead.id}/transition`)
            .set(sa)
            .send({
              opKey: randomUUID(),
              to: 'qualified',
              confirmedInterestAt: new Date().toISOString(),
              note: p.note,
              expectedRevision: card.revision,
            }),
        );
        expect(r.status).toBe(200);
        card = r.body.data;
        expect(
          keep(
            'prospect note',
            await request(srv())
              .patch(`${P}/prospects/${card.prospectId}`)
              .set(sa)
              .send({
                opKey: randomUUID(),
                note: `${p.name}: ${p.email}`,
                expectedRevision: 1,
              }),
          ).status,
        ).toBe(200);
        expect(
          keep(
            'test-flag 400',
            await request(srv())
              .post(`${P}/leads/${lead.id}/test-flag`)
              .set(sa)
              .send({
                opKey: randomUUID(),
                testFlag: true,
                reason: `Перевірка ${p.email}`,
                expectedRevision: card.revision,
              }),
          ).status,
        ).toBe(400);
        expect(
          keep(
            'payment',
            await request(srv())
              .post(`${P}/payments`)
              .set(sa)
              .send({
                opKey: randomUUID(),
                prospectId: card.prospectId,
                leadId: lead.id,
                recordType: 'payment_received',
                payerKind: 'external',
                amountMinor: '150000',
                currency: 'UAH',
                occurredAt: new Date().toISOString(),
                paymentRef: `INV-${randomUUID().slice(0, 8)}`,
              }),
          ).status,
        ).toBe(201);
        // Раскрытие — первым шагом проверки (ответы раскрытия НЕ сканируются).
        const c = await request(srv())
          .post(`${P}/leads/${lead.id}/contact`)
          .send({ purpose: 'first_contact' })
          .set(sa);
        expect(c.status).toBe(200);
        expect(c.body.data.contact).toBe(p.phone);
        const n = await request(srv())
          .post(`${P}/leads/${lead.id}/notes`)
          .send({})
          .set(sa);
        expect(n.status).toBe(200);
        keep(
          'leads csv',
          await request(srv())
            .get(`${P}/leads`)
            .query({ format: 'csv' })
            .set(sa),
        );
        expect(
          keep(
            'retention',
            await request(srv())
              .post(`${P}/leads/${lead.id}/retention`)
              .set(sa)
              .send({
                opKey: randomUUID(),
                basis: 'Триває узгодження договору',
                nextReviewAt: new Date(
                  Date.now() + 30 * 86_400_000,
                ).toISOString(),
                expectedRevision: card.revision,
              }),
          ).status,
        ).toBe(200);

        // ── Контент и AI ─────────────────────────────────────────────────
        const src = keep(
          'source',
          await request(srv())
            .post(`${P}/sources`)
            .set(ed)
            .send({
              opKey: randomUUID(),
              kind: 'manual_text',
              title: 'Прайс компанії',
              fragment: `Ціна 2 000 грн. Відділ продажів: ${srcPerson.phone}, ${srcPerson.email}.`,
              visibility: 'public',
              usage: 'allowed',
            }),
        );
        expect(src.status).toBe(201);
        const srcId = src.body.data.id as string;
        // Контакт в полях без контакта — 400, значение в ответ не попадает.
        expect(
          keep(
            'source 400',
            await request(srv())
              .post(`${P}/sources`)
              .set(ed)
              .send({
                opKey: randomUUID(),
                kind: 'manual_text',
                title: `Від ${p.email}`,
                fragment: 'текст',
                visibility: 'public',
                usage: 'allowed',
              }),
          ).status,
        ).toBe(400);
        model.reply(() =>
          helperJson(
            [srcId],
            `Телефонуйте ${srcPerson.phone} або ${p.phone}, пишіть ${p.email}.`,
          ),
        );
        const h = keep(
          'helper',
          await request(srv())
            .post(`${P}/helper/answer`)
            .set(ed)
            .send({
              opKey: randomUUID(),
              question: `Яка ціна послуги?`,
              sourceIds: [srcId],
            }),
        );
        expect(h.status).toBe(200);
        expect(model.requests.length).toBeGreaterThan(0);
        const prompt = JSON.stringify(model.requests);
        for (const v of [...leadNeedles, ...sourceNeedles])
          expect({ v, inPrompt: prompt.includes(v) }).toEqual({
            v,
            inPrompt: false,
          });
        keep(
          'ai calls csv',
          await request(srv())
            .get(`${P}/ai/calls`)
            .query({ format: 'csv' })
            .set(owner),
        );
        const helper400 = keep(
          'helper 400',
          await request(srv())
            .post(`${P}/helper/answer`)
            .set(ed)
            .send({ opKey: randomUUID(), question: `Подзвоніть ${p.phone}` }),
        );
        expect(helper400.status).toBe(400);

        // ── Отчёт ───────────────────────────────────────────────────────
        const rep = keep(
          'report',
          await request(srv())
            .post(`${P}/reports`)
            .set(asMember(team.analyst.telegramId, w.account.accountId))
            .send({
              opKey: randomUUID(),
              kind: 'ad_hoc',
              periodStart: new Date(Date.now() - 86_400_000).toISOString(),
              periodEnd: new Date(Date.now() + 60_000).toISOString(),
            }),
        );
        expect(rep.status).toBe(201);
        keep(
          'audit',
          await request(srv())
            .get(`${P}/audit`)
            .query({ limit: 100 })
            .set(owner),
        );

        // ── Поиск ────────────────────────────────────────────────────────
        expect(await scan(leadNeedles, PII_ALLOWED_COLUMNS)).toEqual([]);
        expect(await scan(sourceNeedles, SOURCE_ALLOWED)).toEqual([]);
        // Источник действительно хранит свой контакт (колонка разрешена) —
        // поиск не «слепой».
        const raw = await s.prisma.pubSource.findUniqueOrThrow({
          where: { id: srcId },
        });
        expect(raw.fragment).toContain(srcPerson.email);
        const enc = await s.prisma.pubLeadContact.findFirstOrThrow({
          where: { leadId: lead.id },
        });
        expect(enc.contactEnc).toMatch(/^v1\./);
        // Ответ создания источника возвращает сам материал (кабинет) — для
        // контакта ИЗ источника это его колонка; контакт заявителя — нигде.
        for (const res of responses)
          for (const v of res.route === 'source'
            ? leadNeedles
            : [...leadNeedles, ...sourceNeedles])
            expect({ route: res.route, v, hit: res.text.includes(v) }).toEqual({
              route: res.route,
              v,
              hit: false,
            });
        for (const m of sent)
          for (const v of leadNeedles) expect(m.text).not.toContain(v);
      } finally {
        Logger.overrideLogger(false);
        spies.forEach((x) => x.mockRestore());
      }
      const joined = logs.join('\n');
      // Журнал действительно писался (отказ формы — строка фильтра).
      expect(joined).toContain('/public/publisher/v1/leads → 400');
      for (const v of [...leadNeedles, ...sourceNeedles])
        expect({ v, inLogs: joined.includes(v) }).toEqual({
          v,
          inLogs: false,
        });
    });
  },
);
