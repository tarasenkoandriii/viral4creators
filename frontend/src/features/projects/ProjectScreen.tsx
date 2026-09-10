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
  getProject,
  listBrandManifests,
  updateProject,
} from '../../services/projects-api';
import { useAsync } from '../../lib/useAsync';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import { LoadError, ScreenHeader } from './shared';
import { formatPrice, itemLabel } from './format';
import { FeedImportPanel } from './FeedImportPanel';

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
  // Brand manifest attach/detach (spec §12) — optional, so a failure to
  // list manifests must not break the project screen itself.
  const manifests = useAsync(() => listBrandManifests().catch(() => []), []);

  /**
   * Stage 10: start a generation Session from a filled item. The backend
   * copies the item + brand manifest into the session (spec §7.8); the
   * wizard reuses the session id via the same localStorage key it has
   * always used, so no wizard bootstrap change is needed.
   */
  const onStartSession = async (itemId: string) => {
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

  const onDeleteItem = async (itemId: string) => {
    if (!window.confirm(dict.projectScreen.confirmDeleteItem)) return;
    setBusy(itemId);
    setActionError(null);
    try {
      await deleteItem(projectId, itemId);
      setData((p) =>
        p ? { ...p, items: p.items.filter((i) => i.id !== itemId) } : p
      );
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const onDeleteProject = async () => {
    if (!window.confirm(dict.projectScreen.confirmDeleteProject)) return;
    setBusy('delete');
    try {
      await deleteProject(projectId);
      navigate(routes.projects(), true);
    } catch (e) {
      setActionError(errorMessage(e));
      setBusy(null);
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
            loading={busy === 'delete'}
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

      {project.items.length === 0 ? (
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
                      void onDeleteItem(item.id);
                    }}
                    disabled={busy === item.id}
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
    </div>
  );
}
