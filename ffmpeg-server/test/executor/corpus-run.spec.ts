/**
 * Весь корпус команд платформы на настоящем ffmpeg: синтетические входы
 * (lavfi testsrc/sine тем же ffmpeg), разбор parseJob → executor →
 * verifyOutputs. Story-сегменты со стемами прогоняются в executor.spec.ts.
 */
import { loadCorpus } from '../fixtures/corpus';
import { PILOT_LIMITS } from '../fixtures/limits';
import { verifyOutputs } from '../../src/probe/outputs';
import {
  Harness,
  MediaLib,
  makeHarness,
  mustParse,
  runToDone,
  startPlan,
} from './harness';

jest.setTimeout(300_000);

const SKIP = new Set([
  'story/stems-music-ducking-effects',
  'story/segments-recorded-narrator-note-outro',
]);

let h: Harness;
let lib: MediaLib;

beforeAll(async () => {
  h = makeHarness();
  lib = new MediaLib();
  await h.executor.init({ capabilities: false });
});

afterAll(async () => {
  await h.executor.shutdown();
  h.cleanup();
  lib.cleanup();
});

describe('корпус на настоящем ffmpeg', () => {
  it.each(
    loadCorpus()
      .filter((e) => !SKIP.has(e.id))
      .map((e) => [e.id, e] as const),
  )('%s', async (_id, e) => {
    const plan = mustParse(e.request);
    const a = await startPlan(h, plan, lib, { text: e.textInputs });
    const done = await runToDone(h, a.attemptId);
    if (done.outcome !== 'succeeded')
      throw new Error(`${done.outcome}: ${done.stderrTail.slice(-2000)}`);
    expect(done.stderrTail).not.toMatch(
      /Glyph 0x|failed to find any fallback/i,
    );
    const v = await verifyOutputs(a.dir, plan.outputs, PILOT_LIMITS);
    if (!v.ok) throw new Error(`${v.code}: ${v.message}`);
    expect(v.files.map((f) => f.name)).toEqual(e.request.output_files);
  });
});
