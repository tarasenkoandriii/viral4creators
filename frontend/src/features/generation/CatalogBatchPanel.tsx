/**
 * CatalogBatchPanel — «Сделать так же для всей линейки» (ТЗ §44, этап 65,
 * doc/TODO.md §III.5). Показывается на экране готового ролика (там, где
 * уже стоят PublishPanel/ShareVideoPanel) для LINE-проекта из нескольких
 * товаров: разбор + промпт этой сессии можно перенести на остальные
 * товары одним заходом, без ручного повтора мастера по каждому.
 *
 * Только Premium (`PlanFeature 'library'` — то же ограничение, что и у
 * обычной библиотеки разборов, решение владельца продукта: партия
 * технически целиком построена на `LibraryService.applyToSession`).
 * Кнопка сама ничего не запускает — ведёт на экран выбора товаров
 * (`CatalogBatchStartScreen`), где пользователь видит список и
 * подтверждает состав партии.
 */

import { Layers } from 'lucide-react';
import { Button, Card, CardHeader, LockedNote } from '../../components/ui';
import { useAsync } from '../../lib/useAsync';
import { getProject } from '../../services/projects-api';
import { navigate, routes } from '../../lib/router';
import { useFeature } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';

export function CatalogBatchPanel({
  sessionId,
  projectId,
}: {
  sessionId: string;
  projectId: string;
}) {
  const { dict } = useI18n();
  const library = useFeature('library');
  const {
    data: project,
    loading,
    error,
  } = useAsync(() => getProject(projectId), [projectId]);

  // Тихая необязательная панель поверх уже готового ролика: сбой загрузки
  // проекта (в том числе анонимный 401) или отсутствие смысла (не LINE,
  // либо в линейке всего один товар — переносить не на что) — просто не
  // показываем карточку, а не превращаем её в ещё один источник ошибок
  // на и без того насыщенном экране результата.
  if (loading || error || !project) return null;
  if (project.type !== 'LINE' || project.items.length <= 1) return null;
  if (library.loading) return null;

  if (!library.allowed) {
    return (
      <LockedNote title={dict.catalogBatch.panelTitle} lock={library.lock}>
        {dict.catalogBatch.panelLockedBody}
      </LockedNote>
    );
  }

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Layers size={18} className="text-accent" />}
        title={dict.catalogBatch.panelTitle}
        hint={dict.catalogBatch.panelHint}
      />
      <Button
        block
        variant="outline"
        icon={<Layers size={14} />}
        onClick={() => navigate(routes.catalogBatchStart(projectId, sessionId))}
      >
        {dict.catalogBatch.panelCta}
      </Button>
    </Card>
  );
}
