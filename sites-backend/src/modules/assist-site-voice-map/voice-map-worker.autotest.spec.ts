/**
 * №29, Р-З10-19: Т-3 по расписанию на реальном Postgres — монитор Т-4
 * (`VoiceMonitorService.run`) + порт очереди воркера
 * (`attachVoiceAutotest`) + настоящая очередь (`BrowserJobsService`):
 *  - проход ставит ОДНО задание `voice-autotest` на сайт (страницы
 *    контрольных команд, хост «Сайта»), строка отчёта `autotest` создаётся
 *    сразу; повторный проход в те же сутки — ничего (≤ 1/сайт/сутки);
 *  - итог воркера → отчёт `autotest` (pass/partial/fail по доле
 *    потерянного), отметки контрольных команд, годность для `on` — нет;
 *  - отказ воркера → отчёт без результата (сайт не виноват);
 *  - воркер выключен — шаг пропущен с причиной, ни задания, ни строки.
 */
import { randomBytes } from 'crypto';
import { SitesDb } from '../../prisma/sites-db.service';
import { serializeDbTests } from '../../prisma/serial-lock.testing';
import { describeDb } from '../assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../assist-site-chat/testing/chat-stack.testing';
import { VoiceControlSettingsService } from '../assist-site-voice-control/cabinet/voice-control-settings.service';
import { AUTOTEST_RETENTION_MS } from '../assist-site-voice-control/system/voice-monitor-autotest';
import { VoiceMonitorService } from '../assist-site-voice-control/system/voice-monitor.service';
import { BrowserJobsService } from '../browser-jobs/browser-jobs.service';
import { BrowserJobHandlers } from '../browser-jobs/job-handlers';
import type { DescriptorResolveResult } from '../browser-jobs/protocol';
import { FakeArtifactStorage } from '../browser-jobs/testing/fake-artifact-storage.testing';
import {
  ageSiteJobs,
  leaseJobForTest,
  siteJobs,
} from '../browser-jobs/testing/jobs-db.testing';
import { attachVoiceAutotest } from './voice-map-worker.autotest';
import { VoiceMapWorkerService } from './voice-map-worker.service';
import { VoiceMapService } from './voice-map.service';

jest.setTimeout(180_000);

const el = (ref: string, text: string, role = 'button') => ({
  ref,
  role,
  tag: role === 'link' ? 'a' : 'button',
  text,
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
  box: { x: 1, y: 1, w: 10, h: 10 },
});

describeDb('Т-3 по расписанию: монитор → воркер → отчёт autotest (№29)', () => {
  serializeDbTests('voice-monitor');
  const st = new ChatStack();
  let mon: VoiceMonitorService;
  let jobs: BrowserJobsService;
  const accounts: string[] = [];
  const env: NodeJS.ProcessEnv = { BROWSER_WORKER_ENABLED: 'true' };
  const notified: string[] = [];

  beforeAll(async () => {
    await st.init();
    const db = new SitesDb(st.owner);
    const handlers = new BrowserJobHandlers();
    jobs = new BrowserJobsService(db, new FakeArtifactStorage(), handlers);
    jobs.env = env;
    mon = new VoiceMonitorService(db, st.owner);
    mon.env = {
      ...env,
      ASSIST_BOT_TOKEN: 'bot-test',
      ASSIST_TMA_URL: 'https://tma.example.com',
    };
    mon.onlyAccountIds = accounts;
    mon.cursorKey = `z10d-${randomBytes(4).toString('hex')}`;
    mon.platformKey = `${mon.cursorKey}-platform`;
    mon.releaseKey = `${mon.cursorKey}-release`;
    mon.fetchImpl = async (_u: unknown, init?: { body?: unknown }) => {
      notified.push(String(init?.body ?? ''));
      return { ok: true, status: 200 };
    };
    const maps = new VoiceMapService(db);
    attachVoiceAutotest({
      jobs,
      handlers,
      maps,
      monitor: mon,
      versionContent: () => Promise.reject(new Error('карты нет')),
      checkPaths: (c) => VoiceMapWorkerService.checkPaths(c),
      report: (v, c, r) => VoiceMapWorkerService.report(v, c, r),
      snapshotsOf: (r) => VoiceMapWorkerService.snapshotsOf(r),
    });
  });

  afterAll(async () => {
    if (accounts.length)
      await st.owner.siteAccount.deleteMany({
        where: { id: { in: accounts } },
      });
    await st.close();
  });

  beforeEach(() => {
    env.BROWSER_WORKER_ENABLED = 'true';
    notified.length = 0;
  });

  async function vcSite(texts: string[]): Promise<ChatSite> {
    const s = await st.site({ name: 'Магазин Т-3' });
    accounts.push(s.accountId);
    await st.owner.siteHost.updateMany({
      where: { siteId: s.siteId },
      data: { expiresAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: { voiceControlSiteState: 'on' },
    });
    await st.owner.assistSiteVoiceControlCommand.createMany({
      data: texts.map((text, i) => ({
        accountId: s.accountId,
        siteId: s.siteId,
        pagePath: '/',
        utteranceMasked: `команда ${i}`,
        lang: 'uk',
        expected: [{ kind: 'click', role: 'button', text, assistId: null }],
        origin: 'production_top',
      })),
    });
    return s;
  }

  const jobsOf = (s: ChatSite) =>
    siteJobs(st.owner, { siteId: s.siteId, origin: 'voice-autotest' });
  const autotestsOf = (s: ChatSite) =>
    st.owner.assistSiteVoiceTest.findMany({
      where: { siteId: s.siteId, kind: 'autotest' },
    });

  const lease = (jobId: string) => leaseJobForTest(st.owner, jobId);

  it('проход ставит одно задание на сайт; второй проход в те же сутки — ничего', async () => {
    const s = await vcSite(['Купити', 'Кошик', 'Доставка']);
    const r1 = await mon.run();
    expect(r1.autotestSkipped).toBeNull();
    const j1 = await jobsOf(s);
    expect(j1).toHaveLength(1);
    expect(j1[0]).toMatchObject({
      kind: 'descriptor-resolve',
      status: 'queued',
      testAccountId: null,
    });
    expect((j1[0].params as { pages: string[] }).pages).toEqual([
      `${s.origin}/`,
    ]);
    const rows = await autotestsOf(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      host: s.host,
      origin: s.origin,
      reportedAt: null,
      startedBy: 'monitor',
    });
    expect(j1[0].refId).toBe(`${rows[0].id}:v0`);
    await mon.run();
    expect(await jobsOf(s)).toHaveLength(1);
    expect(await autotestsOf(s)).toHaveLength(1);
  });

  it('итог воркера → отчёт autotest (partial), отметки команд; годности для on не даёт', async () => {
    const s = await vcSite(['Купити', 'Кошик', 'Доставка']);
    await mon.run();
    const [job] = await jobsOf(s);
    const token = await lease(job.id);
    const result: DescriptorResolveResult = {
      pages: [
        {
          url: `${s.origin}/`,
          ok: true,
          error: null,
          counts: {},
          snapshot: {
            url: `${s.origin}/`,
            title: 'Головна',
            elements: [el('e1', 'Купити'), el('e2', 'Кошик')],
          },
        },
      ],
    };
    await jobs.complete(job.id, token, result);
    const [row] = await autotestsOf(s);
    expect(row.reportedAt).not.toBeNull();
    expect(row.result).toBe('partial');
    expect(row.validUntil).toBeNull();
    const rep = row.report as {
      kind: string;
      autotest: { checked: number; lost: number; error: string | null };
    };
    expect(rep.kind).toBe('autotest');
    expect(rep.autotest).toMatchObject({ checked: 3, lost: 1, error: null });
    const cmds = await st.owner.assistSiteVoiceControlCommand.findMany({
      where: { siteId: s.siteId },
      orderBy: { utteranceMasked: 'asc' },
    });
    expect(cmds.map((c) => c.lastResult)).toEqual(['found', 'found', 'lost']);
    expect(cmds.every((c) => c.lastCheckedAt !== null)).toBe(true);
    // Очередь хранит только сводку (снимки нужны были один раз).
    const stored = (await jobsOf(s)).find((j) => j.id === job.id)!;
    expect(stored.result).toEqual({ testId: row.id, result: 'partial' });
    // Частичный — без тревоги владельцу.
    expect(notified).toHaveLength(0);
  });

  it('провал (≥ половины потеряно) — отчёт fail и тревога владельцу на его языке', async () => {
    const s = await vcSite(['Купити', 'Кошик']);
    await mon.run();
    const [job] = await jobsOf(s);
    const token = await lease(job.id);
    await jobs.complete(job.id, token, {
      pages: [
        {
          url: `${s.origin}/`,
          ok: true,
          error: null,
          counts: {},
          snapshot: {
            url: `${s.origin}/`,
            title: 'Головна',
            elements: [el('e1', 'Щось інше')],
          },
        },
      ],
    });
    const [row] = await autotestsOf(s);
    expect(row.result).toBe('fail');
    expect(notified.length).toBeGreaterThan(0);
    expect(notified.join('\n')).toContain('Автоперевірка');
    expect(
      await st.owner.assistSiteVoiceIncident.count({
        where: { siteId: s.siteId, kind: 'alert', code: 'autotest_fail' },
      }),
    ).toBe(1);
  });

  it('отказ воркера — отчёт без результата (сайт не виноват)', async () => {
    const s = await vcSite(['Купити']);
    await mon.run();
    const [job] = await jobsOf(s);
    const token = await lease(job.id);
    await jobs.fail(job.id, token, 'nav_failed');
    const [row] = await autotestsOf(s);
    expect(row.reportedAt).not.toBeNull();
    expect(row.result).toBeNull();
    expect((row.report as { autotest: { error: string } }).autotest.error).toBe(
      'nav_failed',
    );
  });

  it('воркер выключен — шаг пропущен с причиной: ни задания, ни строки отчёта', async () => {
    const s = await vcSite(['Купити']);
    env.BROWSER_WORKER_ENABLED = 'false';
    mon.env.BROWSER_WORKER_ENABLED = 'false';
    const r = await mon.run();
    mon.env.BROWSER_WORKER_ENABLED = 'true';
    expect(r.autotestSkipped).toBe('worker_disabled');
    expect(r.autotests).toBe(0);
    expect(await jobsOf(s)).toHaveLength(0);
    expect(await autotestsOf(s)).toHaveLength(0);
  });

  /** Провал Т-3 по сайту: проход монитора и итог воркера «ничего не нашлось». */
  async function failOnce(s: ChatSite) {
    await mon.run();
    const pending = (await jobsOf(s)).find((j) => j.status === 'queued')!;
    const token = await lease(pending.id);
    await jobs.complete(pending.id, token, {
      pages: [
        {
          url: `${s.origin}/`,
          ok: true,
          error: null,
          counts: {},
          snapshot: {
            url: `${s.origin}/`,
            title: 'Головна',
            elements: [el('e1', 'Щось інше')],
          },
        },
      ],
    });
  }

  /** «Прошли сутки»: строки автотеста и задания очереди — на день старше. */
  async function dayLater(s: ChatSite) {
    const day = 86_400_000;
    for (const r of await autotestsOf(s))
      await st.owner.assistSiteVoiceTest.update({
        where: { id: r.id },
        data: { createdAt: new Date(r.createdAt.getTime() - day - 60_000) },
      });
    await ageSiteJobs(st.owner, s.siteId, 25 * 3_600_000);
  }

  it('стойкий провал: тревога владельцу — не чаще раза в 7 дней, инцидент — каждый раз (аудит P3 (5))', async () => {
    const s = await vcSite(['Купити', 'Кошик']);
    await failOnce(s);
    expect(notified.length).toBe(1);
    await dayLater(s);
    notified.length = 0;
    await failOnce(s);
    expect(
      (await autotestsOf(s)).filter((r) => r.result === 'fail'),
    ).toHaveLength(2);
    expect(notified).toHaveLength(0);
    const inc = await st.owner.assistSiteVoiceIncident.findMany({
      where: { siteId: s.siteId, code: 'autotest_fail' },
      orderBy: { createdAt: 'asc' },
    });
    expect(inc.map((x) => x.notified > 0)).toEqual([true, false]);
  });

  it('ретенция строк автотеста; в списке отчётов кабинета автотесты не вытесняют отчёты мастера', async () => {
    const s = await vcSite(['Купити']);
    const mk = (kind: string, ageMs: number, i: number) =>
      st.owner.assistSiteVoiceTest.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          kind,
          host: s.host,
          origin: s.origin,
          tokenHash: `z10d-${kind}-${i}-${randomBytes(6).toString('hex')}`,
          tokenExpiresAt: new Date(Date.now() + 86_400_000),
          createdAt: new Date(Date.now() - ageMs),
        },
      });
    await mk('wizard', 40 * 86_400_000, 0);
    for (let i = 0; i < 25; i++) await mk('autotest', (i + 2) * 3_600_000, i);
    const old = await mk('autotest', AUTOTEST_RETENTION_MS + 86_400_000, 99);
    await mon.run();
    expect(
      await st.owner.assistSiteVoiceTest.count({ where: { id: old.id } }),
    ).toBe(0);
    const cab = new VoiceControlSettingsService(
      new SitesDb(st.owner),
      st.owner,
    );
    const { items } = await cab.tests(
      {
        accountId: s.accountId,
        memberId: 'm-z10d',
        telegramId: s.ownerTelegramId,
        role: 'owner',
        productRoles: { assist: 'manager' },
      } as never,
      s.siteId,
    );
    expect(items.filter((x) => x.kind === 'wizard')).toHaveLength(1);
    expect(
      items.filter((x) => x.kind === 'autotest').length,
    ).toBeLessThanOrEqual(5);
  });
});
