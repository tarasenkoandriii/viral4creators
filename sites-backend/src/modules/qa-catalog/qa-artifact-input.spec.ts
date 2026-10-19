import { randomUUID, createHash } from 'node:crypto';
import { cleanEvidencePng, parseArtifactUpload } from './qa-artifact-input';
import {
  QA_TEST_PNG,
  QA_TEST_METADATA_PNG,
} from './qa-artifact-fixture.testing';
describe('QA evidence PNG boundary', () => {
  const body = () => ({
    requestId: randomUUID(),
    contentType: 'image/png',
    contentBase64: QA_TEST_PNG.toString('base64'),
    redacted: true,
  });
  it('strips ancillary metadata and hashes only the validated stored bytes', () => {
    const clean = cleanEvidencePng(QA_TEST_METADATA_PNG);
    expect(clean).toEqual(QA_TEST_PNG);
    expect(clean.toString()).not.toContain('PRIVATE_METADATA');
    expect(parseArtifactUpload(body()).bytes).toEqual(clean);
    expect(createHash('sha256').update(clean).digest('hex')).toHaveLength(64);
  });
  it.each(['html', 'crc', 'trailing', 'oversize', 'truncated'])(
    'rejects %s',
    (kind) => {
      let image = Buffer.from(QA_TEST_PNG);
      if (kind === 'html') image = Buffer.from('<svg onload="alert(1)"/>');
      if (kind === 'crc') image[45] ^= 1;
      if (kind === 'trailing')
        image = Buffer.concat([image, Buffer.from('<script>')]);
      if (kind === 'oversize') image = Buffer.alloc(2097153);
      if (kind === 'truncated') image = image.subarray(0, 30);
      expect(() => cleanEvidencePng(image)).toThrow();
    },
  );
  it.each([
    { redacted: false },
    { contentType: 'image/jpeg' },
    { requestId: '../x' },
    { contentBase64: 'data:image/png;base64,abcd' },
    { accountId: 'other' },
  ])('rejects unconfirmed, unsupported or caller-owned fields %p', (extra) => {
    expect(() => parseArtifactUpload({ ...body(), ...extra })).toThrow();
  });
});
