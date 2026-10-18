import { TutorialDemoQualityService } from './demo-quality.service';

describe('quality queue read-only status', () => {
  function build() {
    const checks = {
      groupBy: jest.fn().mockResolvedValue([
        { status: 'pending', phase: 'upload', _count: { _all: 15 } },
        { status: 'error', phase: 'analyze', _count: { _all: 2 } },
      ]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest
        .fn()
        .mockResolvedValue({ createdAt: new Date('2026-10-12T00:00:00Z') }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    };
    const provider = { analyze: jest.fn(), uploadFile: jest.fn() };
    const service = new TutorialDemoQualityService(
      { tutorialDemoQualityCheck: checks } as never,
      {} as never,
      provider as never,
      {} as never,
      {} as never,
    );
    service.clock = () => Date.parse('2026-10-18T08:00:00Z');
    return { service, checks, provider };
  }
  it('reports deferred backlog even when no check is due, without claiming or paying', async () => {
    const { service, checks, provider } = build();
    const state = await service.queueStatus();
    expect(state.due).toBe(0);
    expect(state.groups[0].count).toBe(15);
    expect(state.oldestOpenAt).toBe('2026-10-12T00:00:00.000Z');
    expect(checks.count).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            status: 'pending',
            OR: [
              { nextAttemptAt: null },
              { nextAttemptAt: { lte: new Date('2026-10-18T08:00:00Z') } },
            ],
          },
          {
            status: 'running',
            leaseUntil: { lt: new Date('2026-10-18T08:00:00Z') },
          },
        ],
      },
    });
    expect(checks.updateMany).not.toHaveBeenCalled();
    expect(provider.analyze).not.toHaveBeenCalled();
    expect(provider.uploadFile).not.toHaveBeenCalled();
  });
  it('propagates database failure instead of pretending the queue is empty', async () => {
    const { service, checks } = build();
    checks.groupBy.mockRejectedValue(new Error('db unavailable'));
    await expect(service.queueStatus()).rejects.toThrow('db unavailable');
  });
});
