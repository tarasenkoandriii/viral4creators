/**
 * Ш5(5) на реальном Postgres: ролики промпта помощника — сначала на языке
 * посетителя (язык ответа, затем язык интерфейса), потом остальные;
 * потолок синхронизации — 10 шагов × 5 языков генератора (50) с запасом.
 * Публичный код — под ролью assist_public (как в проде), посев — владельцем.
 */
import { randomUUID } from 'crypto';
import { SitesDb } from '../../prisma/sites-db.service';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { ChatStack } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { MEDIA_DEFAULTS } from '../../modules/assist-site-media/media-config';
import {
  promptVideos,
  videoLangPrefs,
} from '../../modules/assist-site-media/public/site-videos';
import {
  InternalSiteMediaService,
  SYNC_VIDEOS_MAX,
  type SyncVideoInput,
} from '../../modules/internal-sites/site-media.service';
import { AccountService } from '../../modules/site-core/account/account.service';

jest.setTimeout(180_000);

let asOfClock = Date.now();
const nextAsOf = () => ++asOfClock;
const BLOB = (n: string) =>
  `https://store1.public.blob.vercel-storage.com/tutorial-videos/${n}.mp4`;

describe('videoLangPrefs (чистая)', () => {
  it('язык ответа, затем интерфейса; без повторов и мусора', () => {
    expect(videoLangPrefs('uk', 'en-US')).toEqual(['uk', 'en']);
    expect(videoLangPrefs('ru', 'RU')).toEqual(['ru']);
    expect(videoLangPrefs('en', null)).toEqual(['en']);
    expect(videoLangPrefs(null, '??')).toEqual([]);
  });

  it('потолок синхронизации одинаков у внутреннего API и у отбора промпта; ≥ 10 × 5', () => {
    expect(SYNC_VIDEOS_MAX).toBe(MEDIA_DEFAULTS.syncVideosMax);
    expect(SYNC_VIDEOS_MAX).toBeGreaterThanOrEqual(50);
    expect(SYNC_VIDEOS_MAX).toBeLessThanOrEqual(100);
    expect(MEDIA_DEFAULTS.promptVideos).toBe(8);
  });
});

describeDb('Ш5(5) — ролики по языку посетителя', () => {
  const st = new ChatStack();
  let internal: InternalSiteMediaService;

  beforeAll(async () => {
    await st.init();
    const db = new SitesDb(st.owner);
    internal = new InternalSiteMediaService(db, new AccountService(db));
    internal.env = {};
  });
  afterAll(async () => {
    await st.close();
  });

  const row = (
    s: { ownerTelegramId: bigint; host: string; siteId: string },
    i: number,
    title: string,
    locale: string,
  ): SyncVideoInput => ({
    externalId: `asset-${randomUUID()}`,
    draftId: `draft-${i}`,
    ownerTelegramId: s.ownerTelegramId,
    title,
    locale,
    durationMs: 30_000,
    url: BLOB(`${s.siteId}-${i}`),
    requiresLogin: false,
    stepHosts: [s.host],
  });

  /** Сайт Business с роликами (включены владельцем). */
  async function site(videos: Array<[title: string, locale: string]>) {
    const s = await st.stand('shop');
    await setPlan(st.owner, s.accountId, 'business');
    const r = await internal.syncVideos(
      s.siteId,
      videos.map(([t, l], i) => row(s, i, t, l)),
      nextAsOf(),
    );
    expect(r.accepted).toBe(videos.length);
    await st.owner.assistSiteVideo.updateMany({
      where: { siteId: s.siteId },
      data: { enabled: true },
    });
    return s;
  }

  // Латиница в порядке названий идёт раньше кириллицы: без учёта языка
  // 9 английских роликов заняли бы все 8 мест промпта.
  const EN = Array.from(
    { length: 9 },
    (_, i) => [`How to step ${i + 1}`, 'en'] as [string, string],
  );
  const UK = [
    ['Як оформити замовлення', 'uk'],
    ['Як повернути товар', 'uk'],
    ['Як сплатити карткою', 'uk-UA'],
  ] as Array<[string, string]>;

  it('в промпт сначала ролики языка посетителя (стабильно по названию), затем остальные; ≤ 8', async () => {
    const s = await site([...EN, ...UK]);
    const plain = await promptVideos(st.publicDb, s.siteId);
    expect(plain).toHaveLength(8);
    expect(plain.every((v) => v.locale === 'en')).toBe(true);

    const uk = await promptVideos(st.publicDb, s.siteId, ['uk', 'en']);
    expect(uk.map((v) => v.title)).toEqual([
      'Як оформити замовлення',
      'Як повернути товар',
      'Як сплатити карткою',
      'How to step 1',
      'How to step 2',
      'How to step 3',
      'How to step 4',
      'How to step 5',
    ]);
    expect(uk.map((v) => v.ref)).toEqual([
      'V1',
      'V2',
      'V3',
      'V4',
      'V5',
      'V6',
      'V7',
      'V8',
    ]);
    // Язык, которого у сайта нет, — прежний порядок.
    expect(
      (await promptVideos(st.publicDb, s.siteId, ['de'])).map((v) => v.id),
    ).toEqual(plain.map((v) => v.id));
    // Второй по порядку язык — после первого.
    const enFirst = await promptVideos(st.publicDb, s.siteId, ['en', 'uk']);
    expect(enFirst.every((v) => v.locale === 'en')).toBe(true);
  });

  it('чат: украинский вопрос — украинские ролики в промпте; английский — английские', async () => {
    const s = await site([...EN, ...UK]);
    const calls0 = st.model.calls.length;
    await st.ask(s, 'Скільки коштує доставка Новою поштою?');
    expect(st.model.calls.length).toBe(calls0 + 1);
    let req = st.model.calls[st.model.calls.length - 1];
    let prompt = req.contents[req.contents.length - 1].content;
    expect(prompt).toContain('Як сплатити карткою');
    expect(prompt).toContain('Як оформити замовлення');
    expect(prompt).not.toContain('How to step 6');

    await st.ask(s, 'How much does delivery cost?', { uiLang: 'en' });
    expect(st.model.calls.length).toBe(calls0 + 2);
    req = st.model.calls[st.model.calls.length - 1];
    prompt = req.contents[req.contents.length - 1].content;
    expect(prompt).toContain('How to step 8');
    expect(prompt).not.toContain('Як сплатити карткою');
  });

  it('синхронизация: 10 шагов × 5 языков (50) принимаются целиком; сверх потолка — отсекается', async () => {
    const langs = ['uk', 'ru', 'en', 'pl', 'de'];
    const set: Array<[string, string]> = [];
    for (let step = 1; step <= 10; step++)
      for (const l of langs)
        set.push([`Крок ${step} — довгий заголовок ролика (${l})`, l]);
    const s = await site(set);
    expect(
      await st.owner.assistSiteVideo.count({ where: { siteId: s.siteId } }),
    ).toBe(50);
    // В промпт по-прежнему ≤ 8 — и все на языке посетителя.
    const p = await promptVideos(st.publicDb, s.siteId, ['pl']);
    expect(p).toHaveLength(8);
    expect(p.every((v) => v.locale === 'pl')).toBe(true);

    const over = Array.from({ length: SYNC_VIDEOS_MAX + 1 }, (_, i) =>
      row(s, i, `Ролик ${i}`, 'uk'),
    );
    const r = await internal.syncVideos(s.siteId, over, nextAsOf());
    expect(r.accepted).toBe(SYNC_VIDEOS_MAX);
    expect(
      await st.owner.assistSiteVideo.count({ where: { siteId: s.siteId } }),
    ).toBe(SYNC_VIDEOS_MAX);
  });
});
