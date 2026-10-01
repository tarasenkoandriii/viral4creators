/**
 * GET /cron/assist-crawl-run: секрет крона, замок (второй параллельный
 * вызов не работает), порядок «расписание → тик». Расписание и обход —
 * заглушки: настоящий тик на общей базе забрал бы прогоны других наборов.
 */

import { randomUUID } from 'crypto';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  describeDb,
  testPrisma,
} from '../../site-crawl/testing/crawl-db.testing';
import type { SiteCrawlService } from '../../site-crawl/crawl.service';
import type { AssistCrawlScheduler } from '../crawl-scheduler.service';
import { AssistCrawlRunController } from './assist-crawl-run.controller';

describeDb('AssistCrawlRunController (реальный Postgres)', () => {
  let prisma: PrismaService;
  const secret = `s-${randomUUID()}`;
  const env = { ...process.env };

  beforeAll(() => {
    prisma = testPrisma();
    process.env.CRON_SECRET = secret;
  });
  afterAll(async () => {
    process.env = env;
    await prisma.siteCronLock.deleteMany({
      where: { jobKey: 'assist-crawl-run' },
    });
    await prisma.$disconnect();
  });

  function make(delayMs = 0) {
    const calls: string[] = [];
    let entered: () => void = () => undefined;
    const started = new Promise<void>((r) => (entered = r));
    const scheduler = {
      scheduleDue: jest.fn(async () => {
        calls.push('schedule');
        entered();
        return { runsRequested: 1, hotRunsRequested: 0 };
      }),
    } as unknown as AssistCrawlScheduler;
    const crawl = {
      tick: jest.fn(async (budget: number) => {
        calls.push(`tick:${budget}`);
        await new Promise((r) => setTimeout(r, delayMs));
        return {
          runsTouched: 1,
          pagesFetched: 3,
          pagesChanged: 1,
          finishedRunIds: [],
          budgetExhausted: false,
        };
      }),
    } as unknown as SiteCrawlService;
    return {
      ctrl: new AssistCrawlRunController(prisma, scheduler, crawl),
      calls,
      started,
    };
  }

  it('без верного секрета — 401, ничего не запускается', async () => {
    const { ctrl, calls } = make();
    await expect(ctrl.run('Bearer wrong')).rejects.toMatchObject({
      status: 401,
    });
    await expect(ctrl.run(undefined)).rejects.toMatchObject({ status: 401 });
    expect(calls).toEqual([]);
  });

  it('расписание, затем тик с бюджетом CRAWL_DEFAULTS; параллельный вызов — ran:false', async () => {
    const a = make(150);
    const b = make();
    const [ra, rb] = await Promise.all([
      a.ctrl.run(`Bearer ${secret}`),
      // Второй вызов — когда первый уже внутри замка.
      a.started.then(() => b.ctrl.run(`Bearer ${secret}`)),
    ]);
    expect(ra).toMatchObject({
      ran: true,
      schedule: { runsRequested: 1 },
      tick: { pagesFetched: 3 },
    });
    expect(a.calls).toEqual(['schedule', 'tick:45000']);
    expect(rb).toEqual({ ran: false });
    expect(b.calls).toEqual([]);
    // Замок снят — следующий тик идёт.
    expect((await b.ctrl.run(`Bearer ${secret}`)).ran).toBe(true);
  });
});
