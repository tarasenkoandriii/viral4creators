/**
 * P-R — проект как общий фильтр вкладок (кроме «Проектов»): `?projectId=`
 * маршрута; единственный проект продукта выбирается сам. Формы создания
 * берут выбранный проект; без него — подсказка «сначала проект».
 */
import { Alert, Button } from '../../../kit/ui';
import { isReloadable } from '../../../lib/publisher/reddit-view';
import { PubErrorAlert } from '../parts';
import { useReddit, type ProjectScope } from './reddit-hooks';
import { ProjectSelect } from './reddit-parts';

/** Строка выбора проекта над списком вкладки (меняет `?projectId=`). */
export function ProjectBar({
  scope,
  tab,
}: {
  scope: ProjectScope;
  tab: string;
}) {
  const { r, t, go } = useReddit();
  return (
    <div className="space-y-2">
      <ProjectSelect
        projects={scope.list}
        value={scope.projectId}
        label={r.common.project}
        empty={r.common.allProjects}
        onChange={(v) =>
          go('reddit', null, v ? { tab, projectId: v } : { tab })
        }
      />
      {scope.error ? <PubErrorAlert error={scope.error} /> : null}
      {scope.error && isReloadable(scope.error) ? (
        <Button variant="outline" onClick={scope.reload}>
          {t.common.retry}
        </Button>
      ) : null}
      {!scope.loading && !scope.error && scope.list.length === 0 && (
        <Alert tone="neutral">{r.common.noProject}</Alert>
      )}
    </div>
  );
}
