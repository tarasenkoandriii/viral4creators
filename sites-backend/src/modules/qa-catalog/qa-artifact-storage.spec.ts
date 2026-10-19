import { put } from '@vercel/blob';
import { QaArtifactStorage } from './qa-artifact.service';
import { QA_TEST_PNG } from './qa-artifact-fixture.testing';
jest.mock('@vercel/blob', () => ({ put: jest.fn().mockResolvedValue({}) }));
it('uploads only privately with a bounded abort signal and no overwrite', async () => {
  const previous = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = 'synthetic-test-token';
  try {
    await new QaArtifactStorage().put(
      'qa-evidence/test/a.png',
      QA_TEST_PNG,
      'image/png',
    );
    expect(put).toHaveBeenCalledWith(
      'qa-evidence/test/a.png',
      QA_TEST_PNG,
      expect.objectContaining({
        access: 'private',
        allowOverwrite: false,
        addRandomSuffix: false,
        contentType: 'image/png',
        abortSignal: expect.any(AbortSignal),
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previous;
  }
});
