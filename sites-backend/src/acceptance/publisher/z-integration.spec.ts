/**
 * Интеграция Z-1 AI Publisher (проектный документ, раздел «Интеграция
 * Z-1»): пакеты P-B1, P-B2, P-C, P-D, P-E вместе — НАСТОЯЩИЕ порты и
 * вклады (фейков соседей нет, `fakesBesides`). Проверяет стыки, которые
 * пакеты закрывали двойниками:
 *
 *  - создание продукта по API: шаги product-init P-C/P-E, кампания пилота
 *    ссылается на эксперимент `pilot` (Р-PUB-Z1-8) и на его новую версию;
 *  - первая live-публикация сайта (P-C) → `ContentPort.markPublished`
 *    (P-B1) и `PilotClockPort.setT0Once` (P-E) в одной транзакции, t0 один
 *    раз (Р-PUB-Z1-3);
 *  - несогласованная версия: `publishableVersion` без исключения
 *    (`approvalActive:false`), P-C отвечает `PUB_APPROVAL_REQUIRED`
 *    (Р-PUB-Z1-2); live-замена версии по тому же URL — прежнее
 *    согласование `superseded`, прежняя публикация `replaced`;
 *  - снятие материала редактором (P-B1) → все его публикации `withdrawn`
 *    через порт P-C, сайт отдаёт 410 (Р-PUB-Z1-1, Р-PUB-Z1-7);
 *  - принятие результата AI: мутация P-B1 с `aiCallId` → задача P-B2
 *    `open → done`; маршрут `…/ai/tasks/:id/accept` (Р-PUB-Z1-4).
 */
import { QaCatalogModule } from '../../modules/qa-catalog/qa-catalog.module';
import { QA_RUN_EVIDENCE_PORT } from '../../modules/publisher/core/ports';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { PublisherAiModule } from '../../modules/publisher/ai/ai.module';
import { PublisherContentModule } from '../../modules/publisher/content/content.module';
import {
  Kit,
  approvedArticle,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import { PILOT_EXPERIMENT_KEY } from '../../modules/publisher/reports/experiments.service';
import { PubPorts } from '../../modules/publisher/core/ports';
import { AuditService } from '../../modules/publisher/core/audit';
import { SiteRevalidateJob } from '../../modules/publisher/core/site-revalidate.job';
import {
  asMember,
  coreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import {
  realProvided,
  fakePortProviders,
  fakesBesides,
} from '../../modules/publisher/core/testing/fake-ports';
import { PublisherDistributionModule } from '../../modules/publisher/distribution/distribution.module';
import { approveParam } from '../../modules/publisher/distribution/testing/td08.testing';
import { PublisherLeadsModule } from '../../modules/publisher/leads/leads.module';
import { PublisherContentPublicModule } from '../../modules/publisher/public/content-public.module';
import { PublisherContentPublicController } from '../../modules/publisher/public/content-public.controller';
import { PublisherIntakePublicModule } from '../../modules/publisher/public/intake-public.module';
import { PublisherReportsModule } from '../../modules/publisher/reports/reports.module';
import {
  seedAccount,
  seedVerifiedHost,
  type SeededAccount,
  type SeededProduct,
} from '../../modules/publisher/testing/fixtures.testing';
import { testSlug } from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(240_000);

const MODULES = [
  PublisherContentModule,
  PublisherAiModule,
  PublisherDistributionModule,
  PublisherLeadsModule,
  PublisherReportsModule,
  PublisherContentPublicModule,
  PublisherIntakePublicModule,
];

/** Ключи гейта `public_publish` (кроме `offer_active_version` — его решает Kit). */
const PUBLISH_KEYS = [
  'niche',
  'language',
  'market',
  'domain_host',
  'hosting',
  'data_notice_version',
  'consent_map',
  'analytics_storage',
  'event_map',
  'perf_targets',
  'responsibles',
  'qualification_rules',
  'pilot_calendar',
  'launch_evidence_d0',
];

describe('интеграция Z-1: фейки только там, где нет настоящего модуля', () => {
  it('все порты и вклады соседей даёт полный набор модулей — фейков не остаётся', () => {
    const real = realProvided(MODULES);
    expect(real.contributions).toEqual(
      new Set([
        'product-init:site-channel',
        'product-init:budget-limit',
        'product-init:pilot-experiment',
        'member-reassign:leads',
        'member-reassign:distribution-actions',
        'member-reassign:contents',
      ]),
    );
    // Порт сводки прогона приёмки даёт qa-catalog (Р-PUB-Z2-27), не пакет.
    expect(fakesBesides(fakePortProviders(), MODULES)).toEqual([
      expect.objectContaining({ provide: QA_RUN_EVIDENCE_PORT }),
    ]);
    expect(
      fakesBesides(fakePortProviders(), [...MODULES, QaCatalogModule]),
    ).toEqual([]);
    // Один модуль — убираются только его фейки.
    expect(
      fakesBesides(fakePortProviders(), [PublisherReportsModule]),
    ).toHaveLength(fakePortProviders().length - 2);
  });
});

ciDescribe('интеграция Z-1: пакеты этапа 1 на настоящих портах', () => {
  let s: ContentStack;
  const srv = () => s.app!.getHttpServer();

  beforeAll(async () => {
    s = await coreStack({ http: true, imports: MODULES });
  });
  afterAll(async () => {
    await s.close();
  });

  /** Рабочий продукт через API (настоящие шаги product-init), режим live. */
  async function liveProduct(): Promise<{
    acc: SeededAccount;
    p: SeededProduct;
    k: Kit;
    owner: Record<string, string>;
    P: string;
  }> {
    const acc = await seedAccount(s.prisma);
    const owner = asMember(acc.owner.telegramId, acc.accountId);
    const created = await request(srv())
      .post(`/publisher/sites/${acc.siteId}/product`)
      .set(owner)
      .send({ opKey: randomUUID(), name: 'Продукт Z-1', kind: 'working' });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const row = await s.prisma.pubProduct.update({
      where: { id },
      data: { mode: 'live', liveSince: new Date() },
    });
    const p: SeededProduct = {
      id,
      accountId: acc.accountId,
      siteId: acc.siteId,
      kind: 'working',
      mode: 'live',
      status: 'active',
      revision: row.revision,
      publicKey: row.publicKey,
    };
    return {
      acc,
      p,
      k: new Kit(s, acc, p),
      owner,
      P: `/publisher/products/${id}`,
    };
  }

  async function openPublicPublish(acc: SeededAccount, p: SeededProduct) {
    for (const key of PUBLISH_KEYS) await approveParam(s.prisma, p, key);
    await seedVerifiedHost(
      s.prisma,
      acc.accountId,
      p.siteId,
      'ai-publisher.org',
    );
  }

  async function siteChannelId(productId: string): Promise<string> {
    const ch = await s.prisma.pubChannel.findFirstOrThrow({
      where: { productId, kind: 'site' },
      select: { id: true },
    });
    return ch.id;
  }

  async function pilotOf(productId: string) {
    return s.prisma.pubExperiment.findFirstOrThrow({
      where: {
        productId,
        key: PILOT_EXPERIMENT_KEY,
        status: { notIn: ['superseded', 'cancelled'] },
      },
      orderBy: { version: 'desc' },
    });
  }

  it('создание продукта: шаги P-C/P-E, кампания пилота → эксперимент pilot и его новая версия', async () => {
    const { p, owner, P } = await liveProduct();
    const pilot = await pilotOf(p.id);
    const campaign = await s.prisma.pubCampaign.findFirstOrThrow({
      where: { productId: p.id, code: 'pilot' },
    });
    expect(campaign.experimentId).toBe(pilot.id);
    // Шаг P-C `site-channel` — канал сайта создан настоящим вкладом.
    expect(await siteChannelId(p.id)).toEqual(expect.any(String));
    const v2 = await request(srv())
      .post(`${P}/experiments/${pilot.id}/version`)
      .set(owner)
      .send({
        opKey: randomUUID(),
        hypothesis: 'Уточнена гіпотеза пілоту для перевірки попиту.',
      });
    expect(v2.status).toBe(201);
    const after = await s.prisma.pubCampaign.findFirstOrThrow({
      where: { productId: p.id, code: 'pilot' },
    });
    expect(after.experimentId).toBe(v2.body.data.id);
  });

  it('live-публикация: статус материала, t0 один раз; v2 по тому же URL — replaced/superseded; несогласованная — 409 без 500', async () => {
    const { acc, p, k, owner, P } = await liveProduct();
    const slug = testSlug('z1');
    const a = await approvedArticle(k, { slug });
    await openPublicPublish(acc, p);
    let content = await k.transition(a.content, 'scheduled');
    const site = await siteChannelId(p.id);

    const ports = s.mod.get(PubPorts);
    const pub1 = await request(srv())
      .post(`${P}/publications`)
      .set(owner)
      .send({ opKey: randomUUID(), versionId: a.version.id, channelId: site });
    expect(pub1.status).toBe(201);
    expect(pub1.body.data).toMatchObject({
      stage: 'live',
      status: 'published',
    });
    content = await k.getContent(a.content.id);
    expect(content).toMatchObject({
      status: 'published',
      publishedVersionId: a.version.id,
    });
    const pilot1 = await pilotOf(p.id);
    expect(pilot1.t0?.toISOString()).toBe(pub1.body.data.publishedAt);
    expect(pilot1.status).toBe('running');

    // v2: correction_required → новая версия → согласование → scheduled → live.
    content = await k.transition(content, 'correction_required', {
      reason: 'Оновлення умов',
    });
    let v2 = await k.version(a.content.id, {
      title: 'Як обрати агенцію — оновлено',
      body: 'Оновлений текст.\n\nДругий абзац.',
      meta: {
        description: 'Опис',
        shortAnswer: 'Коротко',
        cta: 'Обговорити задачу',
        editor: 'Редакторка',
      },
      sourceIds: [a.source.id],
      claimIds: [a.claim.id],
      factIds: [],
      offerVersionId: a.version.offerVersionId,
    });
    // Несогласованная версия (черновик) — порт не бросает, P-C — 409.
    const draft = await k.tx((tx) =>
      ports.content().publishableVersion(tx, p, v2.id),
    );
    expect(draft).toMatchObject({
      approvalActive: false,
      approvalId: '',
      hash: '',
    });
    const early = await request(srv())
      .post(`${P}/publications`)
      .set(owner)
      .send({ opKey: randomUUID(), versionId: v2.id, channelId: site });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('PUB_APPROVAL_REQUIRED');

    v2 = await k.submit(v2);
    await k.qaPass(v2.id, 'editorial');
    await k.qaPass(v2.id, 'technical');
    await k.approve(v2);
    content = await k.transition(await k.getContent(a.content.id), 'scheduled');
    const pub2 = await request(srv())
      .post(`${P}/publications`)
      .set(owner)
      .send({ opKey: randomUUID(), versionId: v2.id, channelId: site });
    expect(pub2.status).toBe(201);
    const old = await s.prisma.pubPublication.findUniqueOrThrow({
      where: { id: pub1.body.data.id },
    });
    expect(old.status).toBe('replaced');
    const oldApproval = await s.prisma.pubApproval.findUniqueOrThrow({
      where: { id: a.approval.id },
    });
    expect(oldApproval.status).toBe('superseded');
    expect(await k.getContent(a.content.id)).toMatchObject({
      publishedVersionId: v2.id,
    });
    // t0 не сдвинулся.
    expect((await pilotOf(p.id)).t0?.toISOString()).toBe(
      pilot1.t0?.toISOString(),
    );
  });

  it('снятие материала редактором: публикации всех каналов (published и pending) → withdrawn, сайт отдаёт 410', async () => {
    const { acc, p, k, owner, P } = await liveProduct();
    const slug = testSlug('z1w');
    const a = await approvedArticle(k, { slug });
    await openPublicPublish(acc, p);
    await k.transition(a.content, 'scheduled');
    const site = await siteChannelId(p.id);
    const live = await request(srv())
      .post(`${P}/publications`)
      .set(owner)
      .send({ opKey: randomUUID(), versionId: a.version.id, channelId: site });
    expect(live.status).toBe(201);
    const tg = await request(srv())
      .post(`${P}/channels`)
      .set(owner)
      .send({
        opKey: randomUUID(),
        code: `tg${randomUUID().slice(0, 4)}`,
        title: 'Telegram',
        kind: 'own',
        utmSource: 'telegram',
        utmMedium: 'social',
      });
    expect(tg.status).toBe(201);
    const ext = await request(srv())
      .post(`${P}/publications`)
      .set(owner)
      .send({
        opKey: randomUUID(),
        versionId: a.version.id,
        channelId: tg.body.data.id,
        finalUrl: `https://t.me/s/z1_${randomUUID().slice(0, 6)}/1`,
        pending: true,
      });
    expect(ext.status).toBe(201);
    expect(ext.body.data.status).toBe('pending');
    const ctl = s.mod.get(PublisherContentPublicController, { strict: false });
    ctl.limiter.reset();
    const page = `/public/publisher/v1/contents/${slug}?key=${p.publicKey}`;
    expect((await request(srv()).get(page)).status).toBe(200);

    const c = await k.getContent(a.content.id);
    const w = await request(srv())
      .post(`${P}/contents/${a.content.id}/transition`)
      .set(owner)
      .send({
        opKey: randomUUID(),
        to: 'withdrawn',
        reason: 'Матеріал більше не актуальний',
        expectedRevision: c.revision,
      });
    expect(w.status).toBe(200);
    expect(w.body.data.status).toBe('withdrawn');
    const pubs = await s.prisma.pubPublication.findMany({
      where: { productId: p.id },
      select: { id: true, status: true },
    });
    expect(pubs.map((x) => x.status).sort()).toEqual([
      'withdrawn',
      'withdrawn',
    ]);
    const audit = await s.prisma.pubAuditEvent.findMany({
      where: {
        productId: p.id,
        objectType: 'publication',
        toStatus: 'withdrawn',
      },
      select: { objectId: true, actor: true },
    });
    expect(audit.map((x) => x.objectId).sort()).toEqual(
      pubs.map((x) => x.id).sort(),
    );
    expect(new Set(audit.map((x) => x.actor))).toEqual(
      new Set([`member:${acc.owner.memberId}`]),
    );
    const gone = await request(srv()).get(page);
    expect(gone.status).toBe(410);
    expect(gone.body.data).toEqual({ withdrawn: true });
    // Р-PUB-Z2-8: снятие — в журнале той же транзакции; задание
    // site-revalidate (настоящий модуль, фейковый HTTP) сбрасывает кэш
    // сайта одним вызовом и отмечает материал и обе публикации.
    const calls: string[] = [];
    const job = new SiteRevalidateJob(
      s.db,
      s.mod.get(AuditService, { strict: false }),
      async (url) => {
        calls.push(url);
        return { status: 200 };
      },
      {
        PUBLISHER_SITE_URL: 'https://z.example',
        PUBLISHER_REVALIDATE_SECRET: 'z'.repeat(20),
      } as NodeJS.ProcessEnv,
    );
    const scope = { siteIds: [acc.siteId] };
    const run = () =>
      job.run({
        now: new Date(),
        scope,
        deadline: new Date(Date.now() + 30_000),
      });
    expect(await run()).toMatchObject({ processed: 3 });
    expect(calls).toEqual(['https://z.example/api/revalidate']);
    expect((await run()).processed).toBe(0);
    // Общая публичная обвязка P-D: неизвестный ключ — конверт ошибки, no-store.
    const unknown = await request(srv()).get(
      `/public/publisher/v1/contents?key=pp_${'Z'.repeat(24)}`,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers['cache-control']).toBe('no-store');
    expect(unknown.body).toMatchObject({
      success: false,
      error: { code: 'PUB_NOT_FOUND' },
    });
  });

  it('AI: мутация P-B1 с aiCallId закрывает задачу (open → done); маршрут accept', async () => {
    const { k, owner, P } = await liveProduct();
    await k.offer();
    const source = await k.source();
    const q = await k.question({ text: `Питання ${randomUUID().slice(0, 6)}` });
    const question = await k.selectQuestion(q, 1, source.id);
    const call = await k.aiCall(
      'pub.brief.draft',
      { goal: 'x' },
      'question',
      question.id,
    );
    const brief = await k.brief({
      questionId: question.id,
      goal: 'Пояснити вибір',
      format: 'choice_guide',
      sourceIds: [source.id],
      aiCallId: call,
    });
    expect(brief.aiCallId).toBe(call);
    const task = await s.prisma.pubAiCall.findUniqueOrThrow({
      where: { id: call },
      select: { task: { select: { id: true, status: true } } },
    });
    expect(task.task.status).toBe('done');
    expect(
      await s.prisma.pubAuditEvent.count({
        where: {
          objectType: 'ai_task',
          objectId: task.task.id,
          toStatus: 'done',
        },
      }),
    ).toBe(1);

    // Маршрут accept: чужой вызов — 400, свой — 200, повтор — 409.
    const helper = await k.aiCall('pub.helper.answer', { answer: 'так' });
    const helperTask = (
      await s.prisma.pubAiCall.findUniqueOrThrow({ where: { id: helper } })
    ).taskId;
    const wrong = await request(srv())
      .post(`${P}/ai/tasks/${helperTask}/accept`)
      .set(owner)
      .send({ opKey: randomUUID(), callId: call });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.fields).toEqual([
      { field: 'callId', code: 'ai_call' },
    ]);
    const ok = await request(srv())
      .post(`${P}/ai/tasks/${helperTask}/accept`)
      .set(owner)
      .send({ opKey: randomUUID(), callId: helper });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ id: helperTask, status: 'done' });
    const again = await request(srv())
      .post(`${P}/ai/tasks/${helperTask}/accept`)
      .set(owner)
      .send({ opKey: randomUUID(), callId: helper });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PUB_TRANSITION_INVALID');
  });
});
