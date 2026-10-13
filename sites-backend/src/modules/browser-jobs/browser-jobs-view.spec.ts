import { BrowserJobsService } from './browser-jobs.service';

describe('browser job result visibility', () => {
  const view = BrowserJobsService.prototype.toView;
  const row = (result: unknown) =>
    ({ status: 'done', result, finishedAt: new Date() }) as Parameters<
      typeof view
    >[0];

  it('keeps clients polling while the product handler persists its result', () => {
    const result = view.call({} as BrowserJobsService, row({ pending: true }));
    expect(result).toMatchObject({
      status: 'running',
      result: null,
      finishedAt: null,
    });
  });

  it('exposes the completed snapshot after the handler finishes', () => {
    const snapshot = { snapshot: { title: 'Sandbox', elements: [] } };
    const result = view.call({} as BrowserJobsService, row(snapshot));
    expect(result.status).toBe('done');
    expect(result.result).toEqual(snapshot);
    expect(result.finishedAt).toBeInstanceOf(Date);
  });
});
