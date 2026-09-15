/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * PostprodVideosService — список «моих готовых роликов» (этап 88).
 * `selectPostprodVideoSummaries`/`countPostprodVideoSummaries` сами уже
 * покрыты postprod-video-summary.spec.ts (форма SQL) — здесь проверяем
 * только маппинг строки в `PostprodVideoSummary` (особенно `canRevoice`
 * и пагинацию), мокая обе функции напрямую.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../common/postprod-video-summary', () => ({
  selectPostprodVideoSummaries: jest.fn(),
  countPostprodVideoSummaries: jest.fn(),
}));

import { PostprodVideosService } from './postprod-videos.service';
import {
  countPostprodVideoSummaries,
  selectPostprodVideoSummaries,
  PostprodVideoSummaryRow,
} from '../../common/postprod-video-summary';

const selectMock = selectPostprodVideoSummaries as jest.Mock;
const countMock = countPostprodVideoSummaries as jest.Mock;

function row(overrides: Partial<PostprodVideoSummaryRow> = {}) {
  const base: PostprodVideoSummaryRow = {
    sessionId: 'sess-1',
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    lastActivityAt: new Date('2026-09-01T10:05:00.000Z'),
    productName: 'Термокружка',
    generatedVideoId: 'video-1',
    downloadUrl: 'https://cdn.example/video-1.mp4',
    renderedUrl: null,
    postStatus: 'complete',
    voiceMode: 'voiceover',
    aspectRatio: '9:16',
    quality: null,
    provider: 'grok',
    resolution: '1080p',
  };
  return { ...base, ...overrides };
}

describe('PostprodVideosService.listFinishedVideos', () => {
  beforeEach(() => {
    selectMock.mockReset();
    countMock.mockReset();
  });

  it('voiceMode voiceover/dub → canRevoice=true, veo → false', async () => {
    selectMock.mockResolvedValue([
      row({ sessionId: 's-voiceover', voiceMode: 'voiceover' }),
      row({ sessionId: 's-dub', voiceMode: 'dub' }),
      row({ sessionId: 's-veo', voiceMode: 'veo' }),
      // Старый ролик до введения voiceMode — мусор в JSON-пути не должен падать.
      row({ sessionId: 's-null', voiceMode: null }),
    ]);
    countMock.mockResolvedValue(4);

    const service = new PostprodVideosService({} as any);
    const result = await service.listFinishedVideos('user-1', 1, 20);

    const bySessionId = Object.fromEntries(
      result.items.map((i) => [i.sessionId, i]),
    );
    expect(bySessionId['s-voiceover'].canRevoice).toBe(true);
    expect(bySessionId['s-dub'].canRevoice).toBe(true);
    expect(bySessionId['s-veo'].canRevoice).toBe(false);
    expect(bySessionId['s-null'].canRevoice).toBe(false);
    expect(bySessionId['s-null'].voiceMode).toBeNull();
  });

  it('page/pageSize → skip передаётся в select, total/page/pageSize возвращаются как есть', async () => {
    selectMock.mockResolvedValue([]);
    countMock.mockResolvedValue(57);

    const service = new PostprodVideosService({} as any);
    const result = await service.listFinishedVideos('user-1', 3, 20);

    expect(selectMock).toHaveBeenCalledWith({}, 'user-1', 40, 20);
    expect(countMock).toHaveBeenCalledWith({}, 'user-1');
    expect(result).toEqual({ items: [], total: 57, page: 3, pageSize: 20 });
  });

  // Найдено доп. аудитом (HIGH) — см. доккомментарий listFinishedVideos:
  // явный offset должен перекрывать расчёт по page (та же ситуация,
  // после локального удаления строки на клиенте, что и вызывает баг без
  // этого параметра).
  it('явный offset перекрывает расчёт (page - 1) * pageSize', async () => {
    selectMock.mockResolvedValue([]);
    countMock.mockResolvedValue(19);

    const service = new PostprodVideosService({} as any);
    const result = await service.listFinishedVideos('user-1', 2, 20, 19);

    expect(selectMock).toHaveBeenCalledWith({}, 'user-1', 19, 20);
    expect(result).toEqual({ items: [], total: 19, page: 2, pageSize: 20 });
  });

  it('даты сериализуются в ISO-строки', async () => {
    selectMock.mockResolvedValue([row()]);
    countMock.mockResolvedValue(1);

    const service = new PostprodVideosService({} as any);
    const result = await service.listFinishedVideos('user-1', 1, 20);

    expect(result.items[0].createdAt).toBe('2026-09-01T10:00:00.000Z');
  });
});
