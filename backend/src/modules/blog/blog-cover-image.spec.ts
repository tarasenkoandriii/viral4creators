jest.mock('../../common/fetch-with-retry', () => ({
  fetchWithRetry: jest.fn(),
}));

import { fetchWithRetry } from '../../common/fetch-with-retry';
import { downloadAndUploadBlogCoverImage } from './blog-cover-image';

const fetchWithRetryMock = fetchWithRetry as jest.Mock;

function imageResponse(
  opts: {
    ok?: boolean;
    status?: number;
    contentType?: string;
    bytes?: number;
  } = {},
) {
  const size = opts.bytes ?? 5000;
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type'
          ? (opts.contentType ?? 'image/jpeg')
          : null,
    },
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as Response;
}

function fakeBlob(overrides: { uploadBuffer?: jest.Mock } = {}) {
  return {
    uploadBuffer:
      overrides.uploadBuffer ??
      jest.fn().mockResolvedValue({
        url: 'https://blob.vercel-storage.com/blog/some-slug.jpg',
      }),
  } as never;
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('downloadAndUploadBlogCoverImage', () => {
  it('скачивает и перезаливает в Blob — возвращает свой URL и исходный sourceImageUrl', async () => {
    fetchWithRetryMock.mockResolvedValue(
      imageResponse({ contentType: 'image/jpeg' }),
    );
    const uploadBuffer = jest.fn().mockResolvedValue({
      url: 'https://blob.vercel-storage.com/blog/my-post.jpg',
    });

    const result = await downloadAndUploadBlogCoverImage(
      'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
      'my-post',
      fakeBlob({ uploadBuffer }),
    );

    expect(result).toEqual({
      thumbnailUrl: 'https://blob.vercel-storage.com/blog/my-post.jpg',
      sourceImageUrl: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
    });
    expect(uploadBuffer).toHaveBeenCalledWith(
      'blog/my-post.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
  });

  it('определяет расширение по content-type для png/webp/gif', async () => {
    const cases: Array<[string, string]> = [
      ['image/png', 'png'],
      ['image/webp', 'webp'],
      ['image/gif', 'gif'],
    ];
    for (const [contentType, ext] of cases) {
      fetchWithRetryMock.mockResolvedValue(imageResponse({ contentType }));
      const uploadBuffer = jest.fn().mockResolvedValue({
        url: `https://blob.vercel-storage.com/blog/slug.${ext}`,
      });

      await downloadAndUploadBlogCoverImage(
        'https://example.com/img',
        'slug',
        fakeBlob({ uploadBuffer }),
      );

      expect(uploadBuffer).toHaveBeenCalledWith(
        `blog/slug.${ext}`,
        expect.any(Buffer),
        contentType,
      );
    }
  });

  it('content-type не подсказал — берёт расширение из самого URL', async () => {
    fetchWithRetryMock.mockResolvedValue(
      imageResponse({ contentType: 'application/octet-stream' }),
    );
    const uploadBuffer = jest.fn().mockResolvedValue({
      url: 'https://blob.vercel-storage.com/blog/slug.png',
    });

    await downloadAndUploadBlogCoverImage(
      'https://example.com/cover.PNG?w=800',
      'slug',
      fakeBlob({ uploadBuffer }),
    );

    expect(uploadBuffer).toHaveBeenCalledWith(
      'blog/slug.png',
      expect.any(Buffer),
      'application/octet-stream',
    );
  });

  it('ни content-type, ни URL не подсказали расширение — откатывается на jpg', async () => {
    fetchWithRetryMock.mockResolvedValue(
      imageResponse({ contentType: 'application/octet-stream' }),
    );
    const uploadBuffer = jest.fn().mockResolvedValue({
      url: 'https://blob.vercel-storage.com/blog/slug.jpg',
    });

    await downloadAndUploadBlogCoverImage(
      'https://example.com/cover',
      'slug',
      fakeBlob({ uploadBuffer }),
    );

    expect(uploadBuffer).toHaveBeenCalledWith(
      'blog/slug.jpg',
      expect.any(Buffer),
      'application/octet-stream',
    );
  });

  it('скачивание бросает сетевую ошибку — мягкий откат на исходный URL, Blob не трогается', async () => {
    fetchWithRetryMock.mockRejectedValue(new Error('network down'));
    const uploadBuffer = jest.fn();

    const result = await downloadAndUploadBlogCoverImage(
      'https://example.com/cover.jpg',
      'slug',
      fakeBlob({ uploadBuffer }),
    );

    expect(result).toEqual({
      thumbnailUrl: 'https://example.com/cover.jpg',
      sourceImageUrl: 'https://example.com/cover.jpg',
    });
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('скачивание отдаёт не-ok статус — мягкий откат на исходный URL', async () => {
    fetchWithRetryMock.mockResolvedValue(
      imageResponse({ ok: false, status: 404 }),
    );
    const uploadBuffer = jest.fn();

    const result = await downloadAndUploadBlogCoverImage(
      'https://example.com/gone.jpg',
      'slug',
      fakeBlob({ uploadBuffer }),
    );

    expect(result.thumbnailUrl).toBe('https://example.com/gone.jpg');
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('подозрительный размер (0 байт) — мягкий откат, Blob не трогается', async () => {
    fetchWithRetryMock.mockResolvedValue(imageResponse({ bytes: 0 }));
    const uploadBuffer = jest.fn();

    const result = await downloadAndUploadBlogCoverImage(
      'https://example.com/empty.jpg',
      'slug',
      fakeBlob({ uploadBuffer }),
    );

    expect(result.thumbnailUrl).toBe('https://example.com/empty.jpg');
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('подозрительный размер (аномально большой) — мягкий откат, Blob не трогается', async () => {
    fetchWithRetryMock.mockResolvedValue(
      imageResponse({ bytes: 20 * 1024 * 1024 }),
    );
    const uploadBuffer = jest.fn();

    const result = await downloadAndUploadBlogCoverImage(
      'https://example.com/huge.jpg',
      'slug',
      fakeBlob({ uploadBuffer }),
    );

    expect(result.thumbnailUrl).toBe('https://example.com/huge.jpg');
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('BlobService.uploadBuffer бросает — мягкий откат на исходный URL', async () => {
    fetchWithRetryMock.mockResolvedValue(imageResponse());
    const uploadBuffer = jest
      .fn()
      .mockRejectedValue(new Error('BLOB_READ_WRITE_TOKEN не задан'));

    const result = await downloadAndUploadBlogCoverImage(
      'https://example.com/cover.jpg',
      'slug',
      fakeBlob({ uploadBuffer }),
    );

    expect(result).toEqual({
      thumbnailUrl: 'https://example.com/cover.jpg',
      sourceImageUrl: 'https://example.com/cover.jpg',
    });
  });
});
