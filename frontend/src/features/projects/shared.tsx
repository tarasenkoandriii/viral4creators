import type { ReactNode } from 'react';
import { ChevronLeft, LogIn } from 'lucide-react';
import { Alert, Button, EmptyState } from '../../components/ui';
import { errorMessage, isUnauthorized } from '../../services/projects-api';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';

/**
 * Back link + title row used by every projects screen.
 *
 * `titleUgc` (Ш6 (10)): заголовок — текст пользователя (название проекта,
 * товара, манифеста). Пометка `data-assist-ugc` — на самом `<h1>`, а не
 * на `<span>` внутри: обход «Админки» воркером берёт заголовок целиком
 * (`browser-worker/src/page/collect.ts`), снимок исполнителя ищет
 * заголовок-контекст по `h1…h4`.
 */
export function ScreenHeader({
  title,
  back,
  hint,
  action,
  titleUgc = false,
}: {
  title: ReactNode;
  back?: string;
  hint?: ReactNode;
  action?: ReactNode;
  titleUgc?: boolean;
}) {
  const { dict } = useI18n();
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        {back && (
          <button
            type="button"
            onClick={() => navigate(back)}
            className="mb-1 inline-flex min-h-[44px] items-center gap-0.5 text-xs text-silver-400 hover:text-accent"
          >
            <ChevronLeft size={14} /> {dict.projectsShared.backLabel}
          </button>
        )}
        <h1
          className="text-xl font-bold tracking-tight truncate"
          data-assist-ugc={titleUgc ? '' : undefined}
        >
          {title}
        </h1>
        {hint && <p className="text-xs text-silver-400 mt-0.5">{hint}</p>}
      </div>
      {action && <div className="shrink-0 pt-1">{action}</div>}
    </div>
  );
}

/**
 * Error state for /projects calls. 401 gets its own explanation: the
 * catalog needs an identity (spec §7.8 addendum), while quick anonymous
 * generation stays available.
 */
export function LoadError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const { dict } = useI18n();
  if (isUnauthorized(error)) {
    return (
      <EmptyState
        icon={<LogIn size={28} />}
        title={dict.projectsShared.unauthorizedTitle}
        hint={dict.projectsShared.unauthorizedHint}
        action={
          <Button variant="outline" onClick={() => navigate(routes.generate())}>
            {dict.projectsShared.quickGenerateButton}
          </Button>
        }
      />
    );
  }
  return (
    <Alert tone="error" title={dict.projectsShared.loadErrorTitle}>
      <div className="flex items-center justify-between gap-3">
        <span>{errorMessage(error)}</span>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {dict.projectsShared.retryButton}
          </Button>
        )}
      </div>
    </Alert>
  );
}
