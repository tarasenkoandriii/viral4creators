/**
 * №113 (заход 10) — подсказки панели редактора голосовой карты:
 *  - чистая часть (`editor-assist.ts`): отбор ИИ-синонимов (ПД, ссылки,
 *    служебные слова, свои/чужие фразы, отклонённые, ≤ 5 и не сверх 20),
 *    промпт без ПД, «просили, не нашли» и карточки «Предложения»;
 *  - маршруты на реальном Postgres (основная роль с тенантом; модель —
 *    подделка): `suggest-synonyms` — 401 без сессии, 409 до трат, «никогда»
 *    — 422 без модели, бюджет обучения ДО модели (402), частота (429),
 *    запись `suggested` в черновик (в версию не идёт), учёт `assist-learn`;
 *    `misses`/`suggestions`/`suggestions/mute` — шаблон страницы, разные
 *    посетители, ПД и мастер не попадают, отклонённое — 30 дней, чужой сайт
 *    не виден.
 */
import { HttpException } from '@nestjs/common';
import { setPlan } from '../../assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../assist-site-chat/testing/chat-stack.testing';
import {
  versionContent,
  type VoiceMapTarget,
} from '../../assist-ui-core/voice-map';
import { LearningBudget } from '../../site-ai/learning-budget';
import { GeminiText } from '../../site-ai/text-model';
import type { AccountMembership } from '../../site-core/account/roles';
import { SitesDb } from '../../../prisma/sites-db.service';
import { MapMissesService } from '../map-misses';
import { VoiceMapService } from '../voice-map.service';
import {
  aiMuteId,
  askedNotFound,
  buildSynonymPrompt,
  EDITOR_ASSIST,
  filterSynonyms,
  parseSynonymReply,
  suggestionCards,
  suggestionId,
  type AskedRow,
} from './editor-assist';
import { EditorAssistController } from './editor-assist.controller';
import { EditorAssistService } from './editor-assist.service';
import { EditorSessionService } from './editor-session.service';

jest.setTimeout(300_000);

const DAY = 86_400_000;

function target(over: Partial<VoiceMapTarget> = {}): VoiceMapTarget {
  return {
    key: 'gift',
    scope: 'site',
    templateId: null,
    pagePath: null,
    descriptor: {
      tag: 'button',
      role: 'button',
      text: 'Подарункова упаковка',
      hiddenLabel: null,
      assistId: 'gift-wrap',
      testId: null,
      elId: null,
      hrefPath: null,
      hrefHost: null,
      offHost: false,
      heading: null,
      landmark: null,
      formName: null,
      inputType: null,
      submit: false,
      inForm: false,
      pd: false,
      toggle: false,
      gesture: null,
      neverAttr: false,
      confirmZone: false,
      clickableDiv: false,
      editable: false,
      closedShadow: false,
      unique: true,
      css: null,
    },
    stability: 'strong',
    samples: [],
    names: { uk: 'Подарунок' },
    synonyms: { uk: [{ text: 'упакуй', origin: 'owner' }] },
    semanticType: null,
    riskComputed: 'now',
    riskReason: 'default',
    riskOwner: null,
    denylisted: false,
    control: false,
    undo: null,
    origin: 'owner',
    status: 'active',
    ...over,
  } as VoiceMapTarget;
}

describe('№113 — чистая часть подсказок редактора', () => {
  it('отбор ИИ-синонимов: ПД, ссылка, разметка, служебные, свои, чужие, отклонённые, дубли, ≤ 5 и не сверх 20', () => {
    const t = target();
    const proposed = {
      uk: [
        'подарункова',
        'упакуй', // своя
        'Упакуй', // своя (норма)
        'подзвони +380671234567', // ПД
        'відкрий https://evil.example', // ссылка
        '<b>подарок</b>', // разметка
        'так', // служебное
        'в кошик', // фраза другой цели
        'загорни', // отклонена владельцем
        'подарункова', // дубль
        'обгортка',
        'упаковка подарунка',
        'святкова упаковка',
        'в подарунок',
        'зроби подарунок', // шестая годная — сверх 5
      ],
      en: ['gift wrap'],
    };
    const r = filterSynonyms(proposed, t, {
      taken: new Set(['uk:в кошик']),
      muted: new Set([aiMuteId('gift', 'uk', 'Загорни')]),
    });
    expect(r.kept).toEqual({
      uk: [
        'подарункова',
        'обгортка',
        'упаковка подарунка',
        'святкова упаковка',
        'в подарунок',
      ],
      en: ['gift wrap'],
    });
    expect(r.dropped).toEqual({
      own: 2,
      text: 3,
      service_word: 1,
      phrase_conflict: 1,
      muted: 1,
      duplicate: 1,
      overflow: 1,
    });
    // У цели уже 19 синонимов языка — место только под один (лимит 20).
    const full = target({
      synonyms: {
        uk: Array.from({ length: 19 }, (_, i) => ({
          text: `синонім ${String.fromCharCode(1072 + i)}`,
          origin: 'owner' as const,
        })),
      },
    });
    expect(
      filterSynonyms({ uk: ['перше', 'друге'] }, full, {
        taken: new Set(),
        muted: new Set(),
      }).kept,
    ).toEqual({ uk: ['перше'] });
  });

  it('промпт: данные цели — блоком <element>, ПД видимого текста замаскирована; мусор ответа — пусто', () => {
    const t = target({
      descriptor: {
        ...target().descriptor,
        text: 'Замовити дзвінок на +380 67 123 45 67',
      },
    });
    const p = buildSynonymPrompt(t, ['uk', 'en'], '/product/*');
    expect(p.system).toContain('DATA');
    expect(p.user.startsWith('<element>')).toBe(true);
    expect(p.user).not.toMatch(/123 45 67|380/);
    expect(p.user).toContain('page: /product/*');
    expect(parseSynonymReply('not json', ['uk'])).toEqual({});
    expect(parseSynonymReply('{"uk": "рядок"}', ['uk'])).toEqual({});
    expect(
      parseSynonymReply('```json\n{"uk": ["а", 1, "б"], "de": ["x"]}\n```', [
        'uk',
      ]),
    ).toEqual({ uk: ['а', 'б'] });
  });

  it('«просили, не нашли»: свёртка по телу команды и языку, разные посетители; ПД и уже привязанное — нет', () => {
    const at = new Date('2026-10-08T10:00:00Z');
    const row = (
      visitorId: string,
      utterance: string,
      over: Partial<AskedRow> = {},
    ): AskedRow => ({
      planId: `p-${visitorId}-${utterance}`,
      visitorId,
      utterance,
      lang: 'uk',
      page: '/product/1',
      key: null,
      at,
      ...over,
    });
    const items = askedNotFound(
      [
        row('a', 'відкрий таблицю розмірів'),
        row('b', 'Таблицю розмірів!'),
        row('b', 'натисни таблицю розмірів'),
        row('c', 'покажи таблицю розмірів', { key: 'sizes' }),
        row('a', 'подзвони мені на 0671234567'),
        row('d', 'відкрий подарунок'),
        row('e', 'доставка', { lang: 'en' }),
      ],
      new Set(['uk:подарунок']),
    );
    expect(
      items.map((i) => [i.phrase, i.lang, i.count, i.visitors, i.key]),
    ).toEqual([
      ['таблицю розмірів', 'uk', 4, 3, 'sizes'],
      ['доставка', 'en', 1, 1, null],
    ]);
    expect(items[0].id).toBe(suggestionId('asked', 'uk', 'таблицю розмірів'));
    expect(JSON.stringify(items)).not.toMatch(/067|подарунок/);
  });

  it('карточки «Предложения»: ≥ 3 посетителей, ≥ 3 «нажмите сами»; отклонённые — нет', () => {
    const asked = [
      {
        id: 'a'.repeat(24),
        phrase: 'таблицю розмірів',
        lang: 'uk',
        count: 4,
        visitors: 3,
        key: null,
        last: '',
      },
      {
        id: 'b'.repeat(24),
        phrase: 'доставка',
        lang: 'uk',
        count: 5,
        visitors: 2,
        key: null,
        last: '',
      },
    ];
    const misses = [
      {
        key: 'cart',
        page: null,
        self: 3,
        notFound: 0,
        wrong: 0,
        missed: 0,
        done: 0,
        last: '',
      },
      {
        key: 'menu',
        page: null,
        self: 2,
        notFound: 9,
        wrong: 0,
        missed: 0,
        done: 0,
        last: '',
      },
    ];
    expect(
      suggestionCards(asked, misses, new Set()).map((c) => [c.kind, c.id]),
    ).toEqual([
      ['asked', 'a'.repeat(24)],
      ['self', suggestionId('self', 'cart')],
    ]);
    expect(
      suggestionCards(asked, misses, new Set([suggestionId('self', 'cart')])),
    ).toHaveLength(1);
    expect(EDITOR_ASSIST.minVisitors).toBe(3);
  });
});

describeDb('№113 — маршруты подсказок панели редактора (Postgres)', () => {
  const st = new ChatStack();
  let db: SitesDb;
  let maps: VoiceMapService;
  let editor: EditorSessionService;
  let assist: EditorAssistService;
  let ctrl: EditorAssistController;
  let budget: LearningBudget;
  let clock = Date.now();
  const calls: string[] = [];
  let reply = '{}';
  /** Аудит Ж: действие «во время ответа модели» (правка черновика). */
  let during: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    await st.init();
    db = new SitesDb(st.owner);
    maps = new VoiceMapService(db);
    maps.now = () => new Date(clock);
    editor = new EditorSessionService(db, maps);
    editor.now = () => new Date(clock);
    budget = new LearningBudget(db);
    const text = new GeminiText().useClient({
      models: {
        generateContent: async (req: {
          contents: Array<{ parts: Array<{ text: string }> }>;
        }) => {
          calls.push(req.contents[0].parts[0].text);
          if (during) await during();
          return {
            text: reply,
            usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 60 },
          };
        },
      },
    } as never);
    const misses = new MapMissesService(db);
    misses.now = () => new Date(clock);
    assist = new EditorAssistService(db, maps, misses, text, budget, st.usage);
    assist.now = () => new Date(clock);
    ctrl = new EditorAssistController(editor, assist);
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    clock = Date.now();
    calls.length = 0;
    reply = '{}';
    during = null;
  });

  async function vcSite(): Promise<ChatSite> {
    const s = await st.site({ name: 'Магазин', members: [] });
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

  async function member(s: ChatSite): Promise<AccountMembership> {
    const m = await st.owner.siteAccountMember.findFirstOrThrow({
      where: { accountId: s.accountId, role: 'owner' },
      orderBy: { createdAt: 'asc' },
    });
    return {
      accountId: s.accountId,
      memberId: m.id,
      telegramId: m.telegramId,
      role: 'owner',
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

  async function code(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (e instanceof HttpException) {
        const r = e.getResponse() as { code: string; scope?: string };
        return { status: e.getStatus(), code: r.code, scope: r.scope };
      }
      throw e;
    }
    throw new Error('ожидался отказ');
  }

  const gift = {
    tag: 'button',
    role: 'button',
    text: 'Подарункова упаковка',
    assistId: 'gift-wrap',
    unique: true,
  };
  const cart = {
    tag: 'button',
    role: 'button',
    text: 'В кошик',
    assistId: 'add-to-cart',
    unique: true,
  };

  async function seedMap(s: ChatSite, who: AccountMembership) {
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
              name: 'Товари',
              pathPattern: '/product/*',
              samplePages: ['/product/1'],
            },
          },
        ],
      },
      'tma',
    );
    const d1 = await maps.draft(who, s.siteId);
    const tpl = d1.content.templates[0];
    await maps.patch(
      who,
      s.siteId,
      {
        expectedRevision: d1.revision,
        ops: [
          {
            op: 'upsert-target',
            target: {
              key: 'gift',
              scope: 'template',
              templateId: tpl.id,
              descriptor: gift,
              names: { uk: 'Подарунок' },
            },
          },
          {
            op: 'upsert-target',
            target: {
              key: 'cart',
              scope: 'site',
              descriptor: cart,
              names: { uk: 'В кошик' },
            },
          },
          {
            op: 'upsert-target',
            target: {
              key: 'danger',
              scope: 'site',
              descriptor: { ...cart, text: 'Видалити', assistId: 'del' },
              denylisted: true,
            },
          },
        ],
      },
      'tma',
    );
    return (await maps.draft(who, s.siteId)).revision;
  }

  it('suggest-synonyms: 401 без сессии; 409 до модели; «никогда» — 422 без модели; запись `suggested` (в версию не идёт) и учёт assist-learn', async () => {
    const s = await vcSite();
    const { who, s: ses } = await session(s);
    const rev = await seedMap(s, who);
    expect(
      await code(
        ctrl.suggestSynonyms(undefined, { expectedRevision: rev, key: 'gift' }),
      ),
    ).toMatchObject({ status: 401, code: 'EDITOR_SESSION_EXPIRED' });
    expect(
      await code(
        ctrl.suggestSynonyms(ses, { expectedRevision: rev + 5, key: 'gift' }),
      ),
    ).toMatchObject({ status: 409, code: 'VOICE_MAP_CONFLICT' });
    expect(
      await code(
        ctrl.suggestSynonyms(ses, { expectedRevision: rev, key: 'danger' }),
      ),
    ).toMatchObject({ status: 422, code: 'EDITOR_SUGGEST_NEVER' });
    expect(calls).toHaveLength(0);

    reply = JSON.stringify({
      uk: ['упаковка', 'запакуй подарунок', 'в кошик', 'набери +380671234567'],
      en: ['gift wrap'],
    });
    const r = await ctrl.suggestSynonyms(ses, {
      expectedRevision: rev,
      key: 'gift',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('<element>');
    expect(r).toMatchObject({
      key: 'gift',
      revision: rev + 1,
      kept: { uk: 2 },
      dropped: { phrase_conflict: 1, text: 1 },
    });
    const d = await maps.draft(who, s.siteId);
    const t = d.content.targets.find((x) => x.key === 'gift')!;
    expect(t.synonyms.uk).toEqual([
      { text: 'упаковка', origin: 'suggested' },
      { text: 'запакуй подарунок', origin: 'suggested' },
    ]);
    // Р-33: предложения ИИ в версию не попадают.
    const v = versionContent(d.content);
    expect(v.targets.find((x) => x.key === 'gift')!.synonyms.uk ?? []).toEqual(
      [],
    );
    const usage = await st.owner.siteAiUsage.findMany({
      where: { siteId: s.siteId, operation: 'assist-learn' },
    });
    expect(usage).toHaveLength(1);
    // Журнал — без текста фраз.
    const changes = await st.owner.assistSiteVoiceMapChange.findMany({
      where: { siteId: s.siteId, source: 'suggestion' },
    });
    expect(changes.map((c) => (c.op as { op: string }).op).sort()).toEqual([
      'ai-synonyms',
      'update-target',
    ]);
    expect(JSON.stringify(changes)).not.toContain('упаковка');
  });

  it('suggest-synonyms: бюджет обучения исчерпан — 402 ДО модели; частота — раз в минуту на цель и 30 в сутки на сайт', async () => {
    const s = await vcSite();
    const { who, s: ses } = await session(s);
    const rev = await seedMap(s, who);
    const period = new Date().toISOString().slice(0, 7);
    await st.owner.assistLearningSpend.upsert({
      where: { siteId_period: { siteId: s.siteId, period } },
      create: {
        accountId: s.accountId,
        siteId: s.siteId,
        period,
        spentMicroUsd: BigInt(10) ** BigInt(15),
      },
      update: { spentMicroUsd: BigInt(10) ** BigInt(15) },
    });
    expect(
      await code(
        ctrl.suggestSynonyms(ses, { expectedRevision: rev, key: 'gift' }),
      ),
    ).toMatchObject({ status: 402, code: 'EDITOR_SUGGEST_BUDGET' });
    expect(calls).toHaveLength(0);
    await st.owner.assistLearningSpend.updateMany({
      where: { siteId: s.siteId, period },
      data: { spentMicroUsd: BigInt(0) },
    });
    // Бюджет вернулся: отказ 402 частоту не тратил.
    reply = '{"uk": []}';
    await ctrl.suggestSynonyms(ses, { expectedRevision: rev, key: 'gift' });
    expect(calls).toHaveLength(1);
    expect(
      await code(
        ctrl.suggestSynonyms(ses, { expectedRevision: rev, key: 'gift' }),
      ),
    ).toMatchObject({
      status: 429,
      code: 'EDITOR_SUGGEST_LIMIT',
      scope: 'target',
    });
    expect(calls).toHaveLength(1);
    // Другая цель — можно; через минуту — снова можно.
    await ctrl.suggestSynonyms(ses, { expectedRevision: rev, key: 'cart' });
    clock += 61_000;
    await ctrl.suggestSynonyms(ses, { expectedRevision: rev, key: 'gift' });
    expect(calls).toHaveLength(3);
    // Сутки сайта: 30 вызовов — дальше 429 (сайт).
    await st.owner.assistSiteVoiceMapChange.createMany({
      data: Array.from({ length: 27 }, () => ({
        accountId: s.accountId,
        siteId: s.siteId,
        revision: rev,
        actor: who.memberId,
        source: 'suggestion',
        op: { op: 'ai-synonyms', key: 'other' },
        createdAt: new Date(clock - 1_000),
      })),
    });
    clock += 61_000;
    expect(
      await code(
        ctrl.suggestSynonyms(ses, { expectedRevision: rev, key: 'gift' }),
      ),
    ).toMatchObject({ status: 429, scope: 'site' });
    expect(calls).toHaveLength(3);
  });

  it('«Промахи» и «Предложения»: шаблон страницы, разные посетители; ПД, мастер и чужой шаблон — нет; «не предлагать» — 30 дней; чужой сайт не виден', async () => {
    const s = await vcSite();
    const { who, s: ses } = await session(s);
    await seedMap(s, who);
    const conv = await st.owner.assistSiteConversation.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId: 'v-1',
        ipHash: 'ip',
        parentOrigin: s.origin,
        lastMessageAt: new Date(),
      },
    });
    const now = new Date(clock);
    const plan = async (
      visitorId: string,
      utteranceMasked: string,
      page: string,
      log: Record<string, unknown> = {},
      over: Record<string, unknown> = {},
    ) => {
      const p = await st.owner.assistSiteUiPlan.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          conversationId: conv.id,
          visitorId,
          utteranceMasked,
          source: 'voice',
          lang: 'uk',
          pageUrl: s.url(page),
          steps: [],
          status: 'failed',
          needsConfirm: false,
          confirmBefore: now,
          expiresAt: now,
          ...over,
        },
      });
      await st.owner.assistSiteUiActionLog.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          planId: p.id,
          stepIndex: 0,
          action: 'plan',
          risk: 'auto',
          result: 'skipped',
          url: s.url(page),
          ...log,
        },
      });
      return p;
    };
    await plan('v-1', 'відкрий таблицю розмірів', '/product/1');
    await plan('v-2', 'таблицю розмірів', '/product/2');
    await plan('v-3', 'покажи таблицю розмірів', '/product/7', {
      reason: 'no_target',
    });
    await plan('v-4', 'подзвоніть на 0671234567', '/product/1');
    await plan('v-5', 'відкрий блог', '/blog/1');
    await plan('v-6', 'відкрий кошик', '/product/1', {
      reason: 'danger',
    });
    await plan('v-7', 'таблицю розмірів', '/product/1', {}, { dryRun: true });
    // «Нажмите сами» ×3 по цели `cart`.
    for (const v of ['a', 'b', 'c']) {
      const p = await plan(`s-${v}`, 'в кошик', '/product/1', {
        action: 'click',
        result: 'manual',
        reason: 'not_trusted',
        mapKey: 'cart',
      });
      expect(p.id).toBeTruthy();
    }
    const m = await ctrl.misses(ses, '/product/3');
    expect(m.path).toBe('/product/3');
    expect(m.items).toEqual([
      expect.objectContaining({ key: 'cart', self: 3 }),
    ]);
    expect(m.asked.map((a) => [a.phrase, a.visitors])).toEqual([
      ['таблицю розмірів', 3],
    ]);
    expect(JSON.stringify(m)).not.toMatch(/067|блог|кошик/);
    const sg = await ctrl.suggestions(ses, '/product/3');
    expect(sg.items.map((c) => c.kind)).toEqual(['asked', 'self']);
    const askedId = sg.items[0].id;
    await ctrl.mute(ses, { id: askedId });
    expect(
      (await ctrl.suggestions(ses, '/product/3')).items.map((c) => c.kind),
    ).toEqual(['self']);
    expect(await code(ctrl.mute(ses, { id: 'не-хеш' }))).toMatchObject({
      status: 400,
    });
    expect(await code(ctrl.misses(ses, 'javascript:1'))).toMatchObject({
      status: 400,
    });
    // Отклонённый ИИ-синоним цели — тем же маршрутом, по ключу/языку/фразе.
    expect(
      await ctrl.mute(ses, { key: 'gift', lang: 'uk', text: 'Загорни' }),
    ).toEqual({ id: aiMuteId('gift', 'uk', 'загорни') });
    // …и ИИ его больше не предлагает; через 31 день — снова может.
    const ed = await editor.resolve(ses);
    const rev = (await maps.draft(who, s.siteId)).revision;
    reply = '{"uk": ["загорни"]}';
    expect(
      await assist.suggestSynonyms(ed, { expectedRevision: rev, key: 'gift' }),
    ).toMatchObject({ kept: { uk: 0 }, dropped: { muted: 1 } });
    clock += 31 * DAY;
    expect(
      await assist.suggestSynonyms(ed, { expectedRevision: rev, key: 'gift' }),
    ).toMatchObject({ kept: { uk: 1 } });
    clock -= 31 * DAY;
    // Чужой сайт: своя сессия — своих данных нет.
    const other = await vcSite();
    const o = await session(other);
    await seedMap(other, o.who);
    const om = await ctrl.misses(o.s, '/product/3');
    expect(om.items).toEqual([]);
    expect(om.asked).toEqual([]);
  });

  it('аудит Ж (P3-1): 5 параллельных запросов одной цели — модель зовётся один раз (замок сайта), остальные 429', async () => {
    const s = await vcSite();
    const { who, s: ses } = await session(s);
    const rev = await seedMap(s, who);
    reply = '{"uk": []}';
    const res = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        ctrl.suggestSynonyms(ses, { expectedRevision: rev, key: 'gift' }),
      ),
    );
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const rows = await st.owner.assistSiteVoiceMapChange.findMany({
      where: { siteId: s.siteId, source: 'suggestion' },
    });
    expect(rows).toHaveLength(1);
  });

  it('аудит Ж (P3-2): черновик поменяли, пока модель отвечала, — оплаченные синонимы ложатся на свежую ревизию', async () => {
    const s = await vcSite();
    const { who, s: ses } = await session(s);
    const rev = await seedMap(s, who);
    reply = '{"uk": ["упаковка"]}';
    during = async () => {
      during = null;
      await maps.patch(
        who,
        s.siteId,
        {
          expectedRevision: rev,
          ops: [
            {
              op: 'upsert-target',
              target: { key: 'gift', names: { uk: 'Подарунок', en: 'Gift' } },
            },
          ],
        },
        'tma',
      );
    };
    const r = await ctrl.suggestSynonyms(ses, {
      expectedRevision: rev,
      key: 'gift',
    });
    expect(r).toMatchObject({ revision: rev + 2, kept: { uk: 1 } });
    const t = (await maps.draft(who, s.siteId)).content.targets.find(
      (x) => x.key === 'gift',
    )!;
    expect(t.names).toEqual({ uk: 'Подарунок', en: 'Gift' });
    expect(t.synonyms.uk).toEqual([{ text: 'упаковка', origin: 'suggested' }]);
  });

  it('аудит Ж (P3-3, P3-4): учёт расхода упал — резерв не возвращается целиком (оценка по токенам); «не предлагать» — не больше 200 в сутки', async () => {
    const s = await vcSite();
    const { who, s: ses } = await session(s);
    const rev = await seedMap(s, who);
    reply = '{"uk": []}';
    const spy = jest
      .spyOn(st.usage, 'record')
      .mockRejectedValueOnce(new Error('учёт недоступен'));
    try {
      await expect(
        ctrl.suggestSynonyms(ses, { expectedRevision: rev, key: 'gift' }),
      ).rejects.toThrow('учёт недоступен');
    } finally {
      spy.mockRestore();
    }
    const spend = await st.owner.assistLearningSpend.findMany({
      where: { siteId: s.siteId },
    });
    expect(
      spend.reduce((a, x) => a + Number(x.spentMicroUsd), 0),
    ).toBeGreaterThan(0);
    await st.owner.assistSiteVoiceMapChange.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({
        accountId: s.accountId,
        siteId: s.siteId,
        revision: rev,
        actor: who.memberId,
        source: 'suggestion',
        op: { op: 'suggestion-mute', id: String(i).padStart(24, '0') },
      })),
    });
    expect(await code(ctrl.mute(ses, { id: 'f'.repeat(24) }))).toMatchObject({
      status: 429,
      code: 'EDITOR_SUGGEST_LIMIT',
      scope: 'mute',
    });
  });
});
