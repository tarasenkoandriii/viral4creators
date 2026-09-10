/**
 * FeedImportPanel — вход в импорт товарного фида по ссылке (TODO
 * §Уровень 2 п.8, этап 68, §47). Показывается на экране проекта
 * (`ProjectScreen`) для LINE-проекта — рядом с ручным добавлением
 * позиций, а не только после первого заполненного товара: продавец с
 * каталогом на 300 позиций обычно начинает именно с фида, а не с одной
 * руками заведённой позиции.
 *
 * Тот же гейт `useFeature('library')`, что у `CatalogBatchPanel`/
 * `AbTestPanel` — та же аудитория (продавец с каталогом, не разовый
 * проект). В отличие от `CatalogBatchPanel`, здесь не нужен свой
 * `useAsync(getProject)`: панель уже монтируется внутри `ProjectScreen`,
 * которому проект известен.
 */

import { Rss } from 'lucide-react';
import { Button, Card, CardHeader, LockedNote } from '../../components/ui';
import { navigate, routes } from '../../lib/router';
import { useFeature } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';

export function FeedImportPanel({ projectId }: { projectId: string }) {
  const { dict } = useI18n();
  const library = useFeature('library');

  if (library.loading) return null;

  if (!library.allowed) {
    return (
      <LockedNote title={dict.feedImport.panelTitle} lock={library.lock}>
        {dict.feedImport.panelLockedBody}
      </LockedNote>
    );
  }

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Rss size={18} className="text-accent" />}
        title={dict.feedImport.panelTitle}
        hint={dict.feedImport.panelHint}
      />
      <Button
        block
        variant="outline"
        icon={<Rss size={14} />}
        onClick={() => navigate(routes.feedImportStart(projectId))}
      >
        {dict.feedImport.panelCta}
      </Button>
    </Card>
  );
}
