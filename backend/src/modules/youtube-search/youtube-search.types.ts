/**
 * Result row of GET /youtube-search — exactly the columns of the spec's
 * table (§6.4 / §9: превью, название, канал, длительность, просмотры,
 * лайки) plus what the client needs to hand the pick to the existing
 * registerYoutubeVideo flow (`url`). Mirrored in frontend/src/types.
 */
export interface YoutubeSearchResultView {
  videoId: string;
  /** Canonical watch URL — what POST /sessions/:id/video/youtube accepts. */
  url: string;
  title: string;
  channelTitle: string;
  channelId: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  /** Seconds; null when videos.list had no contentDetails for this id. */
  durationSeconds: number | null;
  /** "4:13" / "1:02:05" — from durationSeconds, for display. */
  durationLabel: string | null;
  viewCount: number | null;
  /** null when the channel hides likes. */
  likeCount: number | null;
}

export interface YoutubeSearchResponse {
  query: string;
  results: YoutubeSearchResultView[];
  /** Per-user daily counter after this search (spec §6.4 quota note). */
  usage: { used: number; limit: number; remaining: number };
}
