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
import { Clapperboard, Mic2, Trash2 } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Spinner,
} from '../../components/ui';
import { useAsync } from '../../lib/useAsync';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes } from '../../lib/router';
import { ScreenHeader, LoadError } from '../projects/shared';
import { errorMessage } from '../../services/projects-api';
import {
  deletePostprodVideo,
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
  deleting,
  onDelete,
}: {
  item: PostprodVideoSummary;
  dict: ReturnType<typeof useI18n>['dict'];
  locale: string;
  deleting: boolean;
  onDelete: () => void;
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
          // data-qa-mask — этап 100 (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-
          // VIDEO-SPEC.md §3.5): миниатюра каждого ролика своя, заведомо
          // переменная зона для крон-обхода UI-снимков (`ui-snapshot-run`).
          data-qa-mask="video-thumb"
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
          <p
            className="mt-0.5 text-xs text-silver-400"
            // data-qa-mask — та же причина: дата создания меняется сама
            // по себе, без единой правки вёрстки (§3.5).
            data-qa-mask="created-at"
          >
            {new Date(item.createdAt).toLocaleString(locale)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {/* Найдено доп. аудитом (MEDIUM): весь смысл этой сводки —
                «UI showing provider/quality info per video» (доккомментарий
                postprod-video-summary.ts) — бэкенд считает эти три поля
                до конца, но список их не показывал нигде. Бейдж
                провайдера + (для Grok — разрешение, для Veo — качество
                рендера, они у провайдеров разные оси) теми же строками
                словаря, что уже использует шаг «Генерация» —
                отдельных ключей не заводили. */}
            <span className="rounded-full bg-silver-400/15 px-2 py-0.5 text-[11px] font-medium text-silver-500 dark:text-silver-300">
              {item.provider === 'grok'
                ? dict.generationWizard.providerGrokLabel
                : dict.generationWizard.providerVeoLabel}
            </span>
            {item.provider === 'grok' && item.resolution && (
              <span className="rounded-full bg-silver-400/15 px-2 py-0.5 text-[11px] font-medium text-silver-500 dark:text-silver-300">
                {item.resolution}
              </span>
            )}
            {item.provider !== 'grok' && item.quality && (
              <span className="rounded-full bg-silver-400/15 px-2 py-0.5 text-[11px] font-medium text-silver-500 dark:text-silver-300">
                {item.quality === 'standard'
                  ? dict.generationWizard.qualityStandardLabel
                  : dict.generationWizard.qualityFastLabel}
              </span>
            )}
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
        <button
          type="button"
          aria-label={dict.postprodScreen.deleteAriaLabel}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          disabled={deleting}
          className="inline-flex h-fit shrink-0 min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-1.5 text-silver-400 hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50"
        >
          <Trash2 size={14} />
        </button>
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // «Умный» алерт удаления (этап 89) — тот же честный, без-превью текст,
  // что и на PostprodVideoScreen (см. её doc-комментарий у onConfirmDelete).
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const items = data?.items ?? [];
  const hasMore = !!data && data.items.length < data.total;

  const onConfirmDelete = async () => {
    const sessionId = pendingDeleteId;
    if (!sessionId) return;
    setDeletingId(sessionId);
    setDeleteError(null);
    try {
      await deletePostprodVideo(sessionId);
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.filter((i) => i.sessionId !== sessionId),
              total: prev.total - 1,
            }
          : prev
      );
      setPendingDeleteId(null);
    } catch (e) {
      setDeleteError(errorMessage(e));
      setPendingDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  };

  const loadMore = async () => {
    if (!data || loadingMore) return;
    setLoadingMore(true);
    try {
      const nextPage = data.page + 1;
      // offset = реально загруженное количество (найдено доп. аудитом,
      // HIGH), не (page) * pageSize: onConfirmDelete убирает строку
      // локально без перезагрузки списка, так что после хотя бы одного
      // удаления номинальная страница и фактическое количество
      // расходятся — умножение пропускало бы один ролик на границе
      // страниц (см. доккомментарий PostprodVideosService.
      // listFinishedVideos).
      const next = await listPostprodVideos(
        nextPage,
        data.pageSize,
        data.items.length
      );
      setData((prev) => {
        if (!prev) return next;
        // Найдено доп. аудитом (MEDIUM): `offset = items.length`
        // компенсирует только строки, УБРАННЫЕ из-под текущего окна
        // (локальное удаление, см. доккомментарий сервиса) — не строки,
        // ДОБАВЛЕННЫЕ выше него. Список отсортирован `createdAt DESC`, и
        // ролик, доснявшийся, пока вкладка открыта, встаёт новой первой
        // строкой, сдвигая вниз все уже загруженные; следующий «Показать
        // ещё» с тем же offset тогда повторно возвращает последнюю уже
        // отрисованную строку — дубликат `sessionId`, дубликат React
        // `key`. Дедуп при склейке — минимальное исправление: сам
        // инвариант «offset = сколько строк реально на экране» при этом
        // не ломается (после фильтрации count не меняется относительно
        // того, что уже отрисовано).
        const known = new Set(prev.items.map((i) => i.sessionId));
        const fresh = next.items.filter((i) => !known.has(i.sessionId));
        return { ...next, items: [...prev.items, ...fresh] };
      });
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

      {deleteError && (
        <Alert
          tone="error"
          className="mb-3"
          onDismiss={() => setDeleteError(null)}
        >
          {deleteError}
        </Alert>
      )}

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
              deleting={deletingId === item.sessionId}
              onDelete={() => setPendingDeleteId(item.sessionId)}
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

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title={dict.deleteConfirm.sessionTitle}
        busy={deletingId !== null}
        onConfirm={() => void onConfirmDelete()}
        onCancel={() => setPendingDeleteId(null)}
      >
        <p>{dict.deleteConfirm.sessionBody}</p>
      </ConfirmDialog>
    </div>
  );
}
