import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import {
  decodeEntities,
  mergeResults,
  YoutubeSearchService,
} from './youtube-search.service';

/** Учёт расходов (ТЗ §26) — в тестах он ничего не должен делать. */
/** Блокировка (ТЗ §25.3) — по умолчанию пользователь не заблокирован. */
const accessMock = () => ({
  // §26.4: дневной лимит по умолчанию не выбран.
  assertCanSpendUser: jest.fn(),
  assertCanSpendSession: jest.fn(),
  accessOf: jest.fn().mockResolvedValue({
    plan: 'PREMIUM',
    isBlocked: false,
    blockedReason: null,
  }),
  assertNotBlocked: jest.fn(),
  assertUserNotBlocked: jest.fn(),
  assertSessionNotBlocked: jest.fn(),
  assertUser: jest.fn(),
  assertSession: jest.fn(),
  planOfUser: jest.fn().mockResolvedValue('PREMIUM'),
  planOfSession: jest.fn().mockResolvedValue('PREMIUM'),
});

const usageMock = () => ({
  record: jest.fn(),
  recordGemini: jest.fn(),
  recordOpenAi: jest.fn(),
});

jest.mock('axios');
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
const mockedAxios = axios as jest.Mocked<typeof axios>;

const configState = { apiKey: 'key-1' };
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({
    youtube: { apiKey: configState.apiKey, searchDailyLimitPerUser: 20 },
  }),
}));

const searchItems = [
  {
    id: { kind: 'youtube#video', videoId: 'v1' },
    snippet: {
      title: 'Best running shoes &amp; socks',
      channelTitle: 'Run &#39;n&#39; Go',
      channelId: 'c1',
      publishedAt: '2026-01-01T00:00:00Z',
      thumbnails: {
        default: { url: 'https://i.ytimg.com/vi/v1/default.jpg' },
        medium: { url: 'https://i.ytimg.com/vi/v1/mqdefault.jpg' },
      },
    },
  },
  {
    id: { kind: 'youtube#video', videoId: 'v2' },
    snippet: { title: 'No stats video', channelTitle: 'X', channelId: 'c2' },
  },
  {
    id: { kind: 'youtube#channel', channelId: 'c9' },
    snippet: { title: 'chan' },
  },
];
const videoItems = [
  {
    id: 'v1',
    contentDetails: { duration: 'PT4M13S' },
    statistics: { viewCount: '12345', likeCount: '678' },
  },
];

describe('mergeResults', () => {
  it('joins search + stats by id, keeps search order, skips non-videos', () => {
    const rows = mergeResults(searchItems, videoItems);
    expect(rows.map((r) => r.videoId)).toEqual(['v1', 'v2']);
    expect(rows[0]).toEqual({
      videoId: 'v1',
      url: 'https://www.youtube.com/watch?v=v1',
      title: 'Best running shoes & socks',
      channelTitle: "Run 'n' Go",
      channelId: 'c1',
      publishedAt: '2026-01-01T00:00:00Z',
      thumbnailUrl: 'https://i.ytimg.com/vi/v1/mqdefault.jpg',
      durationSeconds: 253,
      durationLabel: '4:13',
      viewCount: 12345,
      likeCount: 678,
    });
    // Missing from videos.list → nulls, not dropped.
    expect(rows[1]).toMatchObject({
      videoId: 'v2',
      thumbnailUrl: null,
      durationSeconds: null,
      durationLabel: null,
      viewCount: null,
      likeCount: null,
      publishedAt: '',
    });
  });

  it('hidden like counts come through as null', () => {
    const rows = mergeResults(
      [searchItems[0]],
      [
        {
          id: 'v1',
          contentDetails: { duration: 'PT1M' },
          statistics: { viewCount: '5' },
        },
      ],
    );
    expect(rows[0].likeCount).toBeNull();
    expect(rows[0].viewCount).toBe(5);
  });
});

describe('decodeEntities', () => {
  it('decodes the entities search.list is known to emit', () => {
    expect(
      decodeEntities(
        'a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &apos;f&apos;',
      ),
    ).toBe("a & b <c> \"d\" 'e' 'f'");
  });
});

function build(
  usageOverrides: Partial<
    Record<'reserve' | 'canSearch' | 'status', unknown>
  > = {},
) {
  const usage = {
    // Б-1.9: слот занимается атомарно до обращения к Google.
    reserve: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(undefined),
    canSearch: jest.fn().mockResolvedValue(true),
    status: jest.fn().mockResolvedValue({ used: 3, limit: 20, remaining: 17 }),
    recordSearch: jest.fn().mockResolvedValue(undefined),
    ...usageOverrides,
  };
  const aiUsage = usageMock();
  const service = new YoutubeSearchService(
    usage as never,
    aiUsage as never,
    accessMock() as never,
  );
  return { service, usage, aiUsage };
}

const axiosError = (status: number, reason?: string, code?: string) =>
  Object.assign(new Error('boom'), {
    isAxiosError: true,
    code,
    response: status
      ? {
          status,
          data: {
            error: {
              code: status,
              message: 'm',
              errors: reason ? [{ reason }] : [],
            },
          },
        }
      : undefined,
  });

describe('YoutubeSearchService.search', () => {
  beforeEach(() => {
    configState.apiKey = 'key-1';
    mockedAxios.get.mockReset();
  });

  it('503s without a key and never touches the usage counter', async () => {
    configState.apiKey = '';
    const { service, usage } = build();
    await expect(service.search('u1', 'shoes')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(usage.reserve).not.toHaveBeenCalled();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('429s when the per-user daily cap is reached, before any paid call', async () => {
    const { service } = build({
      reserve: jest.fn().mockResolvedValue(false),
      status: jest
        .fn()
        .mockResolvedValue({ used: 20, limit: 20, remaining: 0 }),
    });
    const err = await service.search('u1', 'shoes').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).message).toMatch(/20\/20/);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('calls search.list then videos.list once with all ids, counts one search', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { items: searchItems } })
      .mockResolvedValueOnce({ data: { items: videoItems } });
    const { service, usage } = build();
    const res = await service.search('u1', '  running shoes ', {
      regionCode: 'ua',
      language: 'uk',
    });

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    const [searchUrl, searchCfg] = mockedAxios.get.mock.calls[0];
    expect(searchUrl).toBe('https://www.googleapis.com/youtube/v3/search');
    expect(searchCfg?.params).toEqual({
      part: 'snippet',
      type: 'video',
      maxResults: '50',
      q: 'running shoes',
      regionCode: 'UA',
      relevanceLanguage: 'uk',
      key: 'key-1',
    });
    const [videosUrl, videosCfg] = mockedAxios.get.mock.calls[1];
    expect(videosUrl).toBe('https://www.googleapis.com/youtube/v3/videos');
    expect(videosCfg?.params).toMatchObject({
      part: 'statistics,contentDetails',
      id: 'v1,v2',
    });

    expect(usage.reserve).toHaveBeenCalledTimes(1);
    expect(usage.release).not.toHaveBeenCalled();
    expect(res.query).toBe('running shoes');
    expect(res.results).toHaveLength(2);
    expect(res.results[0].durationLabel).toBe('4:13');
    expect(res.usage).toEqual({ used: 3, limit: 20, remaining: 17 });
  });

  it('omits region/language params when not given and skips videos.list on zero hits', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { items: [] } });
    const { service, usage } = build();
    const res = await service.search('u1', 'zzz');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get.mock.calls[0][1]?.params).not.toHaveProperty(
      'regionCode',
    );
    expect(res.results).toEqual([]);
    // Google answered search.list → still one unit of the user's allowance.
    expect(usage.reserve).toHaveBeenCalledTimes(1);
    expect(usage.release).not.toHaveBeenCalled();
  });

  it('degrades to rows without stats when videos.list fails', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { items: searchItems } })
      .mockRejectedValueOnce(axiosError(500));
    const { service } = build();
    const res = await service.search('u1', 'shoes');
    expect(res.results).toHaveLength(2);
    expect(res.results[0].viewCount).toBeNull();
    expect(res.results[0].title).toBe('Best running shoes & socks');
  });

  it('does not count a search Google refused; maps quotaExceeded to 429', async () => {
    mockedAxios.get.mockRejectedValueOnce(axiosError(403, 'quotaExceeded'));
    const { service, usage } = build();
    const err = await service.search('u1', 'shoes').catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).message).toMatch(/quota/i);
    // Слот был занят до запроса и возвращён после отказа Google:
    // чужая авария не должна съедать суточную квоту пользователя.
    expect(usage.reserve).toHaveBeenCalledTimes(1);
    expect(usage.release).toHaveBeenCalledWith('u1');
  });

  it('ответ Google, который он тарифицирует (400), слот НЕ возвращает; сеть — возвращает (этап 54, В-2.15)', async () => {
    mockedAxios.get.mockRejectedValueOnce(axiosError(400, 'keyInvalid'));
    const { service, usage } = build();
    await service.search('u1', 'shoes').catch(() => undefined);
    // Google считает и неверные запросы — возвращать слот значило бы
    // разрешить перебор на ошибках.
    expect(usage.release).not.toHaveBeenCalled();

    mockedAxios.get.mockRejectedValueOnce(
      axiosError(0, undefined, 'ECONNRESET'),
    );
    await service.search('u1', 'shoes').catch(() => undefined);
    expect(usage.release).toHaveBeenCalledTimes(1);
  });

  it('videos.list виден в журнале как второй вызов той же операции (В-2.15)', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { items: searchItems } })
      .mockResolvedValueOnce({ data: { items: [] } });
    const { service, aiUsage } = build();
    await service.search('u1', 'shoes');
    expect(aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'video-search', calls: 2 }),
    );
    // Один слот квоты пользователя на пару вызовов: videos.list без
    // поиска не бывает и стоит у Google 1 единицу против 100.
  });

  it('maps a bad key to 503 and network trouble to 502', async () => {
    mockedAxios.get.mockRejectedValueOnce(axiosError(400, 'keyInvalid'));
    const { service } = build();
    const bad = await service.search('u1', 'shoes').catch((e) => e);
    expect((bad as HttpException).getStatus()).toBe(503);
    expect((bad as HttpException).message).toMatch(/YOUTUBE_API_KEY/);

    mockedAxios.get.mockRejectedValueOnce(
      axiosError(0, undefined, 'ECONNRESET'),
    );
    const net = await service.search('u1', 'shoes').catch((e) => e);
    expect((net as HttpException).getStatus()).toBe(502);
    expect((net as HttpException).message).toMatch(/ECONNRESET/);
  });
});
