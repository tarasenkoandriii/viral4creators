/**
 * Базовый образ (ТЗ Greeting 2.0 §4.1 п.4): нейтральный портрет по
 * селфи — ровный свет, чистый фон. Показывается рядом с селфи, чтобы
 * человек сам сравнил сходство, и принимается или перегенерируется.
 *
 * Селфи с сервера не приходит никогда (§4.9: URL селфи не отдаётся на
 * фронтенд) — рядом стоит только снимок, сделанный в ЭТОЙ вкладке, пока
 * он ещё в памяти. После перезагрузки сравнивать не с чем, и экран
 * честно показывает один образ.
 */

import { Alert, Button, Card, CardHeader } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { lookState, type PersonaLook } from '../../lib/persona-flow';

export function PersonaBaseStep({
  base,
  localSelfieUrl,
  canRegenerate,
  busy,
  error,
  onAccept,
  onRegenerate,
}: {
  base: PersonaLook | null;
  localSelfieUrl: string | null;
  canRegenerate: boolean;
  busy: boolean;
  error: string | null;
  onAccept: () => void;
  onRegenerate: () => void;
}) {
  const { dict } = useI18n();
  const t = dict.persona;
  const state = base ? lookState(base) : 'pending';

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader title={t.baseTitle} hint={t.baseLead} />
      <div className="grid grid-cols-2 gap-3">
        {localSelfieUrl && (
          <figure>
            <figcaption className="label">{t.selfieLabel}</figcaption>
            <img
              src={localSelfieUrl}
              alt={t.photoPreviewAlt}
              className="aspect-square w-full rounded-xl object-cover"
              data-qa-mask="persona-selfie"
            />
          </figure>
        )}
        <figure className={localSelfieUrl ? '' : 'col-span-2 sm:col-span-1'}>
          <figcaption className="label">{t.baseLabel}</figcaption>
          {state === 'ready' && base?.photoUrl ? (
            <img
              src={base.photoUrl}
              alt={t.baseLabel}
              className="aspect-square w-full rounded-xl object-cover"
              data-qa-mask="persona-look"
            />
          ) : (
            <div
              className="flex aspect-square w-full items-center justify-center rounded-xl bg-silver-100 p-3 text-center text-xs text-silver-400 dark:bg-silver-900"
              role="status"
            >
              {state === 'failed' ? base?.error || t.lookFailed : t.basePending}
            </div>
          )}
        </figure>
      </div>
      <p className="mt-3 text-xs text-silver-400">{t.likenessNote}</p>
      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={state !== 'ready' || busy} onClick={onAccept}>
          {t.baseAccept}
        </Button>
        {canRegenerate && (
          <Button
            data-assist="confirm"
            variant="outline"
            loading={busy}
            disabled={state === 'pending'}
            onClick={onRegenerate}
          >
            {t.baseRegenerate}
          </Button>
        )}
      </div>
    </Card>
  );
}
