/**
 * FeedImportStartScreen — ссылка на товарный фид (TODO §Уровень 2 п.8,
 * этап 68, §47). Продавец вставляет ссылку на свой YML- или CSV-фид
 * (Rozetka/Prom/Shopify-плагин/WooCommerce-экспортёр/«Мой склад»/
 * ручная выгрузка) — формат сервер определяет сам по содержимому. После
 * отправки — переход на экран прогресса (`FeedImportProgressScreen`),
 * который опрашивает статус, пока крон-воркер скачивает и разбирает
 * фид, затем заводит позиции по одной.
 *
 * Реальная проверка адреса (SSRF-guard, доступность извне) — только на
 * сервере (`assertPubliclyRoutableUrl`); здесь только формальная
 * валидация `type="url"` — подсказать явную опечатку, не более.
 */

import { useState } from 'react';
import { Rss } from 'lucide-react';
import { Alert, Button, Card, Field, Input } from '../../components/ui';
import { startFeedImport } from '../../services/product-feed-import-api';
import { errorMessage } from '../../services/projects-api';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import { ScreenHeader } from './shared';

export function FeedImportStartScreen({ projectId }: { projectId: string }) {
  const { dict } = useI18n();
  const [sourceUrl, setSourceUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = sourceUrl.trim().length > 0 && !submitting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await startFeedImport(projectId, sourceUrl.trim());
      navigate(routes.feedImport(projectId, result.runId), true);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.feedImport.startTitle}
        back={routes.project(projectId)}
        hint={dict.feedImport.startHint}
      />

      <Card className="p-5">
        <form onSubmit={submit} className="space-y-5">
          <Field
            label={dict.feedImport.urlLabel}
            htmlFor="feed-import-url"
            hint={dict.feedImport.urlHint}
          >
            <Input
              id="feed-import-url"
              type="url"
              inputMode="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder={dict.feedImport.urlPlaceholder}
              disabled={submitting}
              autoFocus
            />
          </Field>

          <Alert tone="info">{dict.feedImport.snapshotNote}</Alert>

          {error && <Alert tone="error">{error}</Alert>}

          <Button
            block
            size="lg"
            type="submit"
            icon={<Rss size={16} />}
            disabled={!canSubmit}
            loading={submitting}
          >
            {dict.feedImport.startSubmitButton}
          </Button>
        </form>
      </Card>
    </div>
  );
}
