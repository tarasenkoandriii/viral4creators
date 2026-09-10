/**
 * Publication queue — doc/PRODUCT-PROJECT-SPEC.md §8 (Todo) / §11
 * «Опубликовать»; Stage 18 (moderation) + Stage 61 (upload — §14).
 * Mirrored in frontend/src/types and admin/src/lib/types.ts.
 */

export type PublicationPlatform = 'YOUTUBE' | 'TIKTOK';

export type PublicationStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'PUBLISHED'
  | 'FAILED';

/** Запрошенная видимость на площадке (этап 61, ТЗ §14.3) — до прохождения
 * аудита Google/TikTok сама площадка всё равно принудительно приватит. */
export type PublicationPrivacy = 'PRIVATE' | 'UNLISTED' | 'PUBLIC';

export interface PublicationRequestView {
  id: string;
  userId: string;
  sessionId: string;
  generatedVideoId: string;
  projectId: string | null;
  productItemId: string | null;
  platform: PublicationPlatform;
  status: PublicationStatus;
  videoUrl: string;
  title: string;
  description: string;
  tags: string[];
  category: string | null;
  moderatorId: string | null;
  moderatedAt: string | null;
  rejectReason: string | null;
  externalUrl: string | null;
  publishedAt: string | null;
  publishError: string | null;
  /** Этап 61: null у APPROVED значит «канал не подключён», это не ошибка. */
  channelId: string | null;
  privacy: PublicationPrivacy;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicationListResult {
  items: PublicationRequestView[];
  total: number;
  page: number;
  pageSize: number;
  /** PENDING count regardless of the filter — the nav badge. */
  pending: number;
}
