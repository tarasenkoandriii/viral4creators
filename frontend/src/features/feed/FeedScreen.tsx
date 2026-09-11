/**
 * FeedScreen (#/feed) — лента опубликованных роликов (TODO §III.9, этап
 * 80, doc/SOCIAL-FEED-SPEC.md). Надстройка над уже существующей
 * `SharedVideoPage` (публичная страница + петля шеринга, item 1, этап
 * 60) — показывает те же PUBLISHED-страницы подряд, внутри TMA, с
 * лайками и репостами.
 *
 * Просмотр ленты не требует входа (бэкенд-маршрут публичный, как и
 * `/shared-video/:id`), лайк — требует (TelegramIdentityGuard): анонимный
 * POST/DELETE ловит 401, показывается мягкая подсказка «войдите», а не
 * ошибка на весь экран (см. `loginHint` ниже).
 *
 * Точка входа — кнопка на ProjectsListScreen, а не четвёртая вкладка
 * верхней навигации: в App.tsx уже зафиксировано решение не добавлять
 * туда четвёртый пункт при ширине 390px.
 */

import { useState } from 'react';
import { Heart, Share2 } from 'lucide-react';
import { Alert, Button, Card, EmptyState, Spinner } from '../../components/ui';
import { useAsync } from '../../lib/useAsync';
import { useI18n } from '../../lib/i18n-context';
import { isUnauthorized } from '../../services/projects-api';
import {
  getFeed,
  likeSharedVideo,
  recordSharedVideoShare,
  unlikeSharedVideo,
} from '../../services/feed-api';
import { formatPrice } from '../projects/format';
import { ScreenHeader, LoadError } from '../projects/shared';
import type { SharedVideoFeedItem, SharedVideoFeedResult } from '../../types';

const PAGE_SIZE = 20;

const LANDING_URL = (
  import.meta.env.VITE_LANDING_URL || 'http://localhost:3003'
).replace(/\/+$/, '');

/** Та же публичная страница, что и у ShareVideoPanel (item 1, этап 60) —
 * лента репостит уже существующий, а не новый, публичный артефакт. */
function pageUrl(id: string): string {
  return `${LANDING_URL}/video/${id}`;
}

/** "9:16" → 9/16 для CSS `aspect-ratio`; нераспознанное — 9:16 (портрет,
 * дефолт всего пайплайна) — тот же приём, что landing/video/[id]/page.tsx. */
function cssAspectRatio(raw: string | null): string {
  const m = raw?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  return m ? `${m[1]} / ${m[2]}` : '9 / 16';
}

export function FeedScreen() {
  const { dict, locale } = useI18n();
  const { data, loading, error, reload, setData } =
    useAsync<SharedVideoFeedResult>(() => getFeed(null, PAGE_SIZE), []);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loginHint, setLoginHint] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const items = data?.items ?? [];

  const patchItem = (id: string, patch: Partial<SharedVideoFeedItem>) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.id === id ? { ...it, ...patch } : it
            ),
          }
        : prev
    );
  };

  const toggleLike = async (item: SharedVideoFeedItem) => {
    setBusyId(item.id);
    try {
      const r = item.likedByViewer
        ? await unlikeSharedVideo(item.id)
        : await likeSharedVideo(item.id);
      patchItem(item.id, r);
      setLoginHint(false);
    } catch (err) {
      if (isUnauthorized(err)) setLoginHint(true);
    } finally {
      setBusyId(null);
    }
  };

  /** Тот же паттерн, что ShareVideoPanel.copyLink/landing ShareButtons:
   * `navigator.share`, иначе clipboard. Счётчик бампается ОПТИМИСТИЧНО и
   * best-effort — сорванный системный шаринг (пользователь закрыл лист)
   * не должен бампать счётчик, поэтому запрос идёт уже ПОСЛЕ share/copy. */
  const share = async (item: SharedVideoFeedItem) => {
    const url = pageUrl(item.id);
    try {
      if (navigator.share) {
        await navigator.share({ title: item.title, url });
      } else {
        await navigator.clipboard.writeText(url);
      }
    } catch {
      return; // пользователь закрыл системный шаринг — не ошибка, не считаем
    }
    patchItem(item.id, { shareCount: item.shareCount + 1 });
    void recordSharedVideoShare(item.id).catch(() => undefined);
  };

  const loadMore = async () => {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await getFeed(data.nextCursor, PAGE_SIZE);
      setData((prev) =>
        prev
          ? {
              items: [...prev.items, ...next.items],
              nextCursor: next.nextCursor,
            }
          : next
      );
    } catch {
      // «Показать ещё» — не критично: курсор остаётся прежним, кнопка
      // просто разрешает попробовать снова, без отдельного алерта.
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="animate-fadeIn">
      <ScreenHeader title={dict.feedScreen.title} hint={dict.feedScreen.hint} />

      {loginHint && (
        <Alert
          tone="info"
          className="mb-3"
          onDismiss={() => setLoginHint(false)}
        >
          {dict.feedScreen.loginToLike}
        </Alert>
      )}

      {loading && (
        <div className="flex justify-center py-8">
          <Spinner size={26} />
        </div>
      )}
      {!loading && error ? <LoadError error={error} onRetry={reload} /> : null}

      {!loading && !error && items.length === 0 && (
        <EmptyState
          icon={<Heart size={28} />}
          title={dict.feedScreen.emptyTitle}
          hint={dict.feedScreen.emptyHint}
        />
      )}

      {!loading && !error && items.length > 0 && (
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.id} className="overflow-hidden p-0">
              <video
                src={item.videoUrl}
                poster={item.productImageUrl ?? undefined}
                controls
                playsInline
                preload="metadata"
                className="w-full bg-black"
                style={{ aspectRatio: cssAspectRatio(item.aspectRatio) }}
              />
              <div className="p-3">
                <p className="truncate text-sm font-semibold">{item.title}</p>
                <p className="truncate text-xs text-silver-400">
                  {item.productName}
                  {item.price !== null &&
                    ` · ${formatPrice(item.price, item.currency, locale)}`}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={item.likedByViewer ? 'solid' : 'outline'}
                    icon={
                      <Heart
                        size={14}
                        fill={item.likedByViewer ? 'currentColor' : 'none'}
                      />
                    }
                    loading={busyId === item.id}
                    onClick={() => void toggleLike(item)}
                  >
                    {item.likeCount}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Share2 size={14} />}
                    onClick={() => void share(item)}
                  >
                    {item.shareCount > 0
                      ? item.shareCount
                      : dict.feedScreen.shareButton}
                  </Button>
                  <span className="ml-auto text-[11px] text-silver-400 tabular">
                    {item.viewCount} {dict.feedScreen.viewsLabel}
                  </span>
                </div>
              </div>
            </Card>
          ))}

          {data?.nextCursor && (
            <Button
              block
              variant="ghost"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              {dict.feedScreen.loadMore}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
