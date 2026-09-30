/**
 * Карточка блока «Характер ролика», которая не загрузилась (CONTRACT6
 * G-FE п. 10).
 *
 * Раньше сбой первого GET молча прятал карточку: `.catch(() => undefined)`
 * и `if (!view) return null`. Человек видел четыре карточки вместо пяти и
 * не знал, что голос или титры вообще можно настроить. Теперь на месте
 * карточки — её заголовок, причина и «Повторить».
 */

import type { ReactNode } from 'react';
import { Alert, Button, Card, CardHeader } from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';

export function CardLoadError({
  qa,
  icon,
  title,
  message,
  onRetry,
}: {
  /** Тот же `data-qa`, что у карточки: место в ленте то же. */
  qa: string;
  icon: ReactNode;
  title: string;
  message: string;
  onRetry: () => void;
}) {
  const { dict } = useI18n();
  return (
    <Card className="p-5" data-qa={qa}>
      <CardHeader icon={icon} title={title} />
      <Alert tone="error" title={dict.greetingUi.cardLoadFailed}>
        <div className="flex items-center justify-between gap-3">
          <span>{message}</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            {dict.greetingUi.cardRetryButton}
          </Button>
        </div>
      </Alert>
    </Card>
  );
}
