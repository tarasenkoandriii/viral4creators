import { ModeKnowledgeCore } from '../modules/assist-knowledge-core/documents/mode-knowledge.core';

describe('source processing failures', () => {
  it('counts a failed source and continues processing the healthy source', async () => {
    const sys = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'bad', attempts: 0 },
        { id: 'good', attempts: 0 },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const core = Object.assign(Object.create(ModeKnowledgeCore.prototype), {
      adapter: { systemSources: () => sys },
      processOne: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    expect(await core.processPending(1000)).toEqual({
      processed: 2,
      failed: 1,
    });
    expect(core.processOne).toHaveBeenCalledTimes(2);
  });
  it('failed parsing schedules the existing retry and reports failure', async () => {
    const source = { update: jest.fn().mockResolvedValue({}) };
    const core = Object.assign(Object.create(ModeKnowledgeCore.prototype), {
      adapter: { rows: () => ({ source }) },
      logger: { warn: jest.fn() },
      processFile: jest.fn().mockRejectedValue(new Error('temporary failure')),
    });
    expect(
      await core.processOne(
        { id: 'bad', kind: 'file', accountId: 'a' },
        1,
        new Date(),
      ),
    ).toBe(false);
    expect(source.update).toHaveBeenCalledWith({
      where: { id: 'bad' },
      data: { error: null },
    });
  });
});
