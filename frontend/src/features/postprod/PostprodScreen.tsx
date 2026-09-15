/**
 * PostprodScreen (#/postprod) — «Постпрод»: список ВСЕХ готовых роликов
 * пользователя (этап 88: «добавить вкладку постпрод — на ней список
 * роликов которые возможно переозвучить и весь комплект постпродакшена
 * перенести туда»). Показывает все ролики, а не только пригодные для
 * переозвучки — экспорт/публикация/шаринг применимы к любому готовому
 * ролику независимо от режима озвучки; кнопка «Переозвучить» видна
 * только там, где это возможно (`canRevoice`), уже на самом экране
 * ролика (`PostprodVideoScreen`), не в списке.
 *
 * Требует Telegram-личность (`GET /postprod/videos` за
 * `TelegramIdentityGuard`, тот же приём, что у списка проектов) — анонимный
 * посетитель получает 401, `LoadError` уже умеет объяснить это и
 * предложить быстрый путь в «Продакшн» без аккаунта.
 */

import { useState } from 'react';
import { Clapperboard, Mic2 } from 'lucide-react';
import { Button, Card, EmptyState, Spinner } from '../../components/ui';
import { useAsync } from '../../lib/useAsync';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes } from '../../lib/router';
import { ScreenHeader, LoadError } from '../projects/shared';
import {
  listPostprodVideos,
  type PostprodVideoListResult,
  type PostprodVideoSummary,
} from '../../services/postprod-api';

const PAGE_SIZE = 20;

/** "9:16" → 9/16 для CSS `aspect-ratio`; нераспознанное — 9:16 (портрет,
 * дефолт всего пайплайна) — тот же приём, что FeedScreen/landing. */
function cssAspectRatio(raw: string | null): string {
  const m = raw?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  return m ? `${m[1]} / ${m[2]}` : '9 / 16';
}

function VideoRow({
  item,
  dict,
  locale,
}: {
  item: PostprodVideoSummary;
  dict: ReturnType<typeof useI18n>['dict'];
  locale: string;
}) {
  return (
    <Card
      className="cursor-pointer overflow-hidden p-0 transition-colors hover:border-accent/50"
      onClick={() => navigate(routes.postprodVideo(item.sessionId))}
    >
      <div className="flex gap-3 p-3">
        <div
          className="w-20 shrink-0 overflow-hidden rounded-lg bg-black/5 dark:bg-white/5"
          style={{ aspectRatio: cssAspectRatio(item.aspectRatio) }}
        >
          {item.downloadUrl && (
            <video
              src={item.downloadUrl}
              muted
              playsInline
              preload="metadata"
              className="h-full w-full object-cover"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {item.productName || dict.postprodScreen.untitledProduct}
          </p>
          <p className="mt-0.5 text-xs text-silver-400">
            {new Date(item.createdAt).toLocaleString(locale)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {item.canRevoice && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                <Mic2 size={11} />
                {dict.postprodScreen.revoiceBadge}
              </span>
            )}
            {item.postStatus === 'pending' && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                {dict.postprodScreen.processingBadge}
              </span>
            )}
            {item.postStatus === 'failed' && (
              <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
                {dict.postprodScreen.failedBadge}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function PostprodScreen() {
  const { dict, locale } = useI18n();
  const { data, loading, error, reload, setData } =
    useAsync<PostprodVideoListResult>(
      () => listPostprodVideos(1, PAGE_SIZE),
      []
    );
  const [loadingMore, setLoadingMore] = useState(false);

  const items = data?.items ?? [];
  const hasMore = !!data && data.items.length < data.total;

  const loadMore = async () => {
    if (!data || loadingMore) return;
    setLoadingMore(true);
    try {
      const nextPage = data.page + 1;
      const next = await listPostprodVideos(nextPage, data.pageSize);
      setData((prev) =>
        prev ? { ...next, items: [...prev.items, ...next.items] } : next
      );
    } catch {
      // «Показать ещё» — не критично: страница остаётся прежней, кнопка
      // просто разрешает попробовать снова, без отдельного алерта.
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.postprodScreen.title}
        hint={dict.postprodScreen.hint}
      />

      {loading && (
        <div className="flex justify-center py-8">
          <Spinner size={26} />
        </div>
      )}
      {!loading && error ? <LoadError error={error} onRetry={reload} /> : null}

      {!loading && !error && items.length === 0 && (
        <EmptyState
          icon={<Clapperboard size={28} />}
          title={dict.postprodScreen.emptyTitle}
          hint={dict.postprodScreen.emptyHint}
          action={
            <Button
              variant="outline"
              onClick={() => navigate(routes.generate())}
            >
              {dict.postprodScreen.goToProductionCta}
            </Button>
          }
        />
      )}

      {!loading && !error && items.length > 0 && (
        <div className="space-y-2.5">
          {items.map((item) => (
            <VideoRow
              key={item.sessionId}
              item={item}
              dict={dict}
              locale={locale}
            />
          ))}

          {hasMore && (
            <Button
              block
              variant="ghost"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              {dict.postprodScreen.loadMore}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
