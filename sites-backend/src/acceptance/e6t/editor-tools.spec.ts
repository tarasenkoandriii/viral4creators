/**
 * Приёмка захода 9 — хвосты Э6-тер «Визуальный редактор» и мемо в
 * редакторе на реальном Postgres (основная роль с тенантом; Soniox и модель
 * — подделки, воркер — очередь-подделка):
 *  - №21 (Р-З9-5) список всех мемо во вкладке «Мемо» — `GET /editor/v1/memo/list`;
 *  - №22 «Чекати це» — `record/wait`: ожидание, не шаг; счётчик — цель мемо;
 *  - №23 «Как отменить» шага — из цели карты в ответе записи;
 *  - №114 микрофон «Сказать сейчас» — `POST /editor/v1/voice`: потолок
 *    «Сказать сейчас», бюджет обучения ДО провайдера, запись затирается;
 *  - №116 «отчёт для разработчика» одноразово выданной ссылкой: токен
 *    хешем, 7 дней, новая ссылка гасит прежнюю, отзыв, чужой сайт — 404;
 *  - №115 сверка воркером: автозапуск при сборке версии (идемпотентно),
 *    сухой прогон команд и запреты Т-2, отпечатки шаблона, модель — из
 *    бюджета обучения;
 *  - №119 промахи Т-4 по целям карты за 7 дней (`…/voice-map/site/misses`).
 */
import { HttpException } from '@nestjs/common';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { MemoService } from '../../modules/assist-site-voice-control/cabinet/memo.service';
import { SiteSonioxStt } from '../../modules/assist-site-voice/public/soniox-stt.client';
import {
  FakeSoniox,
  fakeRecording,
} from '../../modules/assist-site-voice/testing/fake-soniox.testing';
import { DevReportController } from '../../modules/assist-site-voice-map/dev-report.controller';
import { DevReportService } from '../../modules/assist-site-voice-map/dev-report.service';
import { EditorMemoController } from '../../modules/assist-site-voice-map/editor/editor-memo.controller';
import { EditorMemoService } from '../../modules/assist-site-voice-map/editor/editor-memo.service';
import { EditorSessionService } from '../../modules/assist-site-voice-map/editor/editor-session.service';
import { EditorVoiceController } from '../../modules/assist-site-voice-map/editor/editor-voice.controller';
import { EditorVoiceService } from '../../modules/assist-site-voice-map/editor/editor-voice.service';
import { MapMissesService } from '../../modules/assist-site-voice-map/map-misses';
import { VoiceMapToolsController } from '../../modules/assist-site-voice-map/voice-map-tools.controller';
import {
  VoiceMapWorkerService,
  type WorkerCheckReport,
} from '../../modules/assist-site-voice-map/voice-map-worker.service';
import { VoiceMapService } from '../../modules/assist-site-voice-map/voice-map.service';
import { BrowserJobHandlers } from '../../modules/browser-jobs/job-handlers';
import type { DescriptorResolveResult } from '../../modules/browser-jobs/protocol';
import { LearningBudget } from '../../modules/site-ai/learning-budget';
import { GeminiText } from '../../modules/site-ai/text-model';
import {
  REQUIRE_ASSIST_MANAGER,
  type AccountMembership,
} from '../../modules/site-core/account/roles';
import {
  PRODUCT_ROLES_KEY,
  SiteAccountGuard,
} from '../../modules/site-core/account/site-account.guard';
import {
  ALLOW_APPS_KEY,
  PUBLIC_ROUTE_KEY,
} from '../../modules/telegram-auth/allow-apps.decorator';
import { SitesDb } from '../../prisma/sites-db.service';

jest.setTimeout(300_000);

const DAY = 86_400_000;

describeDb('Приёмка захода 9 — инструменты редактора голосовой карты', () => {
  const st = new ChatStack();
  const fake = new FakeSoniox();
  let db: SitesDb;
  let maps: VoiceMapService;
  let editor: EditorSessionService;
  let memos: MemoService;
  let rec: EditorMemoService;
  let memoCtrl: EditorMemoController;
  let reports: DevReportService;
  let reportCtrl: DevReportController;
  let misses: MapMissesService;
  let voice: EditorVoiceService;
  let voiceCtrl: EditorVoiceController;
  let budget: LearningBudget;
  let stt: SiteSonioxStt;
  let env: NodeJS.ProcessEnv;
  let clock = Date.now();

  beforeAll(async () => {
    await st.init();
    db = new SitesDb(st.owner);
    env = {
      ...st.env,
      SONIOX_API_KEY: 'sx-test',
      ASSIST_VOICE_ENABLED: 'true',
    };
    maps = new VoiceMapService(db);
    maps.now = () => new Date(clock);
    editor = new EditorSessionService(db, maps);
    editor.now = () => new Date(clock);
    memos = new MemoService(db, st.owner as never);
    memos.now = () => new Date(clock);
    rec = new EditorMemoService(db, st.owner as never, maps, editor, memos);
    rec.now = () => new Date(clock);
    memoCtrl = new EditorMemoController(editor, rec);
    reports = new DevReportService(db, maps);
    reports.now = () => new Date(clock);
    reportCtrl = new DevReportController(reports);
    misses = new MapMissesService(db);
    stt = new SiteSonioxStt();
    stt.fetch = fake.fetch;
    stt.env = env;
    stt.pollDelayMs = 1;
    budget = new LearningBudget(db);
    voice = new EditorVoiceService(db, maps, editor, stt, budget, st.usage);
    voice.env = env;
    voiceCtrl = new EditorVoiceController(editor, voice);
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    clock = Date.now();
    fake.reset();
  });

  async function vcSite(
    members: Array<{ role: string; productRoles: Record<string, string> }> = [],
  ): Promise<ChatSite> {
    const s = await st.site({ name: 'Магазин', members });
    await setPlan(st.owner, s.accountId, 'business');
    await st.owner.siteHost.updateMany({
      where: { siteId: s.siteId },
      data: { expiresAt: new Date(Date.now() + 30 * DAY) },
    });
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: { voiceControlSiteState: 'on' },
    });
    return s;
  }

  async function member(
    s: ChatSite,
    role = 'owner',
  ): Promise<AccountMembership> {
    const m = await st.owner.siteAccountMember.findFirstOrThrow({
      where: { accountId: s.accountId, role },
      orderBy: { createdAt: 'asc' },
    });
    return {
      accountId: s.accountId,
      memberId: m.id,
      telegramId: m.telegramId,
      role: role as AccountMembership['role'],
      productRoles: m.productRoles as AccountMembership['productRoles'],
    };
  }

  async function session(s: ChatSite) {
    const who = await member(s);
    const link = await maps.editorLink(who, s.siteId, { path: '/product/1' });
    const ses = await editor.exchange({
      token: new URL(link.url).searchParams.get('v4c_edit')!,
      parentOrigin: s.origin,
    });
    return { who, s: ses.session };
  }

  async function code(p: Promise<unknown>): Promise<{
    status: number;
    code: string;
    errors: Array<{ path: string; code: string }>;
  }> {
    try {
      await p;
    } catch (e) {
      if (e instanceof HttpException) {
        const r = e.getResponse() as {
          code: string;
          errors?: Array<{ path: string; code: string }>;
        };
        return { status: e.getStatus(), code: r.code, errors: r.errors ?? [] };
      }
      throw e;
    }
    throw new Error('ожидался отказ');
  }

  const cart = {
    tag: 'button',
    role: 'button',
    text: 'В кошик',
    assistId: 'add-to-cart',
    unique: true,
  };
  const gift = {
    tag: 'button',
    role: 'button',
    text: 'Подарункова упаковка',
    assistId: 'gift-wrap',
    unique: true,
  };

  async function mapTargets(
    s: ChatSite,
    who: AccountMembership,
    targets: Array<Record<string, unknown>>,
  ) {
    const d = await maps.draft(who, s.siteId);
    await maps.patch(
      who,
      s.siteId,
      {
        expectedRevision: d.revision,
        ops: targets.map((t) => ({ op: 'upsert-target', target: t })),
      },
      'tma',
    );
  }

  // ── №21, №22, №23 ──────────────────────────────────────────────────────

  it('№21: список мемо в панели — номер, имя, статус, первая страница; удалённые и чужие — нет; без сессии — 401', async () => {
    const s = await vcSite();
    const { who, s: ses } = await session(s);
    expect(await code(memoCtrl.list(undefined, 'uk'))).toMatchObject({
      status: 401,
      code: 'EDITOR_SESSION_EXPIRED',
    });
    expect(await memoCtrl.list(ses, 'uk')).toMatchObject({
      items: [],
      limit: { used: 0, max: 20 },
    });
    await memoCtrl.record(ses, 'start', { path: '/product/1' });
    const st1 = (await memoCtrl.record(ses, 'step', {
      path: '/product/1',
      descriptor: cart,
      count: 0,
    })) as { step: unknown };
    await memoCtrl.record(ses, 'stop', {
      lang: 'uk',
      name: 'Покласти в кошик',
      path: '/product/1',
      steps: [st1.step],
      slots: [],
    });
    await memos.create(who, s.siteId, { name: 'Порожнє мемо' });
    const gone = await memos.create(who, s.siteId, { name: 'Видалене' });
    await st.owner.assistSiteMemo.updateMany({
      where: { siteId: s.siteId, number: gone.number },
      data: { status: 'removed' },
    });
    const other = await vcSite();
    await memos.create(await member(other), other.siteId, { name: 'Чуже' });
    const list = await memoCtrl.list(ses, 'uk');
    expect(
      list.items.map((x) => [x.number, x.name, x.status, x.page, x.steps]),
    ).toEqual([
      [1, 'Покласти в кошик', 'draft', '/product/1', 1],
      [2, 'Порожнє мемо', 'draft', null, 0],
    ]);
    // Удалённое мемо в лимит не входит (как у кабинета).
    expect(list.limit).toEqual({ used: 2, max: 20 });
    expect(JSON.stringify(list)).not.toContain('Чуже');
  });

  it('№22/№23: «Чекати це» — ожидание (не шаг); счётчик — цель мемо; шаг по цели карты несёт её «Как отменить»', async () => {
    const s = await vcSite();
    const { who, s: ses } = await session(s);
    await mapTargets(s, who, [
      {
        key: 'gift',
        scope: 'site',
        descriptor: gift,
        names: { uk: 'Подарунок' },
        undo: { assistId: 'gift-unwrap', at: null },
      },
    ]);
    await memoCtrl.record(ses, 'start', { path: '/product/1' });
    const a = (await memoCtrl.record(ses, 'step', {
      path: '/product/1',
      descriptor: gift,
      count: 0,
    })) as unknown as {
      kind: string;
      step: Record<string, unknown>;
      undo: unknown;
    };
    expect(a).toMatchObject({
      kind: 'step',
      undo: { assistId: 'gift-unwrap', src: 'map', key: 'gift' },
    });
    const b = (await memoCtrl.record(ses, 'step', {
      path: '/product/1',
      descriptor: cart,
      count: 1,
    })) as unknown as { step: Record<string, unknown>; undo: unknown };
    expect(b.undo).toMatchObject({
      assistId: 'remove-from-cart',
      src: 'standard',
    });
    // «Чекати це»: значок корзины — цель «счётчик +1»; текст — ожидание шага.
    const counter = await memoCtrl.record(ses, 'wait', {
      path: '/product/1',
      descriptor: {
        tag: 'a',
        role: 'link',
        text: 'Кошик (0)',
        assistId: 'nav-cart',
        unique: true,
      },
    });
    expect(counter).toEqual({
      kind: 'counter',
      target: { assistId: 'nav-cart', text: 'кошик' },
      delta: 1,
      now: 0,
    });
    const appear = (await memoCtrl.record(ses, 'wait', {
      path: '/product/1',
      descriptor: {
        tag: 'other',
        role: 'button',
        text: 'Товар у кошику',
        unique: true,
      },
    })) as { kind: string; text: string };
    expect(appear).toEqual({ kind: 'appear', text: 'Товар у кошику' });
    expect(
      await code(
        memoCtrl.record(ses, 'wait', {
          path: '/product/1',
          descriptor: {
            tag: 'button',
            role: 'button',
            text: '',
            assistId: 'x-1',
          },
        }),
      ),
    ).toMatchObject({ status: 422, code: 'EDITOR_MEMO_STEP_SKIPPED' });
    const saved = (await memoCtrl.record(ses, 'stop', {
      lang: 'uk',
      name: 'Подарунок і кошик',
      path: '/product/1',
      steps: [a.step, { ...b.step, expect: { appear: appear.text } }],
      slots: [],
      goalCounter: (counter as { target: unknown }).target
        ? { target: (counter as { target: unknown }).target, delta: 1 }
        : null,
    })) as { number: number; draftRevision: number };
    const row = await st.owner.assistSiteMemo.findFirstOrThrow({
      where: { siteId: s.siteId, number: saved.number },
    });
    const draft = row.draft as {
      steps: Array<{ expect: unknown }>;
      goal: { expect: unknown[] };
    };
    expect(draft.steps[1].expect).toEqual({ appear: 'Товар у кошику' });
    expect(draft.goal.expect).toEqual([
      {
        kind: 'counter',
        target: { assistId: 'nav-cart', text: 'кошик' },
        delta: 1,
      },
    ]);
    // «Как отменить» в мемо не копируется — живёт в цели карты.
    expect(JSON.stringify(row.draft)).not.toContain('gift-unwrap');
    // Правка: открыть мемо — шаги, их «Как отменить» и счётчик цели.
    const open = await rec.start(await editor.resolve(ses), {
      path: '/product/1',
      memo: saved.number,
    });
    expect(open.memo!.undo.map((u) => u?.assistId ?? null)).toEqual([
      'gift-unwrap',
      'remove-from-cart',
    ]);
    expect(open.memo!.counter).toMatchObject({ kind: 'counter', delta: 1 });
    // Снять счётчик (`goalCounter: null`), Δ вне пределов — 422.
    expect(
      await code(
        memoCtrl.record(ses, 'stop', {
          memo: saved.number,
          expectedRevision: saved.draftRevision,
          steps: draft.steps,
          slots: [],
          goalCounter: {
            target: { assistId: 'nav-cart', text: 'кошик' },
            delta: 40,
          },
        }),
      ),
    ).toMatchObject({ status: 422, code: 'EDITOR_MEMO_INVALID' });
    const off = (await memoCtrl.record(ses, 'stop', {
      memo: saved.number,
      expectedRevision: saved.draftRevision,
      steps: draft.steps,
      slots: [],
      goalCounter: null,
    })) as { number: number };
    const row2 = await st.owner.assistSiteMemo.findFirstOrThrow({
      where: { siteId: s.siteId, number: off.number },
    });
    expect(
      (
        row2.draft as { goal: { expect: Array<{ kind: string }> } }
      ).goal.expect.map((g) => g.kind),
    ).not.toContain('counter');
  });

  // ── №114 ──────────────────────────────────────────────────────────────

  it('№114: микрофон — текст из записи; запись — одна проверка «Сказать сейчас»; звук затирается; без сессии — 401', async () => {
    const s = await vcSite();
    const { who, s: ses } = await session(s);
    await mapTargets(s, who, [
      {
        key: 'gift',
        scope: 'site',
        descriptor: gift,
        names: { uk: 'Подарунок' },
      },
    ]);
    fake.transcript = 'натисни подарунок';
    const audio = fakeRecording();
    const r = await voiceCtrl.transcribe(ses, 'audio/webm;codecs=opus', audio);
    expect(r).toMatchObject({ text: 'натисни подарунок', lang: 'uk' });
    expect(r.left).toBe(99);
    expect(audio.every((b) => b === 0)).toBe(true);
    // Подсказки распознаванию — имена черновика карты, к провайдеру.
    expect(JSON.stringify(fake.calls)).toContain('Подарунок');
    // Запись у провайдера удалена (файл и транскрипция).
    expect(fake.count('DELETE', '/files/')).toBe(1);
    const spent = await st.owner.siteAiUsage.findMany({
      where: { siteId: s.siteId, operation: 'assist-learn' },
    });
    expect(spent).toHaveLength(1);
    // Аудит P3: резерв (35 с) поправлен на факт секунд — в бюджете обучения
    // ровно стоимость записи, не оценка.
    const ls = await st.owner.assistLearningSpend.findFirstOrThrow({
      where: { siteId: s.siteId },
    });
    expect(Number(ls.spentMicroUsd)).toBe(spent[0].costMicroUsd);
    // Следующая проверка «Сказать сейчас» — уже из 98.
    const t = await editor.tryCommand(await editor.resolve(ses), {
      text: 'подарунок',
      snapshot: { url: s.url('/product/1'), title: 'x', elements: [] },
    });
    expect(t.left).toBe(98);
    expect(
      await code(
        voiceCtrl.transcribe(undefined, 'audio/webm', fakeRecording()),
      ),
    ).toMatchObject({ status: 401 });
  });

  it('№114: не та запись — 400; голос выключен платформой — 409; нет бюджета обучения — 402 ДО провайдера; тишина — 422', async () => {
    const s = await vcSite();
    const { s: ses } = await session(s);
    expect(
      await code(
        voiceCtrl.transcribe(
          ses,
          'audio/webm',
          Buffer.from('not audio at all, plain text bytes'),
        ),
      ),
    ).toMatchObject({ status: 400, code: 'EDITOR_VOICE_AUDIO_INVALID' });
    voice.env = { ...env, ASSIST_VOICE_ENABLED: 'false' };
    expect(
      await code(voiceCtrl.transcribe(ses, 'audio/webm', fakeRecording())),
    ).toMatchObject({ status: 409, code: 'EDITOR_VOICE_UNAVAILABLE' });
    voice.env = env;
    await st.owner.assistLearningSpend.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        period: new Date(clock).toISOString().slice(0, 7),
        spentMicroUsd: BigInt(10_000_000_000),
      },
    });
    const before = fake.calls.length;
    expect(
      await code(voiceCtrl.transcribe(ses, 'audio/webm', fakeRecording())),
    ).toMatchObject({ status: 402, code: 'EDITOR_VOICE_BUDGET' });
    expect(fake.calls.length).toBe(before);
    // Без бюджета проверка дня не сгорает (сначала деньги, потом потолок).
    const vm = await st.owner.assistSiteVoiceMap.findFirstOrThrow({
      where: { siteId: s.siteId },
    });
    expect(vm.tryCount).toBe(0);
    await st.owner.assistLearningSpend.updateMany({
      where: { siteId: s.siteId },
      data: { spentMicroUsd: BigInt(0) },
    });
    fake.stt = 'silence';
    expect(
      await code(voiceCtrl.transcribe(ses, 'audio/webm', fakeRecording())),
    ).toMatchObject({ status: 422, code: 'EDITOR_VOICE_NOT_HEARD' });
  });

  // ── №116 ──────────────────────────────────────────────────────────────

  function fakeRes() {
    const r = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: '',
      status(c: number) {
        r.statusCode = c;
        return r;
      },
      setHeader(k: string, v: string) {
        r.headers[k.toLowerCase()] = v;
      },
      end(b: string) {
        r.body = b;
      },
      json(b: unknown) {
        r.body = JSON.stringify(b);
      },
    };
    return r;
  }
  const read = async (siteId: string, token: string, format?: string) => {
    const res = fakeRes();
    await reportCtrl.read(siteId, token, 'uk', format, res as never);
    return res;
  };

  it('№116: маршруты — кабинет только владелец/менеджер; чтение по ссылке — публичное', () => {
    expect(
      Reflect.getMetadata(ALLOW_APPS_KEY, VoiceMapToolsController),
    ).toEqual(['assist']);
    expect(
      Reflect.getMetadata('__guards__', VoiceMapToolsController),
    ).toContain(SiteAccountGuard);
    expect(
      Reflect.getMetadata(PRODUCT_ROLES_KEY, VoiceMapToolsController),
    ).toEqual(REQUIRE_ASSIST_MANAGER);
    expect(
      Reflect.getMetadata(PUBLIC_ROUTE_KEY, DevReportController),
    ).toBeTruthy();
  });

  it('№116: ссылка — токен один раз (в базе хеш), страница без скриптов, просмотры; новая гасит прежнюю; отзыв, срок, чужой сайт — 404', async () => {
    const s = await vcSite();
    const who = await member(s);
    await mapTargets(s, who, [
      {
        key: 'buy',
        scope: 'site',
        descriptor: {
          tag: 'button',
          role: 'button',
          text: 'Додати',
          unique: true,
          css: 'form > button',
        },
        names: { uk: 'Додати' },
        semanticType: 'add-to-cart',
      },
    ]);
    const l1 = await reports.create(who, s.siteId);
    expect(l1.path).toBe(
      `/assist/sites/${s.siteId}/voice-map/site/dev-report/${l1.token}`,
    );
    expect(l1.counts).toMatchObject({ targets: 1, missing: 1 });
    const rows = await st.owner.assistSiteVoiceMapDevReport.findMany({
      where: { siteId: s.siteId },
    });
    expect(JSON.stringify(rows)).not.toContain(l1.token);
    const ok = await read(s.siteId, l1.token);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/html');
    expect(ok.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body).toContain('data-assist-id=&quot;add-to-cart&quot;');
    expect(ok.body).not.toMatch(/<script/i);
    const js = await read(s.siteId, l1.token, 'json');
    expect(JSON.parse(js.body).data.counts.targets).toBe(1);
    // Аудит P3: HEAD и бот превью ссылки — не просмотр.
    for (const req of [
      { method: 'HEAD', headers: {} },
      {
        method: 'GET',
        headers: { 'user-agent': 'TelegramBot (like TwitterBot)' },
      },
      {
        method: 'GET',
        headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' },
      },
    ]) {
      const res = fakeRes();
      await reportCtrl.read(
        s.siteId,
        l1.token,
        'uk',
        undefined,
        res as never,
        req as never,
      );
      expect(res.statusCode).toBe(200);
    }
    expect(await reports.status(who, s.siteId)).toMatchObject({
      active: { views: 2 },
    });
    // Чужой сайт в пути — та же «недействительна», что и мусор.
    const other = await vcSite();
    expect((await read(other.siteId, l1.token)).statusCode).toBe(404);
    expect((await read(s.siteId, 'x'.repeat(32))).statusCode).toBe(404);
    expect((await read(s.siteId, '../../etc')).statusCode).toBe(404);
    // Снимок: правка карты после выдачи ссылку не меняет.
    await mapTargets(s, who, [
      {
        key: 'later',
        scope: 'site',
        descriptor: gift,
        names: { uk: 'Пізніше' },
      },
    ]);
    expect((await read(s.siteId, l1.token)).body).not.toContain('later');
    // Новая ссылка гасит прежнюю.
    const l2 = await reports.create(who, s.siteId);
    expect((await read(s.siteId, l1.token)).statusCode).toBe(404);
    expect((await read(s.siteId, l2.token)).body).toContain('later');
    // Срок — 7 дней.
    clock += 7 * DAY + 1_000;
    expect((await read(s.siteId, l2.token)).statusCode).toBe(404);
    clock = Date.now();
    const l3 = await reports.create(who, s.siteId);
    expect(await reports.revoke(who, s.siteId)).toEqual({ revoked: 1 });
    expect((await read(s.siteId, l3.token)).statusCode).toBe(404);
    expect(await reports.status(who, s.siteId)).toEqual({ active: null });
    // Чужой кабинет не выдаёт ссылку на этот сайт.
    expect(
      (await code(reports.create(await member(other), s.siteId))).status,
    ).toBe(404);
  });

  it('№116 (аудит P3): две выдачи разом — живая ссылка одна (замок сайта)', async () => {
    const s = await vcSite();
    const who = await member(s);
    const [a, b] = await Promise.all([
      reports.create(who, s.siteId),
      reports.create(who, s.siteId),
    ]);
    const live = await st.owner.assistSiteVoiceMapDevReport.count({
      where: { siteId: s.siteId, revokedAt: null },
    });
    expect(live).toBe(1);
    const codes = [
      (await read(s.siteId, a.token)).statusCode,
      (await read(s.siteId, b.token)).statusCode,
    ].sort();
    expect(codes).toEqual([200, 404]);
  });

  // ── №119 ──────────────────────────────────────────────────────────────

  it('№119: промахи Т-4 по целям за 7 дней — «нажмите сами», «не найдена», «не туда», страницы `mapMiss`; старше и чужие — нет', async () => {
    const s = await vcSite();
    const who = await member(s);
    const conv = await st.owner.assistSiteConversation.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId: 'v-miss',
        ipHash: 'ip',
        parentOrigin: s.origin,
        lastMessageAt: new Date(),
      },
    });
    const plan = async (at: Date) =>
      st.owner.assistSiteUiPlan.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          conversationId: conv.id,
          visitorId: 'v-miss',
          utteranceMasked: 'доставка',
          source: 'voice',
          pageUrl: s.url('/'),
          steps: [],
          status: 'done',
          needsConfirm: false,
          confirmBefore: at,
          expiresAt: at,
          createdAt: at,
        },
      });
    const log = async (planId: string, at: Date, p: Record<string, unknown>) =>
      st.owner.assistSiteUiActionLog.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          planId,
          stepIndex: 0,
          action: 'click',
          risk: 'auto',
          result: 'done',
          url: s.url('/delivery'),
          createdAt: at,
          ...p,
        },
      });
    const now = new Date();
    const p1 = await plan(now);
    await log(p1.id, now, {
      mapKey: 'delivery',
      result: 'manual',
      reason: 'not_trusted',
    });
    const p2 = await plan(now);
    await log(p2.id, now, { mapKey: 'delivery' });
    await log(p2.id, new Date(now.getTime() + 2_000), {
      action: 'stop',
      result: 'stopped',
      reason: 'esc',
    });
    const p3 = await plan(now);
    await log(p3.id, now, {
      action: 'plan',
      result: 'skipped',
      mapMiss: true,
      url: s.url('/cart'),
    });
    const old = new Date(now.getTime() - 8 * DAY);
    const p4 = await plan(old);
    await log(p4.id, old, {
      mapKey: 'delivery',
      result: 'failed',
      reason: 'no_target',
    });
    const v = await misses.misses(who, s.siteId);
    expect(v.items).toEqual([
      expect.objectContaining({
        key: 'delivery',
        self: 1,
        notFound: 0,
        wrong: 1,
        done: 1,
        page: '/delivery',
      }),
    ]);
    expect(v.pages).toEqual([
      expect.objectContaining({ page: '/cart', misses: 1 }),
    ]);
    const other = await vcSite();
    expect(
      await misses.misses(await member(other), other.siteId),
    ).toMatchObject({
      items: [],
      pages: [],
    });
    expect(
      (await code(misses.misses(await member(other), s.siteId))).status,
    ).toBe(404);
  });

  // ── №115 ──────────────────────────────────────────────────────────────

  describe('№115: сверка воркером — автозапуск, сухой прогон, отпечатки', () => {
    let jobsOn = true;
    const enqueued: Array<Record<string, unknown>> = [];
    const cancelled: string[] = [];
    let worker: VoiceMapWorkerService;
    let handlers: BrowserJobHandlers;
    let modelReply: string | null = null;
    const modelCalls: string[] = [];

    beforeAll(() => {
      handlers = new BrowserJobHandlers();
      const jobs = {
        enabled: () => jobsOn,
        assertEnabled: () => undefined,
        latest: (_acc: string, where: Record<string, unknown>) =>
          st.owner.siteBrowserJob.findFirst({
            where,
            orderBy: { createdAt: 'desc' },
          }),
        cancelIfQueued: async (_acc: string, id: string) => {
          cancelled.push(id);
          return true;
        },
        enqueue: async (_acc: string, input: Record<string, unknown>) => {
          enqueued.push(input);
          return { id: `job-${enqueued.length}`, status: 'queued' };
        },
      };
      const text = new GeminiText().useClient({
        models: {
          generateContent: async (req: {
            contents: Array<{ parts: Array<{ text: string }> }>;
          }) => {
            modelCalls.push(req.contents[0].parts[0].text);
            return {
              text: modelReply ?? '{"command": true, "steps": []}',
              usageMetadata: {
                promptTokenCount: 900,
                candidatesTokenCount: 30,
              },
            };
          },
        },
      } as never);
      worker = new VoiceMapWorkerService(
        maps,
        jobs as never,
        handlers,
        text,
        budget,
        st.usage,
        db,
      );
      worker.onModuleInit();
    });
    afterAll(() => {
      maps.onVersionBuilt = null;
    });

    const el = (
      p: { ref: string; text: string } & Record<string, unknown>,
    ) => ({
      role: 'button',
      tag: 'button',
      hiddenLabel: null,
      assistId: null,
      inputType: null,
      href: null,
      disabled: false,
      checked: null,
      selected: null,
      options: [],
      heading: null,
      submit: false,
      inForm: false,
      confirmZone: false,
      pd: false,
      toggle: false,
      gesture: null,
      inView: true,
      box: null,
      ...p,
    });

    it('сборка версии на проверке ставит сверку сама (идемпотентно по версии); задержанная и выключенный воркер — нет', async () => {
      const s = await vcSite();
      const who = await member(s);
      await mapTargets(s, who, [
        {
          key: 'gift',
          scope: 'site',
          descriptor: gift,
          names: { uk: 'Подарунок' },
        },
      ]);
      enqueued.length = 0;
      // Аудит P3: сверка прежней версии ещё ждёт воркера — устарела, отмена
      // (иначе потолок активных не пустит новую); идущая — не трогается.
      const host = await st.owner.siteHost.findFirstOrThrow({
        where: { siteId: s.siteId },
      });
      const job = (refId: string, status: string) =>
        st.owner.siteBrowserJob.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            hostId: host.id,
            kind: 'descriptor-resolve',
            origin: 'voice-map-check',
            refId,
            status,
            params: {},
            expiresAt: new Date(Date.now() + DAY),
          },
        });
      await job('v00', 'running');
      const old = await job('v0', 'queued');
      cancelled.length = 0;
      const v = await maps.buildVersion(
        { accountId: s.accountId, memberId: who.memberId },
        s.siteId,
        'tma',
      );
      expect(v.status).toBe('checking');
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({
        siteId: s.siteId,
        origin: 'voice-map-check',
        refId: `v${v.number}`,
        requestedBy: `auto:v${v.number}`,
        idempotencyKey: `voice-map-check:${s.siteId}:v${v.number}`,
      });
      expect(cancelled).toEqual([old.id]);
      jobsOn = false;
      await maps.buildVersion(
        { accountId: s.accountId, memberId: who.memberId },
        s.siteId,
        'tma',
      );
      expect(enqueued).toHaveLength(1);
      jobsOn = true;
      // Ворота не пройдены (фраза двух целей) — версия `held`, сверки нет.
      await mapTargets(s, who, [
        {
          key: 'gift2',
          scope: 'site',
          descriptor: cart,
          names: { uk: 'Подарунок' },
        },
      ]);
      const held = await maps.buildVersion(
        { accountId: s.accountId, memberId: who.memberId },
        s.siteId,
        'tma',
      );
      expect(held.status).toBe('held');
      expect(enqueued).toHaveLength(1);
    });

    it('итог сверки: сухой прогон (прямой путь, нет цели, модель из бюджета обучения), запреты Т-2 — 0 шагов, отпечатки шаблона', async () => {
      const s = await vcSite();
      const who = await member(s);
      // Шаблон — сначала (id выдаёт сервер), цели — на его id.
      const d0 = await maps.draft(who, s.siteId);
      await maps.patch(
        who,
        s.siteId,
        {
          expectedRevision: d0.revision,
          ops: [
            {
              op: 'upsert-template',
              template: {
                name: 'Товар',
                pathPattern: '/product/*',
                samplePages: ['/product/1', '/product/2'],
              },
            },
          ],
        },
        'tma',
      );
      const dt = await maps.draft(who, s.siteId);
      const tp = dt.content.templates[0].id;
      await maps.patch(
        who,
        s.siteId,
        {
          expectedRevision: dt.revision,
          ops: [
            {
              op: 'upsert-target',
              target: {
                key: 'gift',
                scope: 'template',
                templateId: tp,
                descriptor: gift,
                names: { uk: 'Подарунок' },
                synonyms: { uk: [{ text: 'упаковка', origin: 'owner' }] },
              },
            },
            {
              op: 'upsert-target',
              target: {
                key: 'reviews',
                scope: 'template',
                templateId: tp,
                descriptor: {
                  tag: 'button',
                  role: 'tab',
                  text: 'Відгуки',
                  assistId: 'reviews',
                  unique: true,
                },
                names: { uk: 'Відгуки' },
              },
            },
          ],
        },
        'tma',
      );
      const v = await maps.buildVersion(
        { accountId: s.accountId, memberId: who.memberId },
        s.siteId,
        'tma',
      );
      const page = (path: string, withGift: boolean) => ({
        url: s.url(path),
        ok: true,
        error: null,
        counts: {},
        snapshot: {
          url: s.url(path),
          title: 'Товар',
          elements: [
            el({
              ref: 'e1',
              text: 'Відгуки',
              role: 'tab',
              assistId: 'reviews',
            }),
            el({ ref: 'e2', text: 'Оплатити' }),
            ...(withGift
              ? [
                  el({
                    ref: 'e3',
                    text: 'Подарункова упаковка',
                    assistId: 'gift-wrap',
                  }),
                ]
              : []),
          ],
        },
      });
      const result: DescriptorResolveResult = {
        pages: [
          page('/product/1', false),
          page('/product/2', true),
          {
            url: s.url('/product/3'),
            ok: false,
            error: 'nav_failed' as never,
            counts: {},
            snapshot: null,
          },
        ],
      };
      const job = {
        id: 'job-x',
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: 'h',
        kind: 'descriptor-resolve' as const,
        origin: 'voice-map-check' as const,
        refId: `v${v.number}`,
        params: {} as never,
        testAccountId: null,
      };
      modelCalls.length = 0;
      const report = (await handlers.get('voice-map-check')!.onDone!(
        job,
        result as never,
      )) as WorkerCheckReport;
      expect(report.dryRun).toBeTruthy();
      const by = Object.fromEntries(
        report.dryRun!.commands.map((c) => [
          `${c.key}:${c.kind}`,
          [c.outcome, c.path],
        ]),
      );
      // Команда проверяется на первом образце, где действует её цель (тот же шаблон):
      // на /product/1 подарка нет — «нет цели», это и есть находка.
      expect(by['gift:name']).toEqual(['missing', '/product/1']);
      expect(by['reviews:name']).toEqual(['ok_map', '/product/1']);
      expect(report.dryRun!.forbiddenBlocked).toBe(true);
      expect(report.templates).toEqual([
        expect.objectContaining({
          templateId: tp,
          pathPattern: '/product/*',
        }),
      ]);
      expect(report.templates![0].pages.map((p) => p.path)).toEqual([
        '/product/1',
        '/product/2',
      ]);
      // Прямой путь нашёл всё — модель не звали, денег нет.
      expect(modelCalls).toHaveLength(0);
      expect(
        await st.owner.siteAiUsage.count({
          where: { siteId: s.siteId, operation: 'assist-learn' },
        }),
      ).toBe(0);

      // Фраза двух целей: прямого пути нет — модель из бюджета ОБУЧЕНИЯ.
      const d1 = await maps.draft(who, s.siteId);
      await maps.patch(
        who,
        s.siteId,
        {
          expectedRevision: d1.revision,
          ops: [
            {
              op: 'upsert-target',
              target: {
                key: 'rating',
                scope: 'template',
                templateId: tp,
                descriptor: {
                  tag: 'button',
                  role: 'tab',
                  text: 'Рейтинг',
                  assistId: 'rating',
                  unique: true,
                },
                names: { uk: 'Рейтинг' },
                synonyms: { uk: [{ text: 'Відгуки', origin: 'owner' }] },
              },
            },
          ],
        },
        'tma',
      );
      const held = await maps.buildVersion(
        { accountId: s.accountId, memberId: who.memberId },
        s.siteId,
        'tma',
      );
      modelReply = JSON.stringify({
        command: true,
        steps: [{ kind: 'click', target: 'e1' }],
      });
      const r2 = (await handlers.get('voice-map-check')!.onDone!(
        { ...job, refId: `v${held.number}` },
        {
          pages: [page('/product/2', true)],
        } as never,
      )) as WorkerCheckReport;
      const by2 = Object.fromEntries(
        r2.dryRun!.commands.map((c) => [`${c.key}:${c.kind}`, c.outcome]),
      );
      expect(by2['reviews:name']).toBe('ok_model');
      expect(by2['rating:synonym']).toBe('wrong');
      expect(r2.dryRun!.modelCalls).toBe(2);
      expect(modelCalls[0]).toContain('<voice_map');
      const used = await st.owner.siteAiUsage.findMany({
        where: { siteId: s.siteId, operation: 'assist-learn' },
      });
      expect(used).toHaveLength(2);
      // Аудит P3: резервы вызовов поправлены на факт токенов.
      const ws = await st.owner.assistLearningSpend.findFirstOrThrow({
        where: { siteId: s.siteId },
      });
      expect(Number(ws.spentMicroUsd)).toBe(
        used.reduce((a, u) => a + u.costMicroUsd, 0),
      );
      // Бюджета обучения нет — команды «без модели», прогон не падает.
      await st.owner.assistLearningSpend.updateMany({
        where: { siteId: s.siteId },
        data: { spentMicroUsd: BigInt(10_000_000_000) },
      });
      modelCalls.length = 0;
      const r3 = (await handlers.get('voice-map-check')!.onDone!(
        { ...job, refId: `v${held.number}` },
        {
          pages: [page('/product/2', true)],
        } as never,
      )) as WorkerCheckReport;
      expect(modelCalls).toHaveLength(0);
      expect(
        r3.dryRun!.commands.find(
          (c) => c.key === 'reviews' && c.kind === 'name',
        )!.outcome,
      ).toBe('model_failed');
    });
  });
});
