/**
 * Э6-бис-хвост (3): подсказки распознаванию Soniox (`context.terms`) на
 * реальном Postgres. Публичный код «Сайта» — под ролью assist_public
 * (`st.publicDb`), Soniox — мок:
 *  - в тело транскрипции уходят имена и фразы ОПУБЛИКОВАННЫХ мемо, имена
 *    целей и термины ОПУБЛИКОВАННОЙ карты (роль читает представления —
 *    будь прав нет, терминов не было бы вовсе);
 *  - не уходят: черновики, версии на проверке, предложения ИИ (`suggested`),
 *    удалённые цели, ПД — и НИЧЕГО «Админки» (АМ-N этого же сайта);
 *  - «Админка» получает свои термины (мемо АМ-N) и не получает «Сайта».
 */
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { AdminSonioxStt } from '../../modules/assist-admin-voice/admin-stt';
import {
  adminSttTerms,
  clearAdminSttTermsCache,
} from '../../modules/assist-admin-voice/admin-stt-terms';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { SiteVoiceService } from '../../modules/assist-site-voice/public/site-voice.service';
import { SiteSonioxStt } from '../../modules/assist-site-voice/public/soniox-stt.client';
import { SiteSonioxTts } from '../../modules/assist-site-voice/public/soniox-tts.client';
import { clearSiteSttTermsCache } from '../../modules/assist-site-voice/public/stt-terms';
import {
  FakeSoniox,
  fakeRecording,
} from '../../modules/assist-site-voice/testing/fake-soniox.testing';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  readSttCounters,
  STT_COUNTER_SCOPE,
} from '../../modules/assist-site-voice-control/system/voice-monitor-store';
import {
  STT_COUNTER_SCOPE as STT_SCOPE_PUBLIC,
  sttLang,
  uiLangOf,
} from '../../modules/assist-site-voice/public/site-voice.service';
import { notHeardLangs } from '../../modules/assist-site-voice-control/monitor-rules';

jest.setTimeout(180_000);

const content = (
  name: string,
  triggers: string[] = [],
  suggested: string[] = [],
) => ({
  schema: 1,
  names: { uk: name },
  triggers: { uk: triggers },
  suggested: { uk: suggested },
  goal: { text: {}, expect: [] },
  slots: [],
  steps: [],
  view: 'any',
});

describeDb('Э6-бис-хвост (3) — подсказки распознаванию (context.terms)', () => {
  const st = new ChatStack();
  const fake = new FakeSoniox();
  let voice: SiteVoiceService;
  let adminStt: AdminSonioxStt;

  beforeAll(async () => {
    await st.init();
    const env = {
      ...st.env,
      SONIOX_API_KEY: 'sx-test',
      ASSIST_VOICE_ENABLED: 'true',
    };
    const stt = new SiteSonioxStt();
    stt.fetch = fake.fetch;
    stt.env = env;
    stt.pollDelayMs = 0;
    stt.cleanupGraceMs = 200;
    const tts = new SiteSonioxTts();
    tts.fetch = fake.fetch;
    tts.env = env;
    voice = new SiteVoiceService(st.publicDb, st.budget, st.usage, stt, tts);
    voice.env = env;
    adminStt = new AdminSonioxStt();
    adminStt.fetch = fake.fetch;
    adminStt.env = env;
    adminStt.pollDelayMs = 0;
    adminStt.cleanupGraceMs = 200;
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    fake.reset();
    clearSiteSttTermsCache();
    clearAdminSttTermsCache();
  });

  async function voiceSite(): Promise<ChatSite> {
    const s = await st.stand('shop');
    await setPlan(st.owner, s.accountId, 'business');
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        voiceConfig: { schema: 1, input: true, output: false, voiceId: null },
      },
    });
    return s;
  }

  /** Мемо «Сайта» строкой; `published` — с опубликованной версией. */
  async function siteMemo(
    s: ChatSite,
    p: {
      number: number;
      status: 'published' | 'draft' | 'checking';
      c: ReturnType<typeof content>;
    },
  ) {
    const memo = await st.owner.assistSiteMemo.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        number: p.number,
        key: `memo-${p.number}`,
        status: p.status,
        publishedVersion: p.status === 'published' ? 1 : null,
        draft: p.c,
        origin: 'manual',
        createdBy: 'm',
        updatedBy: 'm',
      },
    });
    if (p.status !== 'draft')
      await st.owner.assistSiteMemoVersion.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          memoId: memo.id,
          number: 1,
          status: p.status,
          // Версия хранится без предложений (как buildVersion).
          content: { ...p.c, suggested: {} },
          contentHash: `h${p.number}`,
          requestedBy: 'm',
        },
      });
  }

  async function publishedMap(s: ChatSite) {
    await st.owner.assistSiteVoiceMap.create({
      data: {
        siteId: s.siteId,
        accountId: s.accountId,
        publishedVersion: 1,
        versionSeq: 1,
        draft: { schemaVersion: 1, targets: [], templates: [], terms: [] },
      },
    });
    const d = (text: string, assistId: string) => ({
      tag: 'button',
      role: 'button',
      text,
      assistId,
      unique: true,
    });
    await st.owner.assistSiteVoiceMapVersion.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        number: 1,
        status: 'published',
        contentHash: 'x',
        requestedBy: 'm',
        requestedVia: 'tma',
        content: {
          schemaVersion: 1,
          templates: [],
          terms: ['Хорошоп', 'ivan@example.com'],
          targets: [
            {
              key: 'cart',
              scope: 'page',
              pagePath: '/',
              descriptor: d('Кошик', 'nav-cart'),
              names: { uk: 'Кошик', en: 'Wishlist' },
            },
            {
              key: 'gone',
              scope: 'page',
              pagePath: '/',
              status: 'removed',
              descriptor: d('Старе', 'old'),
              names: { uk: 'Видалена ціль' },
            },
          ],
        },
      },
    });
  }

  async function adminMemo(
    s: ChatSite,
    name: string,
    trigger: string,
    o: { number?: number; status?: 'published' | 'disabled' } = {},
  ) {
    const c = {
      schema: 1,
      names: { uk: name },
      triggers: { uk: [trigger] },
      goal: { text: {} },
      slots: [],
      steps: [],
    };
    const m = await st.owner.assistAdminMemo.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        number: o.number ?? 1,
        key: `am-${o.number ?? 1}`,
        status: o.status ?? 'published',
        publishedVersion: 1,
        draft: c,
        createdBy: 'm',
        updatedBy: 'm',
      },
    });
    await st.owner.assistAdminMemoVersion.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        memoId: m.id,
        number: 1,
        status: 'published',
        content: c,
        contentHash: 'a',
        requestedBy: 'm',
      },
    });
  }

  const sentTerms = (): unknown =>
    (
      fake.calls.find((c) => c.path === '/transcriptions')?.body as
        { context?: { terms?: unknown } } | undefined
    )?.context?.terms;

  it('«Сайт»: опубликованное своего сайта — в context.terms; черновики, проверка, suggested, удалённое, ПД и «Админка» — нет', async () => {
    const s = await voiceSite();
    await siteMemo(s, {
      number: 1,
      status: 'published',
      c: content(
        'Запис на консультацію',
        ['записати мене'],
        ['секретна пропозиція'],
      ),
    });
    await siteMemo(s, {
      number: 2,
      status: 'draft',
      c: content('Чернетка мемо', ['чернеткова фраза']),
    });
    await siteMemo(s, {
      number: 3,
      status: 'checking',
      c: content('Мемо на перевірці'),
    });
    await publishedMap(s);
    await adminMemo(s, 'Звіт продажів', 'покажи звіт');
    // Чужой сайт с опубликованным мемо — его имя не наше.
    const other = await voiceSite();
    await siteMemo(other, {
      number: 1,
      status: 'published',
      c: content('Чужий сайт мемо'),
    });

    const r = await voice.transcribe(
      { site: s.ctx(), visitor: st.visitor() },
      fakeRecording(),
      'audio/webm',
    );
    expect(r.ok).toBe(true);
    expect(sentTerms()).toEqual([
      'Хорошоп',
      'Запис на консультацію',
      'Кошик',
      'Wishlist',
      'записати мене',
    ]);
    const all = JSON.stringify(fake.calls);
    for (const leak of [
      'Звіт продажів',
      'покажи звіт',
      'Чернетка мемо',
      'чернеткова фраза',
      'Мемо на перевірці',
      'секретна пропозиція',
      'Видалена ціль',
      'ivan@example.com',
      'Чужий сайт мемо',
    ])
      expect(all).not.toContain(leak);
  });

  it('«Сайт» без мемо и карты — тело без context (как раньше)', async () => {
    const s = await voiceSite();
    const r = await voice.transcribe(
      { site: s.ctx(), visitor: st.visitor() },
      fakeRecording(),
      'audio/webm',
    );
    expect(r.ok).toBe(true);
    expect(
      fake.calls.find((c) => c.path === '/transcriptions')?.body,
    ).not.toHaveProperty('context');
  });

  it('«Админка»: свои мемо АМ-N — в context.terms; мемо и карта «Сайта» — нет', async () => {
    const s = await voiceSite();
    await siteMemo(s, {
      number: 1,
      status: 'published',
      c: content('Запис на консультацію', ['записати мене']),
    });
    await publishedMap(s);
    await adminMemo(s, 'Звіт продажів', 'покажи звіт');
    // Выключенное мемо (версия опубликована, само — нет) — не термин.
    await adminMemo(s, 'Вимкнене мемо', 'вимкнена фраза', {
      number: 2,
      status: 'disabled',
    });
    const terms = await adminSttTerms(new SitesDb(st.owner), {
      accountId: s.accountId,
      siteId: s.siteId,
    });
    expect(terms).toEqual(['Звіт продажів', 'покажи звіт']);
    await adminStt.transcribe({
      audio: fakeRecording(),
      mimeType: 'audio/webm',
      languageHints: ['uk'],
      terms,
    });
    expect(sentTerms()).toEqual(['Звіт продажів', 'покажи звіт']);
    const all = JSON.stringify(fake.calls);
    for (const leak of [
      'Запис на консультацію',
      'записати мене',
      'Кошик',
      'Вимкнене мемо',
    ])
      expect(all).not.toContain(leak);
    // Кэш — на сайт: другой сайт без мемо «Админки» — пусто.
    const bare = await voiceSite();
    expect(
      await adminSttTerms(new SitesDb(st.owner), {
        accountId: bare.accountId,
        siteId: bare.siteId,
      }),
    ).toEqual([]);
  });

  it('(заход 9, P2-2) «не расслышал» по языкам: один источник — язык интерфейса виджета (X-Assist-Lang) для обоих счётчиков; старый бандл без заголовка — тишина в `any` (вне тревоги); сбой провайдера не считается', async () => {
    expect(STT_SCOPE_PUBLIC).toBe(STT_COUNTER_SCOPE);
    expect(sttLang('ru', 'uk-UA', true, [])).toBe('ru');
    expect(sttLang('ru', null, false, [])).toBe('ru');
    expect(sttLang(null, 'uk-UA', true, [])).toBe('uk');
    expect(sttLang(null, null, true, ['ru', 'uk'])).toBe('ru');
    expect(sttLang(null, null, true, [])).toBe('uk');
    expect(sttLang(null, 'uk', false, ['uk'])).toBe('any');
    expect(sttLang('de', 'uk', false, ['uk'])).toBe('any');
    expect(uiLangOf('en')).toBe('en');
    expect(uiLangOf('EN')).toBeNull();
    const s = await voiceSite();
    const ctx = { site: s.ctx(), visitor: st.visitor() };
    // Новый бандл: интерфейс en — и «расслышал», и «тишина» — в en, хотя
    // распознаватель определил ru.
    fake.language = 'ru';
    expect(
      (await voice.transcribe(ctx, fakeRecording(), 'audio/webm', 'en')).ok,
    ).toBe(true);
    fake.stt = 'silence';
    expect(
      await voice.transcribe(ctx, fakeRecording(), 'audio/webm', 'en'),
    ).toEqual({ ok: false, failure: 'not_heard' });
    // Старый бандл: расслышано — язык распознавателя, тишина — `any`.
    expect(await voice.transcribe(ctx, fakeRecording(), 'audio/webm')).toEqual({
      ok: false,
      failure: 'not_heard',
    });
    fake.stt = 'ok';
    expect(
      (await voice.transcribe(ctx, fakeRecording(), 'audio/webm')).ok,
    ).toBe(true);
    fake.stt = 'create-fails';
    expect(
      (await voice.transcribe(ctx, fakeRecording(), 'audio/webm', 'en')).ok,
    ).toBe(false);
    fake.language = 'uk';
    const c = await readSttCounters(st.owner, s.siteId, new Date());
    expect(c).toEqual({
      en: { heard: 1, notHeard: 1 },
      ru: { heard: 1, notHeard: 0 },
      any: { heard: 0, notHeard: 1 },
    });
    // `any` — не язык: в тревогу не идёт даже при 100%.
    expect(
      notHeardLangs({ any: { heard: 0, notHeard: 50 }, en: c.en }),
    ).toEqual([]);
    // Окно — 24 ч: счётчик суточной давности не считается.
    await st.owner.assistDailyCounter.updateMany({
      where: { scope: STT_COUNTER_SCOPE, key: { startsWith: s.siteId } },
      data: {
        day: new Date(Date.now() - 25 * 3_600_000).toISOString().slice(0, 13),
      },
    });
    expect(await readSttCounters(st.owner, s.siteId, new Date())).toEqual({});
  });
});
