/**
 * AI Publisher P-B2 — маршруты AI по HTTP (проектный документ §11.1–11.3;
 * контракт `contracts/ai-api.ts`): асинхронный старт и опрос, коды §11.2 с
 * `details.callId`, роли матрицы §4.2 (OP — только helper), чужой кабинет
 * — 404, ПД в запросе — 400, `Cache-Control: private, no-store`, CSV без
 * формул, маршруты набора — только в eval-продукте, третья генерация по
 * HTTP идемпотентна. Раунд исправлений: CSV/md — сырые файлы (S2-2),
 * контакты источников и вопросов маскируются до провайдера и в журнале
 * (S1-3), производный контекст — без цепочки с отзывом (S1-2/H2), лимит
 * helper — по нормализованному вопросу (S3-4).
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  asMember,
  coreStack,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import { AiUsageRecorder } from '../../modules/site-ai/usage-recorder';
import { AuditService } from '../../modules/publisher/core/audit';
import { AiGatewayService } from '../../modules/publisher/ai/ai-gateway.service';
import {
  CliEvalGateway,
  FAKE_MODEL,
  FAKE_PROVIDER,
  FakeEvalModel,
} from '../../modules/publisher/ai/eval/cli-gateway';
import { seedEvalFixtures } from '../../modules/publisher/ai/eval/testing/synthetic-seed';
import { PII_MASK } from '../../modules/publisher/ai/pii-mask';
import { PublisherAiModule } from '../../modules/publisher/ai/ai.module';
import {
  csvOf,
  normalizedQuestion,
} from '../../modules/publisher/ai/ai.controller';
import {
  AI_PARAMS,
  ScriptedModel,
  approveParams,
  helperJson,
  openAiMonth,
  seedAiSource,
  seedApprovedArticle,
  seedQuestion,
} from '../../modules/publisher/ai/testing/ai-kit.testing';
import {
  grantRole,
  seedMembers,
  seedProduct,
  seedTwoAccounts,
  type SeededMembers,
  type TwoAccounts,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(90_000);

const FLAG = 'PUBLISHER_AI_ALLOW_UNEVALUATED';

ciDescribe('[AI-HTTP] P-B2: маршрути AI по HTTP', () => {
  let s: CoreStack;
  let w: TwoAccounts;
  let team: SeededMembers;
  let model: ScriptedModel;
  let src: string;
  const saved = process.env[FLAG];
  const srv = () => s.app!.getHttpServer();
  const as = (k: keyof SeededMembers) =>
    asMember(team[k].telegramId, w.a.accountId);
  const pid = () => w.a.product!.id;

  beforeAll(async () => {
    process.env[FLAG] = 'true';
    s = await coreStack({ http: true, imports: [PublisherAiModule] });
    w = await seedTwoAccounts(s.prisma, {
      withProducts: true,
      kind: 'working',
    });
    team = await seedMembers(s.prisma, w.a.product!, w.a.owner);
    model = new ScriptedModel();
    s.mod.get(AiGatewayService).useModel(model);
    await approveParams(
      s.prisma,
      { accountId: w.a.accountId, ownerMemberId: w.a.owner.memberId },
      pid(),
      AI_PARAMS,
    );
    await openAiMonth(s.prisma, w.a.product!, 20_000_000n);
    src = await seedAiSource(s.prisma, w.a.product!, {
      fragment: 'Ціна 2 000 грн',
      visibility: 'public',
    });
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
    await s.close();
  });
  beforeEach(() => {
    model.queue = [];
    model.fallback = null;
  });

  const helper = (who: keyof SeededMembers, body: Record<string, unknown>) =>
    request(srv())
      .post(`/publisher/products/${pid()}/helper/answer`)
      .set(as(who))
      .send({ opKey: randomUUID(), question: 'Яка ціна послуги?', ...body });

  it('helper: 200 з готовим викликом; опитування GET …/ai/calls/:id; no-store', async () => {
    model.reply(helperJson([src]));
    const res = await helper('operator', {});
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.data).toMatchObject({
      status: 'ok',
      call: { status: 'ok', generator: 'pub.helper.answer' },
    });
    const id = res.body.data.callId;
    const get = await request(srv())
      .get(`/publisher/products/${pid()}/ai/calls/${id}`)
      .set(as('operator'));
    expect(get.status).toBe(200);
    expect(get.body.data).toMatchObject({
      callId: id,
      status: 'ok',
      contextSourceIds: [src],
    });
    const task = await request(srv())
      .get(`/publisher/products/${pid()}/ai/tasks/${get.body.data.taskId}`)
      .set(as('editor'));
    expect(task.body.data).toMatchObject({
      generationsUsed: 1,
      remaining: 1,
      status: 'open',
    });
  });

  it('повтор opKey — той самий callId; з іншим тілом — 409', async () => {
    model.reply(helperJson([src]));
    const opKey = randomUUID();
    const a = await helper('editor', { opKey, question: 'Питання раз' });
    const b = await helper('editor', { opKey, question: 'Питання раз' });
    expect(b.body.data.callId).toBe(a.body.data.callId);
    const c = await helper('editor', { opKey, question: 'Інше питання' });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('PUB_IDEMPOTENCY_REUSED');
  });

  it('вимкнений генератор — 409 PUB_AI_DISABLED з callId; ручний шлях не зачеплено', async () => {
    const res = await request(srv())
      .post(`/publisher/products/${pid()}/questions/cluster`)
      .set(as('editor'))
      .send({ opKey: randomUUID(), questionIds: ['q1', 'q2'] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PUB_AI_DISABLED');
    expect(res.body.error.details).toMatchObject({
      status: 'disabled',
      generator: 'pub.questions.cluster',
    });
    expect(res.body.error.details.callId).toMatch(/^aic_/);
    // Р-PUB-Z2-17: объект не этого продукта (или несуществующий) — 404 до
    // шлюза, без записи вызова и задачи (z-isolation).
    const calls = () =>
      s.prisma.pubAiCall.count({ where: { productId: pid() } });
    const before = await calls();
    for (const [url, body] of [
      [`contents/c1/versions/draft`, {}],
      [`claims/extract`, { versionId: 'v1' }],
    ] as const) {
      const r = await request(srv())
        .post(`/publisher/products/${pid()}/${url}`)
        .set(as('editor'))
        .send({ opKey: randomUUID(), ...body });
      expect(r.status).toBe(404);
      expect(r.body.error?.code).toBe('PUB_NOT_FOUND');
    }
    expect(await calls()).toBe(before);
  });

  it('помилка схеми після повтору — 422 PUB_AI_SCHEMA_INVALID; таймаут — 503 PUB_AI_UNAVAILABLE', async () => {
    model.reply('не json', 'знову не json');
    const res = await helper('editor', { question: 'Зламана відповідь' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PUB_AI_SCHEMA_INVALID');
    const { TextModelError } = await import('../../modules/site-ai/text-model');
    model.reply(new TextModelError('unavailable'));
    const r2 = await helper('editor', { question: 'Недоступна модель' });
    expect(r2.status).toBe(503);
    expect(r2.body.error.code).toBe('PUB_AI_UNAVAILABLE');
  });

  it('ролі §4.2: OP — лише helper; VW — без AI; AN — без журналу; чужий кабінет — 404', async () => {
    const brief = await request(srv())
      .post(`/publisher/products/${pid()}/briefs/draft`)
      .set(as('operator'))
      .send({ opKey: randomUUID(), questionId: 'q1' });
    expect(brief.status).toBe(403);
    expect(brief.body.error.code).toBe('PUB_ROLE_REQUIRED');
    expect((await helper('viewer', {})).status).toBe(403);
    expect(
      (
        await request(srv())
          .get(`/publisher/products/${pid()}/ai/calls`)
          .set(as('analyst'))
      ).status,
    ).toBe(403);
    const foreign = await request(srv())
      .post(`/publisher/products/${w.b.product!.id}/helper/answer`)
      .set(as('editor'))
      .send({ opKey: randomUUID(), question: 'Чужий продукт' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('PUB_NOT_FOUND');
  });

  it('ПД у запиті — 400 (у модель контакт не йде); неіснуючі питання/матеріал — 404; формат поза списком — 400', async () => {
    const pii = await helper('editor', {
      question: 'Подзвоніть мені +380 67 123 45 67',
    });
    expect(pii.status).toBe(400);
    expect(pii.body.error.details.fields).toEqual([
      { field: 'question', code: 'pii' },
    ]);
    const nf = await request(srv())
      .post(`/publisher/products/${pid()}/briefs/draft`)
      .set(as('editor'))
      .send({ opKey: randomUUID(), questionId: 'no_such_q' });
    expect(nf.status).toBe(404);
    const nc = await request(srv())
      .post(`/publisher/products/${pid()}/contents/no_such/adaptations/draft`)
      .set(as('editor'))
      .send({ opKey: randomUUID(), format: 'post' });
    expect(nc.status).toBe(404);
    const bad = await request(srv())
      .post(`/publisher/products/${pid()}/contents/x/adaptations/draft`)
      .set(as('editor'))
      .send({ opKey: randomUUID(), format: 'reel' });
    expect(bad.status).toBe(400);
  });

  it('бриф, AI-перевірка та адаптація: вхід — з таблиць P-B1, контекст — дозволені джерела об’єкта', async () => {
    const restricted = await seedAiSource(s.prisma, w.a.product!, {
      usage: 'restricted',
      fragment: 'Закритий запис',
    });
    const art = await seedApprovedArticle(
      s.prisma,
      w.a.product!,
      [src, restricted],
      w.a.owner.memberId,
    );
    model.reply(
      JSON.stringify({
        question: 'Як підготувати формати?',
        audience: null,
        source_ids: [src],
        original_contribution: null,
        short_answer: 'Один матеріал — основа.',
        structure: ['Кроки'],
        format: 'instruction',
        cta: { text: 'Обговорити', intent_fit_note: 'Доречно' },
        channels: [],
        limitations: [],
        unresolved_questions: ['Аудиторія'],
      }),
    );
    const b = await request(srv())
      .post(`/publisher/products/${pid()}/briefs/draft`)
      .set(as('editor'))
      .send({ opKey: randomUUID(), questionId: art.questionId });
    expect(b.status).toBe(200);
    expect(b.body.data.call).toMatchObject({
      generator: 'pub.brief.draft',
      contextSourceIds: [src],
    });
    expect(model.requests.at(-1)!.user).not.toContain('Закритий запис');
    model.reply(
      JSON.stringify({
        object_version: 'v1',
        claims: [],
        blockers: [],
        unresolved_questions: [],
        recommendation: 'Пропозиція редактору',
      }),
    );
    const qa = await request(srv())
      .post(
        `/publisher/products/${pid()}/versions/${art.versionId}/qa-checks/ai-review`,
      )
      .set(as('product_owner'))
      .send({ opKey: randomUUID() });
    expect(qa.status).toBe(200);
    expect(model.requests.at(-1)!.user).toContain('Версія: v1');
    model.reply(
      JSON.stringify({
        parent_version: 'x',
        format: 'cards',
        title: 'Картки',
        body: null,
        cards: [{ title: 'Основа', text: 'Один матеріал' }],
        scenes: null,
        is_script: false,
        cta: 'Далі',
        used_source_ids: [src],
        preserved_caveats: [],
        unresolved_questions: [],
      }),
    );
    const ad = await request(srv())
      .post(
        `/publisher/products/${pid()}/contents/${art.contentId}/adaptations/draft`,
      )
      .set(as('editor'))
      .send({ opKey: randomUUID(), format: 'cards', request: 'П’ять карток' });
    expect(ad.status).toBe(200);
    expect(ad.body.data.call.output).toMatchObject({ format: 'cards' });
    expect(model.requests.at(-1)!.user).toContain('Формат: cards');
    expect(model.requests.at(-1)!.user).toContain(
      'З одного перевіреного матеріалу',
    );
    // результат — лише пропозиція: предметних записів AI не створює
    expect(
      await s.prisma.pubContent.count({
        where: { productId: pid(), parentContentId: art.contentId },
      }),
    ).toBe(0);
    expect(
      await s.prisma.pubQaCheck.count({ where: { versionId: art.versionId } }),
    ).toBe(0);
  });

  it('публічний режим: явне приватне джерело — 409 PUB_SOURCE_NOT_ALLOWED', async () => {
    const priv = await seedAiSource(s.prisma, w.a.product!, {
      visibility: 'private',
    });
    const res = await helper('editor', {
      audience: 'public',
      sourceIds: [priv],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'PUB_SOURCE_NOT_ALLOWED',
      details: { sourceIds: [priv] },
    });
  });

  it('журнал викликів: фільтр, сторінки, CSV без формул і з аудитом export', async () => {
    const list = await request(srv())
      .get(
        `/publisher/products/${pid()}/ai/calls?generator=pub.helper.answer&limit=2`,
      )
      .set(as('editor'));
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(2);
    expect(list.body.data.nextBefore).toBe(list.body.data.items[1].callId);
    const csv = await request(srv())
      .get(`/publisher/products/${pid()}/ai/calls?format=csv`)
      .set(as('editor'));
    // S2-2: сирий файл, не JSON-конверт
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toBe(
      'attachment; filename="publisher-ai-calls.csv"',
    );
    expect(csv.headers['cache-control']).toBe('private, no-store');
    expect(csv.text.startsWith('callId,generator,status,')).toBe(true);
    expect(csv.text).not.toContain('"success"');
    // усі рядки (не одна сторінка JSON): рядків = викликів продукту
    const total = await s.prisma.pubAiCall.count({
      where: { productId: pid() },
    });
    expect(csv.text.trim().split('\n')).toHaveLength(total + 1);
    expect(csv.headers['x-next-before']).toBeUndefined();
    // D1-03: оператор (ai.helper без ai.generate) бачить журнал — і CSV теж
    const opCsv = await request(srv())
      .get(`/publisher/products/${pid()}/ai/calls?format=csv`)
      .set(as('operator'));
    expect(opCsv.status).toBe(200);
    expect(opCsv.text.startsWith('callId,')).toBe(true);
    const exportAudit = await s.prisma.pubAuditEvent.count({
      where: { productId: pid(), objectType: 'ai_call', action: 'export' },
    });
    expect(exportAudit).toBe(2);
    expect(csvOf([{ a: '=SUM(A1)', b: 'x,y' }], ['a', 'b'])).toBe(
      'a,b\n\'=SUM(A1),"x,y"',
    );
  });

  it('третя генерація по HTTP: до ліміту — 400; після — 200, повтор opKey — той самий результат', async () => {
    model.fallback = helperJson([src]);
    const q = 'Питання для ліміту';
    const first = await helper('editor', { question: q });
    await helper('editor', { question: q });
    const third = await helper('editor', { question: q });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('PUB_AI_LIMIT');
    const taskId = first.body.data.call.taskId;
    const opKey = randomUUID();
    const url = `/publisher/products/${pid()}/ai/tasks/${taskId}/extra`;
    const ex = await request(srv())
      .post(url)
      .set(as('editor'))
      .send({ opKey, reason: 'Потрібен ще варіант' });
    expect(ex.status).toBe(200);
    expect(ex.body.data).toMatchObject({ extraAllowance: 1, remaining: 1 });
    const again = await request(srv())
      .post(url)
      .set(as('editor'))
      .send({ opKey, reason: 'Потрібен ще варіант' });
    expect(again.body.data).toEqual(ex.body.data);
    const op = await request(srv())
      .post(url)
      .set(as('operator'))
      .send({ opKey: randomUUID(), reason: 'ще' });
    expect(op.status).toBe(403);
    expect((await helper('editor', { question: q })).status).toBe(200);
  });

  it('маршрути набору — лише в eval-продукті (робочий — 404); прив’язки — лише PO', async () => {
    const r = await request(srv())
      .get(`/publisher/products/${pid()}/ai/configs`)
      .set(as('product_owner'));
    expect(r.status).toBe(404);
    const runs = await request(srv())
      .get(`/publisher/products/${pid()}/ai/eval-runs`)
      .set(as('editor'));
    expect(runs.status).toBe(404);
    const b = await request(srv())
      .get(`/publisher/products/${pid()}/ai/bindings`)
      .set(as('product_owner'));
    expect(b.status).toBe(200);
    expect(b.body.data).toEqual({ items: [], available: [] });
    expect(
      (
        await request(srv())
          .get(`/publisher/products/${pid()}/ai/bindings`)
          .set(as('editor'))
      ).status,
    ).toBe(403);
  });

  it('S1-3: контакти з інтерв’ю і тексту питання маскуються до провайдера; відповідь з контактом — у журналі з маскою', async () => {
    const interview = await seedAiSource(s.prisma, w.a.product!, {
      fragment:
        'Інтерв’ю: Олена, тел. +380 67 123 45 67, ivan.petrenko@example.com — розповіла про бюджет 1 200 000 грн 16.10.2026.',
    });
    const qid = await seedQuestion(
      s.prisma,
      w.a.product!,
      [interview],
      'Питання від клієнта +380 50 765 43 21: як підготувати формати?',
    );
    model.reply(
      JSON.stringify({
        question: 'Як підготувати формати?',
        audience: null,
        source_ids: [interview],
        original_contribution: null,
        short_answer: 'Зателефонувати Олені за +380 67 123 45 67.',
        structure: ['Кроки'],
        format: 'instruction',
        cta: { text: 'Обговорити', intent_fit_note: 'Доречно' },
        channels: [],
        limitations: [],
        unresolved_questions: [],
      }),
    );
    const b = await request(srv())
      .post(`/publisher/products/${pid()}/briefs/draft`)
      .set(as('editor'))
      .send({ opKey: randomUUID(), questionId: qid });
    expect(b.status).toBe(200);
    const sent = model.requests.at(-1)!.user;
    expect({
      phone: /123 45 67|765 43 21/.test(sent),
      email: sent.includes('ivan.petrenko@example.com'),
      masks: sent.split(PII_MASK).length - 1,
      // гроші й дати — не контакт
      money: sent.includes('1 200 000 грн'),
      date: sent.includes('16.10.2026'),
    }).toEqual({
      phone: false,
      email: false,
      masks: 3,
      money: true,
      date: true,
    });
    const row = await s.prisma.pubAiCall.findUnique({
      where: { id: b.body.data.callId },
    });
    expect(JSON.stringify(row!.output)).not.toContain('123 45 67');
    expect((row!.output as { short_answer: string }).short_answer).toBe(
      `Зателефонувати Олені за ${PII_MASK}.`,
    );
    expect(b.body.data.call.output.short_answer).toContain(PII_MASK);
    const audit = await s.prisma.pubAuditEvent.findFirst({
      where: { objectType: 'ai_call', objectId: row!.id, action: 'create' },
    });
    expect((audit!.meta as { piiMasked?: number }).piiMasked).toBe(3);
  });

  it('S1-2/H2: версія посилається на редакцію, наступник якої відкликаний — у контекст AI-перевірки вона не йде', async () => {
    const s0 = await seedAiSource(s.prisma, w.a.product!, {
      fragment: 'ПЕРША-РЕДАКЦІЯ-H2: клієнт Іван',
    });
    const s1 = await seedAiSource(s.prisma, w.a.product!, {
      usage: 'revoked',
      fragment: 'Клієнт відкликав згоду',
    });
    await s.prisma.pubSource.update({
      where: { id: s1 },
      data: { supersedesId: s0 },
    });
    const art = await seedApprovedArticle(
      s.prisma,
      w.a.product!,
      [s0],
      w.a.owner.memberId,
    );
    model.reply(
      JSON.stringify({
        object_version: 'v1',
        claims: [],
        blockers: [],
        unresolved_questions: [],
        recommendation: 'Пропозиція редактору',
      }),
    );
    const qa = await request(srv())
      .post(
        `/publisher/products/${pid()}/versions/${art.versionId}/qa-checks/ai-review`,
      )
      .set(as('product_owner'))
      .send({ opKey: randomUUID() });
    expect(qa.status).toBe(200);
    expect(qa.body.data.call.contextSourceIds).toEqual([]);
    expect(model.requests.at(-1)!.user).not.toContain('ПЕРША-РЕДАКЦІЯ-H2');
  });

  it('S3-4: ліміт helper — за нормалізованим питанням (регістр, пунктуація, пробіли — та сама задача)', async () => {
    expect(normalizedQuestion('  Скільки   КОШТУЄ послуга?! ')).toBe(
      normalizedQuestion('скільки коштує послуга'),
    );
    model.fallback = helperJson([src]);
    const a = await helper('editor', { question: 'Скільки коштує пакет?' });
    const b = await helper('editor', { question: 'скільки  коштує пакет' });
    expect(b.body.data.call.taskId).toBe(a.body.data.call.taskId);
    const c = await helper('editor', { question: 'СКІЛЬКИ КОШТУЄ ПАКЕТ!!!' });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('PUB_AI_LIMIT');
  });

  it('S2-2: протокол прогону ?format=md — сирий text/markdown з Content-Disposition; JSON — конверт', async () => {
    const ev = await seedProduct(s.prisma, {
      accountId: w.a.accountId,
      kind: 'eval',
    });
    await grantRole(
      s.prisma,
      ev,
      team.editor.memberId,
      'editor',
      `member:${w.a.owner.memberId}`,
    );
    await seedEvalFixtures(s.db, ev);
    const gw = new CliEvalGateway(s.db, {
      usage: new AiUsageRecorder(),
      audit: new AuditService(),
      model: new FakeEvalModel(),
      provider: FAKE_PROVIDER,
      modelName: FAKE_MODEL,
      fake: true,
    });
    const run = await gw.run(ev, 'fake', { only: ['AI-01'] });
    const url = `/publisher/products/${ev.id}/ai/eval-runs/${run.run.id}/protocol`;
    const md = await request(srv()).get(`${url}?format=md`).set(as('editor'));
    expect(md.status).toBe(200);
    expect(md.headers['content-type']).toMatch(/text\/markdown/);
    expect(md.headers['content-disposition']).toBe(
      `attachment; filename="publisher-eval-${run.run.id}.md"`,
    );
    expect(md.text.startsWith('# Протокол набору AI')).toBe(true);
    const json = await request(srv()).get(url).set(as('editor'));
    expect(json.body.success).toBe(true);
    expect(json.body.data.run.id).toBe(run.run.id);
  });
});
