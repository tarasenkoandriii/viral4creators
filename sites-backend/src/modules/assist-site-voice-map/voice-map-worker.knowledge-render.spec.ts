/**
 * Ш3 (20): порт рендера SPA для обхода — коды очереди → решение обхода
 * (повторить на следующем тике / сегодня больше не ставить), итог задания
 * → страницы по НОМЕРУ адреса (адрес знает обход, не воркер).
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { BrowserJobView } from '../browser-jobs/browser-jobs.service';
import { knowledgeRenderPort } from './voice-map-worker.knowledge-render';

const req = {
  accountId: 'acc',
  siteId: 'site',
  hostId: 'host',
  host: 'shop.example.com',
  runId: 'run1',
  urls: ['https://shop.example.com/', 'https://shop.example.com/a'],
};

const err = (code: string) =>
  new HttpException({ error: code, code, message: code }, HttpStatus.CONFLICT);

function fakeJobs(over: Partial<Record<string, unknown>> = {}) {
  const calls: unknown[] = [];
  const jobs = {
    enabled: () => true,
    enqueue: async (_a: string, input: unknown) => {
      calls.push(input);
      return { id: 'job1' } as BrowserJobView;
    },
    view: async () => null as BrowserJobView | null,
    cancel: async () => undefined,
    dropResult: async (_a: string, id: string, where: unknown) => {
      calls.push({ drop: id, where });
    },
    health: async () => ({
      enabled: true,
      credentials: false,
      queued: 0,
      running: 0,
      lastHeartbeatAt: null as Date | null,
    }),
    ...over,
  };
  return { jobs, calls };
}

describe('порт рендера SPA (voice-map-worker.knowledge-render)', () => {
  it('ставит задание knowledge-render: замок — хост страницы, источник и refId прогона', async () => {
    const { jobs, calls } = fakeJobs();
    await expect(
      knowledgeRenderPort(jobs as never).request(req),
    ).resolves.toEqual({ jobId: 'job1' });
    expect(calls[0]).toMatchObject({
      siteId: 'site',
      hostId: 'host',
      origin: 'knowledge-render',
      refId: 'run1',
      params: {
        urls: req.urls,
        allowedHosts: ['shop.example.com'],
        viewport: 'desktop',
      },
    });
  });

  it.each([
    ['BROWSER_JOB_BUSY', { retry: true }],
    ['BROWSER_JOB_DAILY_LIMIT', { refused: 'limit' }],
    ['BROWSER_WORKER_DISABLED', { refused: 'disabled' }],
    ['BROWSER_JOB_HOST', { refused: 'host' }],
    ['WHATEVER', { refused: 'error' }],
  ])('код очереди %s → %j', async (code, want) => {
    const { jobs } = fakeJobs({
      enqueue: async () => {
        throw err(code);
      },
    });
    await expect(
      knowledgeRenderPort(jobs as never).request(req),
    ).resolves.toEqual(want);
  });

  it('воркер выключен или адресов больше потолка — не ставится', async () => {
    const off = fakeJobs({ enabled: () => false });
    await expect(
      knowledgeRenderPort(off.jobs as never).request(req),
    ).resolves.toEqual({ refused: 'disabled' });
    expect(off.calls).toHaveLength(0);
    const { jobs, calls } = fakeJobs();
    await expect(
      knowledgeRenderPort(jobs as never).request({
        ...req,
        urls: Array.from(
          { length: 5 },
          (_, i) => `https://shop.example.com/${i}`,
        ),
      }),
    ).resolves.toEqual({ refused: 'error' });
    expect(calls).toHaveLength(0);
  });

  it('итог: ждёт, пока идёт или пишется; сдано — страницы по номеру; иначе — failed', async () => {
    const view = (status: string, result: unknown) =>
      ({ id: 'job1', status, result }) as BrowserJobView;
    const at = (v: BrowserJobView | null) =>
      knowledgeRenderPort(fakeJobs({ view: async () => v }).jobs as never).poll(
        'acc',
        'job1',
      );
    await expect(at(view('queued', null))).resolves.toEqual({
      status: 'waiting',
      claimed: false,
    });
    await expect(at(view('running', null))).resolves.toEqual({
      status: 'waiting',
      claimed: true,
    });
    await expect(at(view('done', { pending: true }))).resolves.toEqual({
      status: 'waiting',
    });
    await expect(at(view('failed', null))).resolves.toEqual({
      status: 'failed',
    });
    await expect(at(null)).resolves.toEqual({ status: 'failed' });
    await expect(
      at(
        view('done', {
          pages: [
            { i: 1, ok: true, error: null, html: '<h1>A</h1>', links: ['x'] },
            { i: 0, ok: false, error: 'nav_timeout', html: null, links: [] },
          ],
        }),
      ),
    ).resolves.toEqual({
      status: 'done',
      pages: [
        { i: 1, ok: true, html: '<h1>A</h1>', links: ['x'] },
        { i: 0, ok: false, html: null, links: [] },
      ],
    });
  });

  it('разобранный итог стирается из очереди (только задания рендера); жив ли воркер — по свежему heartbeat', async () => {
    const { jobs, calls } = fakeJobs();
    const port = knowledgeRenderPort(jobs as never);
    await port.release('acc', 'job9');
    expect(calls).toEqual([
      { drop: 'job9', where: { origin: 'knowledge-render' } },
    ]);
    const now = new Date('2026-10-08T12:00:00Z');
    const at = (beat: Date | null, enabled = true) =>
      knowledgeRenderPort(
        fakeJobs({
          health: async () => ({
            enabled,
            credentials: false,
            queued: 1,
            running: 0,
            lastHeartbeatAt: beat,
          }),
        }).jobs as never,
        () => now,
      ).workerAlive(15 * 60_000);
    await expect(at(new Date(now.getTime() - 60_000))).resolves.toBe(true);
    await expect(at(new Date(now.getTime() - 16 * 60_000))).resolves.toBe(
      false,
    );
    await expect(at(null)).resolves.toBe(false);
    await expect(at(new Date(now.getTime()), false)).resolves.toBe(false);
  });
});
