/**
 * Заход 11, Р-З11-В3 (хвост захода 10 «два сообщения владельцам
 * „Админки“») + раунд исправлений по аудиту: отчёт недели «Админки» —
 * разделом сегодняшней сводки, одно сообщение на получателя, язык
 * получателя сохраняется:
 *  - сводка впереди → отчёт ждёт; сводка забирает получателей с разделом
 *    «Админка», вторая кнопка — статистика «Админки»; остальным — отдельно
 *    после прохода сводки; повтор досылки — тишина;
 *  - «Сайту» и «Админке» за сутки сказать нечего → только отчёт «Админки»,
 *    без рамки из нулей (P3-7); забор проигран → пустую сводку не шлём (P3-1);
 *  - гонка забора сводки и досылки (два соединения, `FOR UPDATE`, P3-3);
 *  - раздел не влез в 4 096 (P3-4); досылка упала между забором и
 *    отправкой — получатели возвращаются (P3-5);
 *  - пока сводка впереди, тик недели берёт больше сайтов (P2-2);
 *  - сводка уже прошла сегодня / не работает → сразу; сбой отправки →
 *    отдельно; страховка 8 ч; отчёт выключили → ничего.
 */
import { randomUUID } from 'crypto';
import { AdminWeeklyDigest } from '../assist-admin-analytics/admin-weekly-digest';
import {
  ADMIN_WEEKLY_SITES_BEFORE_DIGEST,
  AdminWeekly,
} from '../assist-admin-analytics/admin-weekly.service';
import { AdminDigestSource } from '../assist-admin-knowledge/admin-digest';
import { AnalyticsStack } from '../assist-analytics/testing/analytics-stack.testing';
import { describeDb } from '../assist-sandbox/testing/k3-stack.testing';
import type { ChatSite } from '../assist-site-chat/testing/chat-stack.testing';
import type { LearningReadApi } from '../assist-site-learning/learning-read.service';
import type { GeminiText } from '../site-ai/text-model';
import { AssistDigestService } from './digest.service';

jest.setTimeout(120_000);

const WEEK = '2026-09-28';
/**
 * Своя строка замка «сводки»: общий ключ `assist-digest` берут e3-спеки
 * крона (параллельные воркеры jest на общей базе).
 */
const DIGEST_KEY = `assist-digest:z11c:${randomUUID().slice(0, 8)}`;
/** Понедельник после недели: сводка — 06:30 UTC (Киев — отчёт недели). */
const MON = (hm: string) => new Date(`2026-10-05T${hm}:00Z`);
const SUNDAY_DIGEST = new Date('2026-10-04T06:30:00Z');

interface Msg {
  chat_id: string;
  text: string;
  urls: string[];
}

describeDb('отчёт недели «Админки» — разделом утренней сводки', () => {
  const st = new AnalyticsStack();
  let digest: AssistDigestService;
  let weekly: AdminWeekly;
  let pending: AdminWeeklyDigest;
  /** «Часы базы» для постановки и досылки (подмена `dbNow`). */
  let clock = MON('06:10');
  const sent: Msg[] = [];
  /** chat id, которым Telegram «не доставляет» (HTTP 500). */
  const failFor = new Set<string>();
  const fetchImpl = async (
    _u: string,
    init: { body: string },
  ): Promise<{ ok: boolean; status: number }> => {
    const b = JSON.parse(init.body) as {
      chat_id: string;
      text: string;
      reply_markup: {
        inline_keyboard: Array<Array<{ web_app: { url: string } }>>;
      };
    };
    if (failFor.has(b.chat_id)) return { ok: false, status: 500 };
    sent.push({
      chat_id: b.chat_id,
      text: b.text,
      urls: b.reply_markup.inline_keyboard.map((row) => row[0].web_app.url),
    });
    return { ok: true, status: 200 };
  };
  const digestWith = (src: AdminWeeklyDigest) => {
    const d = new AssistDigestService(
      st.owner,
      st.sitesDb,
      st.rollup,
      new AdminDigestSource(st.sitesDb),
      st.learning as unknown as LearningReadApi,
      src,
    );
    d.env = st.chat.env;
    d.fetchImpl = fetchImpl;
    return d;
  };

  beforeAll(async () => {
    await st.init();
    pending = new AdminWeeklyDigest(st.owner, st.sitesDb);
    pending.digestJobKey = DIGEST_KEY;
    pending.dbNow = async () => clock;
    digest = digestWith(pending);
    // Модели нет (ASSIST_LITE_MODEL не задан) — выводы сухими строками.
    weekly = new AdminWeekly(st.owner, st.sitesDb, {} as GeminiText, pending);
    weekly.env = { ...st.chat.env };
    weekly.fetchImpl = fetchImpl;
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await st.owner.siteCronLock.deleteMany({ where: { jobKey: DIGEST_KEY } });
    await st.close();
  });
  beforeEach(() => {
    sent.length = 0;
    failFor.clear();
  });

  /** Замок сводки: последний старт и занятость. */
  async function digestLock(lastStartedAt: Date | null, lockedUntil?: Date) {
    await st.owner.siteCronLock.deleteMany({ where: { jobKey: DIGEST_KEY } });
    if (lastStartedAt)
      await st.owner.siteCronLock.create({
        data: {
          jobKey: DIGEST_KEY,
          lastStartedAt,
          lockedUntil: lockedUntil ?? null,
        },
      });
  }

  /**
   * Сайт с «Админкой», неделей диалогов и тремя владельцами «Админки».
   * `busy` — у «Сайта» есть диалоги за неделю (сводка не пустая).
   */
  async function adminSite(name: string, opts: { busy?: boolean } = {}) {
    const s: ChatSite = await st.site({ name });
    await st.owner.assistAdminSettings.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        adminModeEnabled: true,
      },
    });
    for (let i = 0; i < 7; i++) {
      const d = new Date(`${WEEK}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      await st.owner.assistAdminDailyStat.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          day: d.toISOString().slice(0, 10),
          role: '*',
          conversations: 2,
          questions: 6,
          refused: 3,
        },
      });
    }
    if (opts.busy) {
      // День недели «Сайта» (не вчера — его сводка пересчитывает).
      await st.owner.assistSiteDailyTotal.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          day: '2026-09-30',
          group: 'all',
          dialogs: 5,
          resolved: 3,
        },
      });
    }
    // Владелец кабинета — ru; assistAdmin: owner + менеджер «Сайта» — en
    // (оба получают сводку); assistAdmin: owner без сводки — uk;
    // менеджер «Сайта» без «Админки» — раздел не видит.
    const owner = s.ownerTelegramId;
    const adminMgr = (await st.member(s, 'manager', { assistAdmin: 'owner' }))
      .telegramId;
    const adminOp = (await st.member(s, 'operator', { assistAdmin: 'owner' }))
      .telegramId;
    const siteMgr = (await st.member(s, 'manager')).telegramId;
    for (const [tg, lang] of [
      [owner, 'ru'],
      [adminMgr, 'en'],
      [adminOp, 'uk'],
      [siteMgr, 'uk'],
    ] as const) {
      await st.owner.assistBotUser.upsert({
        where: { telegramId: tg },
        create: { telegramId: tg, languageCode: lang },
        update: { languageCode: lang },
      });
    }
    return { s, owner, adminMgr, adminOp, siteMgr };
  }

  const insight = (siteId: string) =>
    st.owner.assistAdminInsight.findUniqueOrThrow({
      where: { siteId_weekStart: { siteId, weekStart: WEEK } },
    });
  const to = (tg: bigint) => sent.filter((m) => m.chat_id === tg.toString());
  /** Неделя сайта «по часам базы» `at`. */
  const queue = (s: ChatSite, at: Date) => {
    clock = at;
    return weekly.site(s.accountId, s.siteId, WEEK, at);
  };
  const flush = (at: Date, siteId: string) => {
    clock = at;
    return weekly.flush(Date.now() + 20_000, [siteId]);
  };
  const pendingOf = async (siteId: string) =>
    [...(await insight(siteId)).digestPending].sort();
  const ids = (...tg: bigint[]) => tg.map(String).sort();

  it('сводка впереди: отчёт ждёт и уходит её разделом (каждому на его языке); остальным — отдельно после сводки, один раз', async () => {
    const { s, owner, adminMgr, adminOp, siteMgr } = await adminSite(
      'Склад Пункт',
      { busy: true },
    );
    await digestLock(SUNDAY_DIGEST);
    const r = await queue(s, MON('06:10'));
    expect(r).toMatchObject({ sent: false, queued: 3 });
    expect(sent).toEqual([]);
    expect(await pendingOf(s.siteId)).toEqual(ids(owner, adminMgr, adminOp));
    expect((await insight(s.siteId)).digestPendingAt?.toISOString()).toBe(
      MON('06:10').toISOString(),
    );

    // Сводка ещё не прошла — досылать рано.
    expect(await flush(MON('06:20'), s.siteId)).toBe(0);

    await digestLock(MON('06:30'), MON('06:45'));
    const d = await digest.run(MON('06:30'), { siteIds: [s.siteId] });
    expect(d.weekly).toBe(true);
    // Сводка идёт (замок держится) — досылка ждёт.
    expect(await flush(MON('06:31'), s.siteId)).toBe(0);
    await digestLock(MON('06:30'));

    const ru = to(owner);
    expect(ru).toHaveLength(1);
    expect(ru[0].text).toContain('Отчёт недели');
    expect(ru[0].text).toContain('Диалоги: 5');
    expect(ru[0].text).toContain(`Неделя «Админки» с ${WEEK}`);
    expect(ru[0].text).toContain('Что стоит сделать:');
    expect(ru[0].urls).toHaveLength(2);
    expect(ru[0].urls[0]).toContain(`#/sites/${s.siteId}/stats`);
    expect(ru[0].urls[1]).toContain(`#/sites/${s.siteId}/admin-mode/stats`);
    const en = to(adminMgr);
    expect(en).toHaveLength(1);
    expect(en[0].text).toContain('Weekly report');
    expect(en[0].text).toContain('Back-office assistant week');
    expect(en[0].text).not.toContain('Неделя «Админки»');
    // Менеджер «Сайта» получает отчёт «Сайта» без раздела «Админки».
    expect(to(siteMgr)).toHaveLength(1);
    expect(to(siteMgr)[0].text).not.toMatch(/Тиждень «Адмінки»|Админк/);
    expect(to(adminOp)).toEqual([]);
    expect(await pendingOf(s.siteId)).toEqual(ids(adminOp));

    sent.length = 0;
    expect(await flush(MON('06:50'), s.siteId)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe(adminOp.toString());
    expect(sent[0].text).toContain(`Тиждень «Адмінки» з ${WEEK}`);
    expect(sent[0].urls).toEqual([
      expect.stringContaining(`#/sites/${s.siteId}/admin-mode/stats`),
    ]);
    expect(await pendingOf(s.siteId)).toEqual([]);

    // Забранного не забрать второй раз (гонка сводки и досылки).
    const done = await insight(s.siteId);
    expect(await pending.claim(s.accountId, done.id, owner)).toBe(false);
    expect(await pending.claim(s.accountId, done.id, adminOp)).toBe(false);
    expect(await pending.takeRest(s.accountId, done.id)).toEqual([]);

    // Повтор досылки и повтор сводки — без дублей.
    sent.length = 0;
    expect(await flush(MON('07:00'), s.siteId)).toBe(0);
    await digest.run(MON('06:30'), { siteIds: [s.siteId] });
    expect(sent.some((m) => /Неделя «Админки»|Back-office/.test(m.text))).toBe(
      false,
    );
  });

  it('P3-7: пустые для «Сайта» сутки без новостей «Админки» — только отчёт «Админки», без рамки из нулей', async () => {
    const { s, owner, adminMgr, siteMgr } = await adminSite('Тихий сайт');
    await digestLock(SUNDAY_DIGEST);
    await queue(s, MON('06:10'));
    await digestLock(MON('06:30'));
    await digest.run(MON('06:30'), { siteIds: [s.siteId] });
    const ru = to(owner);
    expect(ru).toHaveLength(1);
    expect(ru[0].text.startsWith(`Неделя «Админки» с ${WEEK}`)).toBe(true);
    expect(ru[0].text).not.toContain('Отчёт недели');
    expect(ru[0].text).not.toContain('Диалоги: 0');
    expect(ru[0].urls).toEqual([
      expect.stringContaining(`#/sites/${s.siteId}/admin-mode/stats`),
    ]);
    expect(to(adminMgr)[0].text).toContain('Back-office assistant week');
    expect(to(siteMgr)).toEqual([]);
  });

  it('P3-1/P3-2: забор проигран (досылка забрала раньше) — ни раздела, ни сводки из нулей; отчёт «Сайта» — без раздела', async () => {
    // Источник ожидания, у которого остаток «уводят» между снимком и забором.
    const racy = new (class extends AdminWeeklyDigest {
      override async pending(accountId: string, siteId: string) {
        const p = await super.pending(accountId, siteId);
        if (p) await this.takeRest(accountId, p.id);
        return p;
      }
    })(st.owner, st.sitesDb);
    const racyDigest = digestWith(racy);

    const quiet = await adminSite('Гонка тихая');
    const busy = await adminSite('Гонка шумная', { busy: true });
    await digestLock(SUNDAY_DIGEST);
    await queue(quiet.s, MON('06:10'));
    await queue(busy.s, MON('06:10'));
    await digestLock(MON('06:30'));
    await racyDigest.run(MON('06:30'), {
      siteIds: [quiet.s.siteId, busy.s.siteId],
    });
    // Тихий сайт: забор проигран — пустую сводку не шлём никому.
    expect(to(quiet.owner)).toEqual([]);
    expect(to(quiet.adminMgr)).toEqual([]);
    // Шумный: отчёт «Сайта» есть, раздела «Админки» — нет (одна кнопка).
    expect(to(busy.owner)).toHaveLength(1);
    expect(to(busy.owner)[0].text).toContain('Отчёт недели');
    expect(to(busy.owner)[0].text).not.toContain('Неделя «Админки»');
    expect(to(busy.owner)[0].urls).toHaveLength(1);
  });

  it('P3-3: забор сводки и досылка в двух соединениях — `takeRest` ждёт блокировку и не отдаёт забранного', async () => {
    const { s, owner, adminMgr, adminOp } = await adminSite('Два соединения');
    await digestLock(SUNDAY_DIGEST);
    await queue(s, MON('06:10'));
    const { id } = await insight(s.siteId);
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // Соединение A: забор владельца сводкой, транзакция ещё не зафиксирована.
    const tx = st.owner.$transaction(
      async (t) => {
        await t.$executeRawUnsafe(
          `UPDATE "sites"."assist_admin_insights"
              SET "digestPending" = array_remove("digestPending", $2)
            WHERE "id" = $1 AND $2 = ANY("digestPending")`,
          id,
          owner.toString(),
        );
        locked();
        await new Promise((r) => setTimeout(r, 500));
      },
      { timeout: 15_000 },
    );
    await isLocked;
    // Соединение B: досылка забирает остаток.
    const t0 = Date.now();
    const rest = await pending.takeRest(s.accountId, id);
    const waited = Date.now() - t0;
    await tx;
    expect(waited).toBeGreaterThanOrEqual(300);
    expect([...rest].sort()).toEqual(ids(adminMgr, adminOp));
    expect(await pendingOf(s.siteId)).toEqual([]);
  });

  it('P3-4: раздел не влез в 4 096 символов — сводка без него, получатель ждёт и получает отчёт отдельно', async () => {
    const { s, owner } = await adminSite(`Магазин ${'Ж'.repeat(3600)}`, {
      busy: true,
    });
    await digestLock(SUNDAY_DIGEST);
    await queue(s, MON('06:10'));
    await digestLock(MON('06:30'));
    await digest.run(MON('06:30'), { siteIds: [s.siteId] });
    const ru = to(owner);
    expect(ru).toHaveLength(1);
    expect(ru[0].text).toContain('Отчёт недели');
    expect(ru[0].text).not.toContain('Неделя «Админки»');
    expect(ru[0].urls).toHaveLength(1);
    expect(await pendingOf(s.siteId)).toContain(owner.toString());
    sent.length = 0;
    await flush(MON('06:50'), s.siteId);
    expect(to(owner)).toHaveLength(1);
    expect(to(owner)[0].text.startsWith('Неделя «Админки»')).toBe(true);
    expect(to(owner)[0].text.length).toBeLessThanOrEqual(4096);
  });

  it('P3-5: досылка упала между забором и отправкой — получатели возвращаются и уходят следующим тиком', async () => {
    const { s, owner, adminMgr, adminOp } = await adminSite('Падение досылки');
    await digestLock(SUNDAY_DIGEST);
    await queue(s, MON('06:10'));
    // Язык получателей читается системным клиентом — он и «падает».
    const spy = jest.spyOn(st.sitesDb, 'system').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(await flush(MON('14:20'), s.siteId)).toBe(0);
    spy.mockRestore();
    expect(sent).toEqual([]);
    expect(await pendingOf(s.siteId)).toEqual(ids(owner, adminMgr, adminOp));
    expect(await flush(MON('14:30'), s.siteId)).toBe(3);
    expect(await pendingOf(s.siteId)).toEqual([]);
  });

  it('P2-2: пока сводка впереди, тик недели берёт больше сайтов, чем обычно', async () => {
    expect(ADMIN_WEEKLY_SITES_BEFORE_DIGEST).toBeGreaterThanOrEqual(25);
    const before = [];
    for (let i = 0; i < 7; i++) before.push((await adminSite(`До ${i}`)).s);
    await digestLock(SUNDAY_DIGEST);
    clock = MON('06:10');
    const r = await weekly.tick({
      now: MON('06:10'),
      deadline: Date.now() + 60_000,
      maxSites: 5,
      siteIds: before.map((s) => s.siteId),
    });
    expect(r).toMatchObject({ sites: 7, queued: 7 });

    const after = [];
    for (let i = 0; i < 7; i++) after.push((await adminSite(`После ${i}`)).s);
    await digestLock(MON('06:30'));
    clock = MON('06:40');
    sent.length = 0;
    const r2 = await weekly.tick({
      now: MON('06:40'),
      deadline: Date.now() + 60_000,
      maxSites: 5,
      siteIds: after.map((s) => s.siteId),
    });
    expect(r2).toMatchObject({ sites: 5, queued: 0, reports: 5 });
  });

  it('сводка сегодня уже прошла — отчёт уходит сразу отдельным сообщением', async () => {
    const { s, owner, adminMgr, adminOp } = await adminSite('Поздний');
    await digestLock(MON('06:30'));
    const r = await queue(s, MON('07:10'));
    expect(r.sent).toBe(true);
    expect(r.queued).toBeUndefined();
    expect(sent.map((m) => m.chat_id).sort()).toEqual(
      ids(owner, adminMgr, adminOp),
    );
    expect(to(owner)[0].text).toContain('Неделя «Админки»');
    const row = await insight(s.siteId);
    expect(row.digestPending).toEqual([]);
    expect(row.digestPendingAt).toBeNull();
  });

  it('сводки не было никогда — отчёт сразу (ожидать нечего)', async () => {
    const { s } = await adminSite('Без сводки');
    await digestLock(null);
    const r = await queue(s, MON('06:10'));
    expect(r.sent).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it('сводка не дошла до получателя — он возвращается в ожидание и получает отчёт отдельно', async () => {
    const { s, owner, adminMgr, adminOp } = await adminSite('Сбой связи', {
      busy: true,
    });
    await digestLock(SUNDAY_DIGEST);
    await queue(s, MON('06:10'));
    failFor.add(owner.toString());
    await digestLock(MON('06:30'));
    await digest.run(MON('06:30'), { siteIds: [s.siteId] });
    expect(to(adminMgr)).toHaveLength(1);
    expect(await pendingOf(s.siteId)).toEqual(ids(owner, adminOp));
    failFor.clear();
    sent.length = 0;
    expect(await flush(MON('06:50'), s.siteId)).toBe(2);
    expect(to(owner)).toHaveLength(1);
    expect(to(owner)[0].text).toContain('Неделя «Админки»');
    expect(to(owner)[0].text).not.toContain('Отчёт недели');
    expect(to(adminOp)).toHaveLength(1);
  });

  it('сводка не прошла дольше страховки (8 ч) — досылка всем', async () => {
    const { s } = await adminSite('Тихий крон');
    await digestLock(SUNDAY_DIGEST);
    await queue(s, MON('06:10'));
    expect(await flush(MON('13:00'), s.siteId)).toBe(0);
    expect(await flush(MON('14:20'), s.siteId)).toBe(3);
    expect(await pendingOf(s.siteId)).toEqual([]);
  });

  it('отчёт выключили после постановки — ни разделом сводки, ни отдельно', async () => {
    const { s, owner } = await adminSite('Передумали');
    await digestLock(SUNDAY_DIGEST);
    await queue(s, MON('06:10'));
    await st.owner.assistAdminSettings.update({
      where: { siteId: s.siteId },
      data: { weeklyReport: false },
    });
    expect(await pending.pending(s.accountId, s.siteId)).toBeNull();
    await digestLock(MON('06:30'));
    await digest.run(MON('06:30'), { siteIds: [s.siteId] });
    expect(to(owner)).toEqual([]);
    expect(await flush(MON('06:50'), s.siteId)).toBe(0);
    expect(sent).toEqual([]);
    expect(await pendingOf(s.siteId)).toEqual([]);
  });
});
