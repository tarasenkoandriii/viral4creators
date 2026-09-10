/**
 * AbTestPanel — «Создать 3 A/B-варианта» (TODO §III.6, этап 66). Показывается
 * на экране готового ролика (там же, где CatalogBatchPanel): из уже
 * одобренного разбора + промпта этой сессии собираются 3 дополнительных
 * дубля, отличающихся только хуком (открывающий бит) и CTA (закрывающий
 * бит) — раскадровка, камера, персонажи, темп и цвет остаются теми же.
 *
 * Только Premium (`PlanFeature 'library'` — тот же признак, что и у
 * пакетной генерации по каталогу: механика тоже целиком построена на
 * `LibraryService.applyToSession`). В отличие от CatalogBatchPanel кнопка
 * НЕ ведёт на отдельный экран выбора — нечего выбирать (решение владельца
 * продукта: всегда ровно 3 варианта, парные хук+CTA, без матрицы) — сразу
 * запускает создание запуска (один синхронный вызов GPT-5, может занять
 * несколько секунд) и по успеху переходит на экран прогресса.
 */

import { useState } from 'react';
import { SplitSquareHorizontal } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  LockedNote,
} from '../../components/ui';
import { startAbTest } from '../../services/ab-test-api';
import { errorMessage } from '../../services/projects-api';
import { navigate, routes } from '../../lib/router';
import { useFeature } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';

export function AbTestPanel({
  sessionId,
  projectId,
}: {
  sessionId: string;
  projectId: string;
}) {
  const { dict } = useI18n();
  const library = useFeature('library');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (library.loading) return null;

  if (!library.allowed) {
    return (
      <LockedNote title={dict.abTest.panelTitle} lock={library.lock}>
        {dict.abTest.panelLockedBody}
      </LockedNote>
    );
  }

  const onCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await startAbTest(projectId, sessionId);
      navigate(routes.abTest(projectId, result.runId));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<SplitSquareHorizontal size={18} className="text-accent" />}
        title={dict.abTest.panelTitle}
        hint={dict.abTest.panelHint}
      />

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Button
        block
        variant="outline"
        icon={<SplitSquareHorizontal size={14} />}
        loading={busy}
        onClick={() => void onCreate()}
      >
        {dict.abTest.panelCta}
      </Button>
      <p className="mt-2 text-xs text-silver-400">
        {dict.abTest.panelCreditsNote}
      </p>
    </Card>
  );
}
