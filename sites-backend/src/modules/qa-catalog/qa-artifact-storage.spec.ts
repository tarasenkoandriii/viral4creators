import { get, put } from '@vercel/blob';
import { QaArtifactStorage } from './qa-artifact.service';
import { QA_TEST_PNG } from './qa-artifact-fixture.testing';
jest.mock('@vercel/blob', () => ({
  put: jest.fn().mockResolvedValue({}),
  get: jest.fn(),
}));
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

it('reads privately with a byte bound and timeout, rejects missing content', async () => {
  const previous = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = 'synthetic';
  try {
    jest.mocked(get).mockResolvedValue({
      statusCode: 200,
      blob: { size: QA_TEST_PNG.length },
      stream: new ReadableStream({
        start(c) {
          c.enqueue(QA_TEST_PNG);
          c.close();
        },
      }),
    } as never);
    expect(
      await new QaArtifactStorage().read('qa-evidence/test/a.png'),
    ).toEqual(QA_TEST_PNG);
    expect(get).toHaveBeenCalledWith(
      'qa-evidence/test/a.png',
      expect.objectContaining({
        access: 'private',
        useCache: false,
        abortSignal: expect.any(AbortSignal),
      }),
    );
    jest.mocked(get).mockResolvedValue(null);
    await expect(
      new QaArtifactStorage().read('qa-evidence/test/a.png'),
    ).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previous;
  }
});
