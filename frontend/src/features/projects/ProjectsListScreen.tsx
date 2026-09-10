/**
 * Projects list — the app's entry screen (spec §7.8: Project is a
 * long-lived catalog, so the list comes before Экран 1).
 */

import { FolderOpen, Layers, Package, Plus, Zap } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Spinner } from '../../components/ui';
import { listProjects } from '../../services/projects-api';
import { useAsync } from '../../lib/useAsync';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import { LoadError, ScreenHeader } from './shared';

export function ProjectsListScreen() {
  const { dict } = useI18n();
  const { data, loading, error, reload } = useAsync(listProjects, []);

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.projectsListScreen.title}
        hint={dict.projectsListScreen.hint}
        action={
          <Button
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => navigate(routes.projectNew())}
          >
            {dict.projectsListScreen.newButton}
          </Button>
        }
      />

      {loading && (
        <div className="flex justify-center py-12">
          <Spinner size={28} />
        </div>
      )}

      {!loading && error ? <LoadError error={error} onRetry={reload} /> : null}

      {!loading && !error && data && data.length === 0 && (
        <EmptyState
          icon={<FolderOpen size={30} />}
          title={dict.projectsListScreen.emptyTitle}
          hint={dict.projectsListScreen.emptyHint}
          action={
            <Button
              icon={<Plus size={14} />}
              onClick={() => navigate(routes.projectNew())}
            >
              {dict.projectsListScreen.createButton}
            </Button>
          }
        />
      )}

      {!loading && !error && data && data.length > 0 && (
        <div className="space-y-2">
          {data.map((p) => (
            <Card
              key={p.id}
              className="p-4 cursor-pointer transition-colors hover:border-accent/60"
              onClick={() => navigate(routes.project(p.id))}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {p.type === 'LINE' ? (
                      <Layers size={14} className="shrink-0 text-accent" />
                    ) : (
                      <Package size={14} className="shrink-0 text-accent" />
                    )}
                    <h3 className="truncate font-semibold">{p.title}</h3>
                  </div>
                  <p className="mt-0.5 text-xs text-silver-400">
                    {p.countryCode} · {p.currency}
                    {p.brandManifestId &&
                      dict.projectsListScreen.manifestSuffix}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge tone={p.type === 'LINE' ? 'accent' : 'neutral'}>
                    {p.type === 'LINE'
                      ? dict.projectsListScreen.typeLine
                      : dict.projectsListScreen.typeSingle}
                  </Badge>
                  <span className="tabular text-xs text-silver-400">
                    {dict.projectsListScreen.readyCount
                      .replace('{{complete}}', String(p.completeItemCount))
                      .replace('{{total}}', String(p.itemCount))}
                  </span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {!loading && (
        <button
          type="button"
          onClick={() => navigate(routes.generate())}
          className="mt-4 flex min-h-[44px] w-full items-center justify-center gap-1.5 text-xs text-silver-400 hover:text-accent"
        >
          <Zap size={12} /> {dict.projectsListScreen.quickGenerate}
        </button>
      )}
    </div>
  );
}
