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
  lowConfTermItems,
  parseSynonymReply,
  suggestionCards,
  suggestionId,
  termId,
  wrongAsked,
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

  it('заход 11: «не туда» — свёртка по цели, телу команды и языку; ПД — нет; ≤ 5 фраз на цель', () => {
    const w = (key: string, v: string, u: string, lang = 'uk') => ({
      key,
      planId: `p-${v}-${u}`,
      visitorId: v,
      ipHash: `ip-${v}`,
      utterance: u,
      lang,
    });
    const items = wrongAsked([
      w('footer', 'v1', 'відкрий доставку'),
      w('footer', 'v2', 'доставку'),
      w('footer', 'v2', 'покажи доставку'),
      w('footer', 'v3', 'подзвоніть 0671234567'),
      w('footer', 'v4', 'доставку', 'ru'),
      ...['а1', 'а2', 'а3', 'а4', 'а5', 'а6'].map((x) =>
        w('menu', 'v9', `відкрий розділ ${x}`),
      ),
    ]);
    const footer = items.filter((i) => i.key === 'footer');
    expect(footer.map((i) => [i.phrase, i.lang, i.visitors, i.count])).toEqual([
      ['доставку', 'uk', 2, 3],
      ['доставку', 'ru', 1, 1],
    ]);
    expect(footer[0].id).toBe(
      suggestionId('wrong', 'footer', 'uk', 'доставку'),
    );
    expect(items.filter((i) => i.key === 'menu')).toHaveLength(
      EDITOR_ASSIST.wrongPerKey,
    );
    expect(JSON.stringify(items)).not.toContain('067');
  });

  it('заход 11: термины распознавания — разные посетители, частая подпись, известное карте/ПД/подмена нормы — нет', () => {
    const r = (
      word: string,
      visitorHash: string,
      norm = word.toLowerCase(),
    ) => ({
      norm,
      word,
      visitorHash,
      ipHash: `ip-${visitorHash}`,
    });
    const items = lowConfTermItems(
      [
        r('Ксіомі', 'h1'),
        r('ксіомі', 'h2'),
        r('Ксіомі', 'h3'),
        r('Ксіомі', 'h3'),
        r('Нова Пошта', 'h1'),
        r('Делівері', 'h1'),
        r('Делівері', 'h2'),
        r('пишіть a@b.ua', 'h1', 'пишіть a b ua'),
        r('Підробка', 'h1', 'інша норма'),
      ],
      new Set(['нова пошта']),
    );
    expect(items.map((i) => [i.phrase, i.visitors, i.count])).toEqual([
      ['Ксіомі', 3, 4],
      ['Делівері', 2, 2],
    ]);
    expect(items[0].id).toBe(termId('ксіомі'));
    // Карточки: «не туда» и термин — от 2 посетителей; отклонённое — нет.
    const wrong = [
      {
        id: 'd'.repeat(24),
        key: 'footer',
        phrase: 'доставку',
        lang: 'uk',
        count: 2,
        visitors: 2,
      },
      {
        id: 'e'.repeat(24),
        key: 'footer',
        phrase: 'оплату',
        lang: 'uk',
        count: 1,
        visitors: 1,
      },
    ];
    expect(
      suggestionCards([], [], new Set([termId('делівері')]), {
        wrong,
        terms: items,
      }).map((c) => [c.kind, 'phrase' in c ? c.phrase : '']),
    ).toEqual([
      ['wrong', 'доставку'],
      ['term', 'Ксіомі'],
    ]);
  });

  it('аудит P3-2: «разных посетителей» — min(посетители, IP): новые сессии одного IP порог не набирают', () => {
    const t = (visitorHash: string, ipHash: string) => ({
      norm: 'ксіомі',
      word: 'Ксіомі',
      visitorHash,
      ipHash,
    });
    expect(
      lowConfTermItems(
        [t('h1', 'ip'), t('h2', 'ip'), t('h3', 'ip')],
        new Set(),
      )[0].visitors,
    ).toBe(1);
    expect(
      lowConfTermItems([t('h1', 'ip1'), t('h2', 'ip2')], new Set())[0].visitors,
    ).toBe(2);
    const w = (visitorId: string, ipHash: string | null) => ({
      key: 'footer',
      planId: `p-${visitorId}`,
      visitorId,
      ipHash,
      utterance: 'відкрий доставку',
      lang: 'uk',
    });
    expect(wrongAsked([w('v1', 'ip'), w('v2', 'ip')])[0].visitors).toBe(1);
    expect(wrongAsked([w('v1', null), w('v2', null)])[0].visitors).toBe(2);
  });

  it('аудит P3-8: «не предлагать» — до среза: 20 отклонённых терминов не прячут 21-й', () => {
    const rows = Array.from({ length: 21 }, (_, i) => {
      const word = `термін${String.fromCharCode(1072 + i)}`;
      return [1, 2].map((v) => ({
        norm: word,
        word,
        visitorHash: `h${v}`,
        ipHash: `ip${v}`,
      }));
    }).flat();
    const all = lowConfTermItems(rows, new Set());
    expect(all).toHaveLength(EDITOR_ASSIST.termItems);
    const muted = new Set(all.map((x) => x.id));
    const rest = lowConfTermItems(rows, new Set(), muted);
    expect(rest.map((x) => x.phrase)).toEqual([
      `термін${String.fromCharCode(1072 + 20)}`,
    ]);
    // То же у «не туда» и «просили».
    const wr = Array.from({ length: 31 }, (_, i) => ({
      key: `k${i}`,
      planId: `p${i}`,
      visitorId: `v${i}`,
      ipHash: `ip${i}`,
      utterance: 'відкрий доставку',
      lang: 'uk',
    }));
    const w30 = wrongAsked(wr);
    expect(w30).toHaveLength(EDITOR_ASSIST.wrongItems);
    expect(wrongAsked(wr, new Set(w30.map((x) => x.id)))).toHaveLength(1);
    const ar = Array.from({ length: 21 }, (_, i) => ({
      planId: `p${i}`,
      visitorId: `v${i}`,
      utterance: `відкрий розділ ${String.fromCharCode(1072 + i)}${String.fromCharCode(1072 + i)}`,
      lang: 'uk',
      page: '/',
      key: null,
      at: new Date(0),
    }));
    const a20 = askedNotFound(ar, new Set());
    expect(a20).toHaveLength(EDITOR_ASSIST.asked);
    expect(
      askedNotFound(ar, new Set(), new Set(a20.map((x) => x.id))),
    ).toHaveLength(1);
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
  it('заход 11: «Промахи» — тепловые значки (и цели только с «выполнено») и «не туда» с командами; «Пропозиції» — карточки wrong/term; термин — в черновик (409/400, повтор — нет)', async () => {
    const s = await vcSite();
    const { who, s: ses } = await session(s);
    await seedMap(s, who);
    const now = new Date(clock);
    const at = (ms: number) => new Date(clock - ms);
    // Диалог на посетителя — свой хеш IP (порог «разных» — и по IP).
    const mkPlan = async (visitorId: string, utteranceMasked: string) => {
      const conv = await st.owner.assistSiteConversation.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          visitorId,
          ipHash: `ip-${visitorId}`,
          parentOrigin: s.origin,
          lastMessageAt: new Date(),
        },
      });
      return st.owner.assistSiteUiPlan.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          conversationId: conv.id,
          visitorId,
          utteranceMasked,
          source: 'voice',
          lang: 'uk',
          pageUrl: s.url('/product/1'),
          steps: [],
          status: 'stopped',
          needsConfirm: false,
          confirmBefore: now,
          expiresAt: now,
        },
      });
    };
    const log = (planId: string, data: Record<string, unknown>) =>
      st.owner.assistSiteUiActionLog.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          planId,
          stepIndex: 0,
          action: 'click',
          risk: 'auto',
          result: 'done',
          url: s.url('/product/1'),
          ...data,
        },
      });
    // «Не туда»: «доставку» → цель `cart`, человек остановил через 2 с (2 посетителя).
    for (const v of ['w-1', 'w-2']) {
      const p = await mkPlan(v, 'відкрий доставку');
      await log(p.id, { mapKey: 'cart', createdAt: at(10_000) });
      await log(p.id, {
        action: 'stop',
        reason: 'click',
        stepIndex: 1,
        createdAt: at(8_000),
      });
    }
    // Мастер Т-2 (сухой прогон) — не в «не туда».
    const dry = await mkPlan('w-9', 'відкрий оплату');
    await st.owner.assistSiteUiPlan.update({
      where: { id: dry.id },
      data: { dryRun: true },
    });
    await log(dry.id, { mapKey: 'cart', createdAt: at(6_000) });
    await log(dry.id, {
      action: 'stop',
      reason: 'voice',
      createdAt: at(5_000),
    });
    // Аудит P3-9 (г): план ДВУХ целей («додай подарунок і в кошик») —
    // «не туда» считается, но фраза команды целиком в «перепривязать» не идёт.
    const multi = await mkPlan('w-5', 'додай подарунок і в кошик');
    await log(multi.id, { mapKey: 'gift', createdAt: at(7_000) });
    await log(multi.id, { mapKey: 'cart', createdAt: at(6_500) });
    await log(multi.id, {
      action: 'stop',
      reason: 'esc',
      createdAt: at(6_000),
    });
    // `gift` — только «выполнено»: в списке промахов нет, в тепловых значках — есть.
    const g = await mkPlan('w-3', 'подарунок');
    await log(g.id, { mapKey: 'gift', createdAt: at(4_000) });
    const m = await ctrl.misses(ses, '/product/3');
    expect(m.items.map((i) => [i.key, i.wrong])).toEqual([['cart', 4]]);
    expect(m.heat.map((i) => [i.key, i.done, i.wrong]).sort()).toEqual([
      ['cart', 4, 4],
      ['gift', 2, 0],
    ]);
    expect(m.wrong.map((w) => [w.key, w.phrase, w.visitors])).toEqual([
      ['cart', 'доставку', 2],
    ]);
    expect(JSON.stringify(m.wrong)).not.toContain('оплат');

    // Термины распознавания: 2 посетителя — карточка; известное карте и 1 посетитель — нет.
    await st.owner.assistSiteSttLowTerm.createMany({
      data: [
        ['ксіомі', 'Ксіомі', 'a'],
        ['ксіомі', 'Ксіомі', 'b'],
        ['подарунок', 'Подарунок', 'a'],
        ['подарунок', 'Подарунок', 'b'],
        ['делівері', 'Делівері', 'a'],
      ].map(([norm, word, h]) => ({
        accountId: s.accountId,
        siteId: s.siteId,
        day: now.toISOString().slice(0, 10),
        norm,
        word,
        visitorHash: h.repeat(32),
        ipHash: `ip-${h}`,
      })),
    });
    const sg = await ctrl.suggestions(ses, '/product/3');
    expect(
      sg.items.map((c) => [c.kind, 'phrase' in c ? c.phrase : '']),
    ).toEqual([
      ['wrong', 'доставку'],
      ['term', 'Ксіомі'],
    ]);
    const term = sg.items.find((c) => c.kind === 'term')!;
    const rev = (await maps.draft(who, s.siteId)).revision;
    expect(
      await code(
        ctrl.acceptTerm(ses, { expectedRevision: rev + 3, id: term.id }),
      ),
    ).toMatchObject({ status: 409, code: 'VOICE_MAP_CONFLICT' });
    expect(
      await code(
        ctrl.acceptTerm(ses, { expectedRevision: rev, id: 'f'.repeat(24) }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await code(
        ctrl.acceptTerm(undefined, { expectedRevision: rev, id: term.id }),
      ),
    ).toMatchObject({ status: 401 });
    expect(
      await ctrl.acceptTerm(ses, { expectedRevision: rev, id: term.id }),
    ).toEqual({ revision: rev + 1, term: 'Ксіомі' });
    expect((await maps.draft(who, s.siteId)).content.terms).toEqual(['Ксіомі']);
    // Аудит P3-4: термин одного посетителя (ниже порога) — не принять.
    expect(
      await code(
        ctrl.acceptTerm(ses, {
          expectedRevision: rev + 1,
          id: termId('делівері'),
        }),
      ),
    ).toMatchObject({ status: 400 });
    // Принятое — уже известно карте: карточки и повторного принятия нет.
    expect(
      await code(
        ctrl.acceptTerm(ses, { expectedRevision: rev + 1, id: term.id }),
      ),
    ).toMatchObject({ status: 400 });
    // Аудит P3-5: терминов уже 100 — 422, черновик не меняется.
    await maps.patch(
      who,
      s.siteId,
      {
        expectedRevision: rev + 1,
        ops: [
          {
            op: 'set-terms',
            // «Ксіомі» + 99: место кончилось.
            terms: [
              'Ксіомі',
              ...Array.from(
                { length: 99 },
                (_, i) =>
                  `слово${'абвгдежзик'[Math.floor(i / 10)]}${'абвгдежзик'[i % 10]}`,
              ),
            ],
          },
        ],
      },
      'tma',
    );
    await st.owner.assistSiteSttLowTerm.createMany({
      data: ['c', 'd'].map((h) => ({
        accountId: s.accountId,
        siteId: s.siteId,
        day: now.toISOString().slice(0, 10),
        norm: 'самсунг',
        word: 'Самсунг',
        visitorHash: h.repeat(32),
        ipHash: `ip-${h}`,
      })),
    });
    expect(
      await code(
        ctrl.acceptTerm(ses, {
          expectedRevision: rev + 2,
          id: termId('самсунг'),
        }),
      ),
    ).toMatchObject({ status: 422, code: 'VOICE_MAP_INVALID' });
    // Отказ — своим кодом `limit` (до операции карты), а не общим разбором.
    const lim = await ctrl
      .acceptTerm(ses, { expectedRevision: rev + 2, id: termId('самсунг') })
      .catch((e: HttpException) => e.getResponse() as Record<string, unknown>);
    expect(JSON.stringify(lim)).toContain('"code":"limit"');
    expect((await maps.draft(who, s.siteId)).content.terms).toHaveLength(100);
    // «Не туда» — «не пропонувати» по id карточки.
    const wrongId = sg.items[0].id;
    await ctrl.mute(ses, { id: wrongId });
    expect(
      (await ctrl.suggestions(ses, '/product/3')).items.map((c) => [
        c.kind,
        'phrase' in c ? c.phrase : '',
      ]),
    ).toEqual([['term', 'Самсунг']]);
    // Журнал карты — без текста термина.
    const ch = await st.owner.assistSiteVoiceMapChange.findMany({
      where: { siteId: s.siteId, source: 'editor' },
    });
    expect(ch.map((c) => (c.op as { op: string }).op)).toContain('set-terms');
    expect(JSON.stringify(ch)).not.toContain('Ксіомі');
    // Чужой сайт кандидатов не видит.
    const other = await vcSite();
    const o = await session(other);
    await seedMap(other, o.who);
    const os = await ctrl.suggestions(o.s, '/product/3');
    expect(os.items).toEqual([]);
  });
});
