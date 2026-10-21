import { compileFfmpegReviewDraft } from './ffmpeg-review-draft';

const sha = 'a'.repeat(64);
const outputSha = 'b'.repeat(64);
const document = () => ({
  sourceInputKey: 'original',
  sourceSha256: sha,
  outputSha256: outputSha,
  recipe: { targetAspectRatio: '4:5' },
  suggestions: [
    {
      parameter: 'targetAspectRatio',
      value: 'native',
      reason: 'Restore source framing',
    },
  ],
  selectedParameters: ['targetAspectRatio'],
});
const job = () => ({
  execution_status: 'succeeded',
  expires_at: '2030-01-01T00:00:00Z',
  inputs_metadata: [
    {
      key: 'original',
      mime: 'video/mp4',
      sha256: sha,
      streams: [{ type: 'video' }],
    },
  ],
  artifacts: [{ name: 'out.mp4', mime: 'video/mp4', sha256: outputSha }],
});
const compile = (doc: unknown = document(), source: unknown = job()) =>
  compileFfmpegReviewDraft(
    'test',
    'out.mp4',
    doc,
    source,
    Date.parse('2026-10-21'),
  );
describe('source-bound FFmpeg review draft', () => {
  it('compiles selected safe change from original and binds both hashes', () => {
    const result = compile();
    expect(result.manifest.recipe.targetAspectRatio).toBeUndefined();
    expect(result.manifest.source.sha256).toBe(sha);
    expect(result.manifest.reviewedOutput.sha256).toBe(outputSha);
    expect(result.manifest.renderFromOriginalOnly).toBe(true);
    expect(result.manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(compile()).toEqual(result);
  });
  it.each(['sourceSha256', 'outputSha256'])('rejects stale %s', (key) => {
    expect(() => compile({ ...document(), [key]: 'c'.repeat(64) })).toThrow(
      'SHA-256',
    );
  });
  it.each([
    { purged_at: 'now' },
    { expires_at: '2020-01-01' },
    { execution_status: 'running' },
  ])('rejects unavailable result %j', (patch) => {
    expect(() => compile(document(), { ...job(), ...patch })).toThrow();
  });
  it('rejects ambiguous source and audio-only inputs', () => {
    const source = job();
    source.inputs_metadata.push(source.inputs_metadata[0]);
    expect(() => compile(document(), source)).toThrow();
    source.inputs_metadata = [
      {
        key: 'original',
        mime: 'video/mp4',
        sha256: sha,
        streams: [{ type: 'audio' }],
      },
    ];
    expect(() => compile(document(), source)).toThrow();
    const artwork = job();
    artwork.inputs_metadata[0].mime = 'audio/mpeg';
    expect(() => compile(document(), artwork)).toThrow();
  });
  it('rejects arbitrary command, unsafe style and unapproved suggestion', () => {
    expect(() => compile({ ...document(), command: 'shell' })).toThrow();
    expect(() =>
      compile({
        ...document(),
        recipe: { subtitleForceStyle: 'FontName=/secret' },
      }),
    ).toThrow();
    expect(() =>
      compile({ ...document(), selectedParameters: ['command'] }),
    ).toThrow();
  });
  it('does not apply unselected recommendations', () => {
    expect(
      compile({ ...document(), selectedParameters: [] }).manifest.recipe
        .targetAspectRatio,
    ).toBe('4:5');
  });
});
