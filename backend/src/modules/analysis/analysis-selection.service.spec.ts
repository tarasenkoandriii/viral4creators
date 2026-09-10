jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { AnalysisSelectionService } from './analysis-selection.service';

const session = {
  sessionId: 's1',
  videoAnalysis: {
    scenes: [{ id: 's1', start: 0, end: 2, title: 'a', previewAt: 1 }],
    extras: [{ id: 'e1', label: 'crowd', description: 'd' }],
  },
};
function build() {
  const sessions = {
    getSession: jest.fn().mockResolvedValue(session),
    updateSession: jest.fn().mockResolvedValue(undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { svc: new AnalysisSelectionService(sessions as any), sessions };
}

describe('AnalysisSelectionService', () => {
  it('get: resolved rows, null updatedAt before any PUT', async () => {
    const { svc } = build();
    const v = await svc.get('s1');
    expect(v.scenes[0].active).toBe(true);
    expect(v.extras[0].active).toBe(true);
    expect(v.updatedAt).toBeNull();
  });
  it('put: validates ids against the analysis, dedupes, stores', async () => {
    const { svc, sessions } = build();
    const v = await svc.put('s1', {
      droppedScenes: ['s1', 's1'],
      droppedExtras: [],
    });
    expect(v.scenes[0].active).toBe(false);
    expect(
      sessions.updateSession.mock.calls[0][1].analysisSelection.droppedScenes,
    ).toEqual(['s1']);
    await expect(
      svc.put('s1', { droppedScenes: ['s9'], droppedExtras: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.put('s1', { droppedScenes: [], droppedExtras: ['e7'] }),
    ).rejects.toThrow(/extras group/);
  });
});
