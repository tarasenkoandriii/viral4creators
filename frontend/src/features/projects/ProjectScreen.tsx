/**
 * Project detail — items of the project with their fill state; entry to
 * the per-item wizard (Экраны 2–5). "Добавить товар" for LINE projects;
 * a SINGLE project gets its one item created on first open (spec §2: a
 * SINGLE project has exactly one ProductItem).
 */

import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Clapperboard,
  Gift,
  Globe,
  ImageOff,
  Palette,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Select,
  Spinner,
} from '../../components/ui';
import {
  addItem,
  createSessionFromItem,
  deleteItem,
  deleteProject,
  errorMessage,
  getItemDeletePreview,
  getProject,
  getProjectDeletePreview,
  isNotFoundError,
  listBrandManifests,
  listItemSessions,
  updateProject,
} from '../../services/projects-api';

import type {
  ItemDeletePreview,
  ProjectDeletePreview,
} from '../../types/project';
import { useAsync } from '../../lib/useAsync';
import { resumableRun, runState } from '../../lib/item-runs';
import type { ItemRun } from '../../lib/item-runs';
import { formatRunTime } from '../../lib/intl-locale';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import { LoadError, ScreenHeader } from './shared';
import { formatPrice, itemLabel, pluralForm } from './format';
import { FeedImportPanel } from './FeedImportPanel';

/** Одна непустая строка счётчика — `null`, если считать нечего (0). */
function countLine(
  n: number,
  locale: ReturnType<typeof useI18n>['locale'],
  forms: Parameters<typeof pluralForm>[2]
): string | null {
  return n > 0 ? pluralForm(n, locale, forms) : null;
}

/**
 * Тело диалога подтверждения — «умный» алерт удаления (этап 89): точные
 * счётчики под-сущностей вместо общей фразы «это необратимо». Пока
 * `preview` не пришёл (ушёл 404/ошибка сети), диалог не блокирует
 * удаление — просто честно говорит, что список неточный.
 */
function ProjectDeletePreviewBody({
  preview,
  locale,
  dict,
}: {
  preview: ProjectDeletePreview | null;
  locale: ReturnType<typeof useI18n>['locale'];
  dict: ReturnType<typeof useI18n>['dict'];
}) {
  if (!preview) return <p>{dict.deleteConfirm.previewFailed}</p>;
  const lines = [
    countLine(preview.items, locale, dict.deleteConfirm.items),
    countLine(
      preview.catalogBatchRuns,
      locale,
      dict.deleteConfirm.catalogBatchRuns
    ),
    countLine(preview.abTestRuns, locale, dict.deleteConfirm.abTestRuns),
    countLine(
      preview.feedImportRuns,
      locale,
      dict.deleteConfirm.feedImportRuns
    ),
  ].filter((l): l is string => l !== null);
  if (lines.length === 0) {
    return <p>{dict.deleteConfirm.nothingElseProject}</p>;
  }
  return (
    <>
      <p>{dict.deleteConfirm.willDelete}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </>
  );
}

function ItemDeletePreviewBody({
  preview,
  locale,
  dict,
}: {
  preview: ItemDeletePreview | null;
  locale: ReturnType<typeof useI18n>['locale'];
  dict: ReturnType<typeof useI18n>['dict'];
}) {
  if (!preview) return <p>{dict.deleteConfirm.previewFailed}</p>;
  const lines = [
    countLine(preview.analogs, locale, dict.deleteConfirm.analogs),
    countLine(
      preview.catalogBatchItems,
      locale,
      dict.deleteConfirm.catalogBatchItems
    ),
  ].filter((l): l is string => l !== null);
  if (lines.length === 0) {
    return <p>{dict.deleteConfirm.nothingElseItem}</p>;
  }
  return (
    <>
      <p>{dict.deleteConfirm.willDelete}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </>
  );
}

type PendingDelete = { kind: 'project' } | { kind: 'item'; itemId: string };

export function ProjectScreen({ projectId }: { projectId: string }) {
  const { dict, locale } = useI18n();
  const {
    data: project,
    setData,
    loading,
    error,
    reload,
  } = useAsync(() => getProject(projectId), [projectId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // «Умный» алерт удаления (этап 89): открытие диалога и загрузка
  // точных счётчиков — два отдельных шага, счётчики могут прийти позже
  // (или не прийти вовсе) без блокировки самого диалога.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null
  );
  const [projectPreview, setProjectPreview] =
    useState<ProjectDeletePreview | null>(null);
  const [itemPreview, setItemPreview] = useState<ItemDeletePreview | null>(
    null
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Brand manifest attach/detach (spec §12) — optional, so a failure to
  // list manifests must not break the project screen itself.
  const manifests = useAsync(() => listBrandManifests().catch(() => []), []);

  /**
   * Stage 10: start a generation Session from a filled item. The backend
   * copies the item + brand manifest into the session (spec §7.8); the
   * wizard reuses the session id via the same localStorage key it has
   * always used, so no wizard bootstrap change is needed.
   */
  /**
   * Б-2.9 (этап 121): перед запуском НОВОГО прогона спрашиваем про
   * незавершённый старый.
   *
   * Строка ниже (`localStorage.setItem`) — единственная ручка, которой
   * мастер держится за сессию. Пока товар A рендерится, запуск товара B
   * затирал её молча: идущий прогон A не показывал после этого ни один
   * экран (список готовых роликов отбирает только завершённые), и через
   * сутки TTL уносил его вместе с уже оплаченным роликом.
   *
   * Список прогонов — best-effort: если он не доедет, запуск идёт как
   * раньше. Потерять возможность сгенерировать ролик из-за
   * вспомогательного запроса было бы хуже самой проблемы.
   */
  const [resume, setResume] = useState<{
    itemId: string;
    run: ItemRun;
  } | null>(null);

  const startFreshSession = async (itemId: string) => {
    setBusy(`session:${itemId}`);
    setActionError(null);
    try {
      const session = await createSessionFromItem(projectId, itemId);
      localStorage.setItem('sessionId', session.sessionId);
      navigate(routes.generate());
    } catch (e) {
      setActionError(errorMessage(e));
      setBusy(null);
    }
  };

  const onStartSession = async (itemId: string) => {
    setBusy(`session:${itemId}`);
    setActionError(null);
    const runs = await listItemSessions(projectId, itemId).catch(() => null);
    const unfinished = resumableRun(runs);
    if (unfinished) {
      setBusy(null);
      setResume({ itemId, run: unfinished });
      return;
    }
    await startFreshSession(itemId);
  };

  const resumeSession = () => {
    if (!resume) return;
    localStorage.setItem('sessionId', resume.run.sessionId);
    setResume(null);
    navigate(routes.generate());
  };

  const onManifestChange = async (value: string) => {
    setBusy('manifest');
    setActionError(null);
    try {
      const updated = await updateProject(projectId, {
        brandManifestId: value || null,
      });
      setData(updated);
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // SINGLE project → exactly one item; create it silently so the user
  // lands straight on the photo step instead of an empty list.
  useEffect(() => {
    if (
      !project ||
      project.type !== 'SINGLE' ||
      project.items.length > 0 ||
      busy
    )
      return;
    setBusy('add');
    addItem(projectId, { title: project.title })
      .then((item) => navigate(routes.item(projectId, item.id), true))
      .catch((e) => setActionError(errorMessage(e)))
      .finally(() => setBusy(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.type, project?.items.length]);

  const onAdd = async () => {
    setBusy('add');
    setActionError(null);
    try {
      const item = await addItem(projectId);
      navigate(routes.item(projectId, item.id));
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // Открывает диалог сразу (не ждёт ответа сети) и подгружает точные
  // счётчики отдельно — так модалка не «зависает» пустой на медленной
  // сети, а показывает спиннер внутри уже открытого диалога.
  const onDeleteItem = (itemId: string) => {
    setActionError(null);
    setItemPreview(null);
    setPendingDelete({ kind: 'item', itemId });
    setPreviewLoading(true);
    getItemDeletePreview(projectId, itemId)
      .then((p) => setItemPreview(p))
      .catch((e) => {
        if (isNotFoundError(e)) {
          // Найдено доп. аудитом (LOW): 404 здесь — не «не смогли
          // посчитать точно» (previewFailed), а «уже удалено» (другая
          // вкладка/устройство, или срок мягкого удаления истёк). Диалог
          // над несуществующим товаром закрываем и обновляем список, а не
          // оставляем висеть с общим текстом ошибки.
          setPendingDelete(null);
          setActionError(dict.deleteConfirm.alreadyDeleted);
          void reload();
          return;
        }
        setItemPreview(null);
      })
      .finally(() => setPreviewLoading(false));
  };

  const onDeleteProject = () => {
    setActionError(null);
    setProjectPreview(null);
    setPendingDelete({ kind: 'project' });
    setPreviewLoading(true);
    getProjectDeletePreview(projectId)
      .then((p) => setProjectPreview(p))
      .catch((e) => {
        if (isNotFoundError(e)) {
          // Тот же фикс, что и в onDeleteItem выше (этап 89, доп. аудит).
          setPendingDelete(null);
          setActionError(dict.deleteConfirm.alreadyDeleted);
          navigate(routes.projects(), true);
          return;
        }
        setProjectPreview(null);
      })
      .finally(() => setPreviewLoading(false));
  };

  const onCancelDelete = () => {
    if (deleteBusy) return;
    setPendingDelete(null);
  };

  const onConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      if (pendingDelete.kind === 'project') {
        await deleteProject(projectId);
        setPendingDelete(null);
        navigate(routes.projects(), true);
        return;
      }
      await deleteItem(projectId, pendingDelete.itemId);
      setData((p) =>
        p
          ? {
              ...p,
              items: p.items.filter((i) => i.id !== pendingDelete.itemId),
            }
          : p
      );
      setPendingDelete(null);
    } catch (e) {
      setActionError(errorMessage(e));
      setPendingDelete(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} />
      </div>
    );
  }
  if (error || !project) {
    return (
      <div>
        <ScreenHeader
          title={dict.projectScreen.title}
          back={routes.projects()}
        />
        <LoadError error={error} onRetry={reload} />
      </div>
    );
  }

  const complete = project.items.filter((i) => i.isComplete).length;

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={project.title}
        back={routes.projects()}
        hint={
          <>
            {project.type === 'LINE'
              ? dict.projectScreen.typeLine
              : project.type === 'CLIENT_SITE'
                ? dict.projectScreen.typeClientSite
                : project.type === 'GREETING_VIDEO'
                  ? dict.projectCreateScreen.greetingVideoLabel
                  : dict.projectScreen.typeSingle}{' '}
            · {project.countryCode} ·{' '}
            <span className="tabular">{project.currency}</span>
            {project.type === 'LINE' && (
              <>
                {' '}
                ·{' '}
                <span className="tabular">
                  {complete}/{project.items.length}
                </span>{' '}
                {dict.projectScreen.readyLabel}
              </>
            )}
          </>
        }
        action={
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={14} />}
            onClick={onDeleteProject}
            aria-label={dict.projectScreen.deleteProjectAriaLabel}
          />
        }
      />

      {actionError && (
        <Alert
          tone="error"
          className="mb-3"
          onDismiss={() => setActionError(null)}
        >
          {actionError}
        </Alert>
      )}

      {/*
        У проекта «сайт заказчика» нет товаров вообще — вся его работа
        живёт в визарде обучалки, и список позиций ниже для него не
        имеет смысла (§4.1/§4.3).
      */}
      {project.type === 'CLIENT_SITE' ? (
        <Card className="p-5 space-y-4">
          <p className="text-sm text-[var(--muted)]">
            {dict.projectScreen.clientSiteHint}
          </p>
          <Button
            block
            size="lg"
            icon={<Globe size={16} />}
            onClick={() => navigate(routes.siteTutorial(project.id))}
          >
            {dict.projectScreen.clientSiteCta}
          </Button>
        </Card>
      ) : project.type === 'GREETING_VIDEO' ? (
        // У ролика-поздравления тоже нет товаров (ТЗ
        // TZ-Greeting-Video-Project-Type.md §4.1/§4.3) — тот же приём,
        // что у CLIENT_SITE: вся работа живёт в своём визарде.
        <Card className="p-5 space-y-4">
          <p className="text-sm text-[var(--muted)]">
            {dict.greetingVideoWizard.hint}
          </p>
          <Button
            block
            size="lg"
            icon={<Gift size={16} />}
            onClick={() => navigate(routes.greetingVideo(project.id))}
          >
            {dict.greetingVideoWizard.startSessionButton}
          </Button>
        </Card>
      ) : project.items.length === 0 ? (
        project.type === 'SINGLE' ? (
          <div className="flex justify-center py-12">
            <Spinner size={24} />
          </div>
        ) : (
          <EmptyState
            title={dict.projectScreen.emptyLineTitle}
            hint={dict.projectScreen.emptyLineHint}
            action={
              <Button
                icon={<Plus size={14} />}
                onClick={onAdd}
                loading={busy === 'add'}
              >
                {dict.projectScreen.addItem}
              </Button>
            }
          />
        )
      ) : (
        <div className="space-y-2">
          {project.items.map((item, index) => (
            <Card
              key={item.id}
              className="flex items-center gap-3 p-3 cursor-pointer transition-colors hover:border-accent/60"
              onClick={() => navigate(routes.item(projectId, item.id))}
            >
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-silver-200/60 dark:bg-silver-800/60 grid place-items-center text-silver-400">
                {item.photoUrl ? (
                  <img
                    src={item.photoUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <ImageOff size={18} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    {itemLabel(item, index, dict.projectFormat.itemFallback)}
                  </span>
                  {item.category && <Badge>{item.category}</Badge>}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-silver-400">
                  <span className="tabular whitespace-nowrap">
                    {formatPrice(item.price, project.currency, locale)}
                  </span>
                  <span>·</span>
                  <span className="truncate">
                    {item.description
                      ? item.description.slice(0, 60)
                      : dict.projectScreen.noDescription}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {item.isComplete ? (
                  <CheckCircle2 size={18} className="text-emerald-500" />
                ) : (
                  <Circle
                    size={18}
                    className="text-silver-300 dark:text-silver-700"
                  />
                )}
                {project.type === 'LINE' && (
                  <button
                    type="button"
                    aria-label={dict.projectScreen.deleteItemAriaLabel}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteItem(item.id);
                    }}
                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-1.5 text-silver-400 hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </Card>
          ))}

          {project.type === 'LINE' && (
            <Button
              block
              variant="outline"
              icon={<Plus size={14} />}
              onClick={onAdd}
              loading={busy === 'add'}
            >
              {dict.projectScreen.addAnotherItem}
            </Button>
          )}
        </div>
      )}

      {/* Этап 68 (TODO §Уровень 2 п.8): импорт фида — только для LINE
          (SINGLE-проекту нечего импортировать, у него ровно один товар,
          заведённый автоматически выше). Показывается независимо от
          того, сколько позиций уже заведено вручную — продавец с
          каталогом обычно начинает именно с фида. */}
      {project.type === 'LINE' && (
        <div className="mt-5">
          <FeedImportPanel projectId={projectId} />
        </div>
      )}

      <Card className="mt-5 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Palette size={14} className="text-accent" />
          <span className="text-sm font-semibold">
            {dict.projectScreen.brandManifestHeading}
          </span>
        </div>
        {manifests.data && manifests.data.length === 0 ? (
          <p className="text-xs text-silver-400">
            {dict.projectScreen.noManifestsPrefix}{' '}
            <button
              type="button"
              className="underline hover:text-accent"
              onClick={() => navigate(routes.manifestNew())}
            >
              {dict.projectScreen.createManifestAction}
            </button>
            {dict.projectScreen.noManifestsSuffix}
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <Select
              aria-label={dict.projectScreen.brandManifestHeading}
              value={project.brandManifestId ?? ''}
              onChange={(e) => void onManifestChange(e.target.value)}
              disabled={busy !== null || manifests.loading}
            >
              <option value="">{dict.projectScreen.noManifestOption}</option>
              {manifests.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </Select>
            {project.brandManifestId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  navigate(routes.manifest(project.brandManifestId as string))
                }
              >
                {dict.projectScreen.openManifest}
              </Button>
            )}
          </div>
        )}
      </Card>

      {complete > 0 && (
        <Card className="mt-5 p-4">
          <div className="flex items-center gap-2 mb-1">
            <Clapperboard size={14} className="text-accent" />
            <span className="text-sm font-semibold">
              {dict.projectScreen.videoHeading}
            </span>
          </div>
          <p className="mb-3 text-xs text-silver-400">
            {dict.projectScreen.videoCopyHint.replace(
              '{{extra}}',
              project.brandManifestId
                ? dict.projectScreen.andBrandManifestSuffix
                : ''
            )}
          </p>
          <div className="space-y-2">
            {project.items
              .filter((i) => i.isComplete)
              .map((item, index) => (
                <Button
                  key={item.id}
                  block
                  variant={index === 0 ? 'solid' : 'outline'}
                  icon={<Clapperboard size={14} />}
                  loading={busy === `session:${item.id}`}
                  disabled={busy !== null && busy !== `session:${item.id}`}
                  onClick={() => void onStartSession(item.id)}
                >
                  {project.type === 'LINE'
                    ? dict.projectScreen.videoButtonLine.replace(
                        '{{item}}',
                        itemLabel(
                          item,
                          project.items.indexOf(item),
                          dict.projectFormat.itemFallback
                        )
                      )
                    : dict.projectScreen.videoButtonSingle}
                </Button>
              ))}
          </div>
        </Card>
      )}

      {/* Незавершённый прогон этого товара (Б-2.9, этап 121): не
          «удалить?», а выбор из двух поступков, поэтому подтверждение
          нейтральное, а второе действие — отдельной кнопкой в подвале
          диалога (в теле оно забрало бы себе начальный фокус). */}
      <ConfirmDialog
        open={resume !== null}
        danger={false}
        title={dict.projectScreen.resumeTitle}
        confirmLabel={dict.projectScreen.resumeConfirm}
        cancelLabel={dict.common.cancel}
        onConfirm={resumeSession}
        onCancel={() => setResume(null)}
        secondaryAction={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const itemId = resume?.itemId;
              setResume(null);
              if (itemId) void startFreshSession(itemId);
            }}
          >
            {dict.projectScreen.resumeNew}
          </Button>
        }
      >
        <p>
          {(resume && runState(resume.run) === 'running'
            ? dict.projectScreen.resumeBodyRunning
            : dict.projectScreen.resumeBodyStalled
          ).replace(
            '{{date}}',
            resume
              ? formatRunTime(
                  resume.run.lastActivityAt || resume.run.createdAt,
                  locale
                )
              : ''
          )}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === 'project'
            ? dict.deleteConfirm.projectTitle
            : dict.deleteConfirm.itemTitle
        }
        loadingBody={previewLoading}
        busy={deleteBusy}
        onConfirm={() => void onConfirmDelete()}
        onCancel={onCancelDelete}
      >
        {pendingDelete?.kind === 'project' ? (
          <ProjectDeletePreviewBody
            preview={projectPreview}
            locale={locale}
            dict={dict}
          />
        ) : (
          <ItemDeletePreviewBody
            preview={itemPreview}
            locale={locale}
            dict={dict}
          />
        )}
      </ConfirmDialog>
    </div>
  );
}
