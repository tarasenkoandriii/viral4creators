import { selectBlogCandidates } from './blog-candidate-selection';
import { YoutubeSearchResultView } from '../youtube-search/youtube-search.types';

function row(
  videoId: string,
  viewCount: number | null,
): YoutubeSearchResultView {
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: `title-${videoId}`,
    channelTitle: 'chan',
    channelId: 'c1',
    publishedAt: '2026-01-01T00:00:00Z',
    thumbnailUrl: null,
    durationSeconds: 30,
    durationLabel: '0:30',
    viewCount,
    likeCount: null,
  };
}

describe('selectBlogCandidates', () => {
  it('исключает ролики, уже заведённые как BlogPost', () => {
    const results = [row('v1', 1000), row('v2', 2000)];
    const out = selectBlogCandidates(results, {
      existingVideoIds: new Set(['v1']),
      minViewCount: 0,
      limit: 10,
    });
    expect(out.map((r) => r.videoId)).toEqual(['v2']);
  });

  it('отсекает ролики ниже порога просмотров', () => {
    const results = [row('v1', 50), row('v2', 5000)];
    const out = selectBlogCandidates(results, {
      existingVideoIds: new Set(),
      minViewCount: 1000,
      limit: 10,
    });
    expect(out.map((r) => r.videoId)).toEqual(['v2']);
  });

  it('ролик без статистики (viewCount: null) считается нулём и отсекается ненулевым порогом', () => {
    const results = [row('v1', null), row('v2', 100)];
    const out = selectBlogCandidates(results, {
      existingVideoIds: new Set(),
      minViewCount: 1,
      limit: 10,
    });
    expect(out.map((r) => r.videoId)).toEqual(['v2']);
  });

  it('сортирует по просмотрам по убыванию и не мутирует исходный массив', () => {
    const results = [row('low', 100), row('high', 9000), row('mid', 500)];
    const copy = [...results];
    const out = selectBlogCandidates(results, {
      existingVideoIds: new Set(),
      minViewCount: 0,
      limit: 10,
    });
    expect(out.map((r) => r.videoId)).toEqual(['high', 'mid', 'low']);
    expect(results).toEqual(copy);
  });

  it('ограничивает результат limit после сортировки, а не до неё', () => {
    const results = [row('a', 10), row('b', 30), row('c', 20)];
    const out = selectBlogCandidates(results, {
      existingVideoIds: new Set(),
      minViewCount: 0,
      limit: 2,
    });
    expect(out.map((r) => r.videoId)).toEqual(['b', 'c']);
  });

  it('отрицательный limit — пустой результат, не бросает', () => {
    const out = selectBlogCandidates([row('a', 10)], {
      existingVideoIds: new Set(),
      minViewCount: 0,
      limit: -1,
    });
    expect(out).toEqual([]);
  });
});
