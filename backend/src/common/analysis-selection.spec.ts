import {
  extrasBriefText,
  resolveSelection,
  scenesBriefText,
  selectableIds,
} from './analysis-selection';
import { AnalysisStatus, VideoAnalysis } from './types/analysis.types';

const analysis: VideoAnalysis = {
  analysisId: 'a',
  analyzedAt: new Date(),
  status: AnalysisStatus.COMPLETE,
  sceneBreakdown: '',
  scenes: [
    { id: 's1', start: 0, end: 2, title: 'Hook: shoes', previewAt: 1 },
    { id: 's2', start: 2, end: 5, title: 'Lacing', previewAt: 3 },
    { id: 's3', start: 5, end: 8, title: 'CTA', previewAt: 6 },
  ],
  extras: [
    { id: 'e1', label: 'Прохожие', description: 'размытые на фоне' },
    { id: 'e2', label: 'Очередь', description: 'у кассы, сцена 2' },
  ],
};

describe('analysis selection (§19)', () => {
  it('selectableIds / resolveSelection: everything active by default, dropped ids flip the flag', () => {
    expect([...selectableIds(analysis).scenes]).toEqual(['s1', 's2', 's3']);
    expect([...selectableIds(undefined).extras]).toEqual([]);
    const r = resolveSelection(analysis, {
      droppedScenes: ['s2'],
      droppedExtras: ['e1'],
      updatedAt: '',
    });
    expect(r.scenes.map((s) => [s.id, s.active])).toEqual([
      ['s1', true],
      ['s2', false],
      ['s3', true],
    ]);
    expect(r.extras.map((e) => [e.id, e.active])).toEqual([
      ['e1', false],
      ['e2', true],
    ]);
    expect(
      resolveSelection(analysis, undefined).scenes.every((s) => s.active),
    ).toBe(true);
  });

  it('scenesBriefText: silent when nothing dropped, otherwise DROP + KEEP with timecodes', () => {
    expect(scenesBriefText(analysis, undefined)).toBe('');
    const t = scenesBriefText(analysis, {
      droppedScenes: ['s2'],
      droppedExtras: [],
      updatedAt: '',
    });
    expect(t).toContain('SCENES TO DROP');
    expect(t).toContain('- 0:02–0:05 Lacing');
    expect(t).toContain(
      'SCENES TO KEEP (in this order): 0:00–0:02 Hook: shoes; 0:05–0:08 CTA.',
    );
  });

  it('extrasBriefText: kept described, dropped forbidden, empty without extras', () => {
    expect(extrasBriefText({ ...analysis, extras: [] }, undefined)).toBe('');
    const t = extrasBriefText(analysis, {
      droppedScenes: [],
      droppedExtras: ['e2'],
      updatedAt: '',
    });
    expect(t).toContain('- keep: Прохожие — размытые на фоне');
    expect(t).toContain(
      'remove (the background must be empty of them): Очередь.',
    );
  });
});
