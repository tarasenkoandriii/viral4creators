import { useState } from 'react';
import { useKit } from '../../kit';
import { Alert, Badge, Button, Card, inputClass } from '../../kit/ui';
import type { Proposal } from '../../lib/admin-actions-api';
import { useAssist } from '../../lib/assist-context';
import { useErrorText } from '../../lib/use-error-text';
import { useActionsTexts } from '../../lib/admin-mode-view';

/**
 * Э8: карточка подтверждения действия в TMA (ТЗ §5.4 п.5–6, §5.7): поля
 * «было → станет», пометки («без вашей просьбы», «отменить нельзя»,
 * «без предпросмотра»), для danger — слово подтверждения; «Да» —
 * отдельный запрос с хешем параметров, которые видел человек. Итог — с
 * сервера (повторного исполнения не бывает, §4-бис.5). Текст — только
 * текстом, без HTML.
 */
export function ProposalCard({
  siteId,
  p,
  onChange,
}: {
  siteId: string;
  p: Proposal;
  onChange: () => void;
}) {
  const { locale } = useKit();
  const { adminActions } = useAssist();
  const t = useActionsTexts();
  const errText = useErrorText();
  const [phrase, setPhrase] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
      onChange();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = (v: string | string[] | null | undefined) =>
    v === null || v === undefined ? '—' : Array.isArray(v) ? v.join(', ') : v;
  return (
    <Card
      className={`space-y-2 border-l-4 ${p.kind === 'danger' ? 'border-l-rose-500' : 'border-l-sky-500'}`}
    >
      <div className="font-semibold text-sm">
        {p.compensationOf ? t.card.undoTitle : t.card.title} {p.title}{' '}
        <Badge tone={p.kind === 'danger' ? 'danger' : 'warning'}>
          {p.kind}
        </Badge>
      </div>
      {p.memoStep !== null && (
        <div className="text-xs text-silver-500">
          {t.card.memoStep} {p.memoStep + 1}
        </div>
      )}
      <ul className="text-sm list-disc pl-5">
        {p.fields.map((f) => (
          <li key={f.name}>
            <b>{f.name}:</b>{' '}
            {f.before !== undefined && (
              <>
                <s className="text-silver-500">{shown(f.before)}</s> →{' '}
              </>
            )}
            {shown(f.after)}
          </li>
        ))}
      </ul>
      {p.amount !== null && (
        <div className="text-xs">
          {t.card.amount}: {p.amount}
        </div>
      )}
      {p.unrequested && <Alert tone="warning">{t.card.unrequested}</Alert>}
      {p.kind === 'danger' && !p.undoDeclared && (
        <Alert tone="warning">{t.card.noUndo}</Alert>
      )}
      {p.dryRun === 'none' && p.status === 'pending' && (
        <div className="text-xs text-silver-500">{t.card.noPreview}</div>
      )}
      {p.dryRunStatus === 'failed' && p.dryRunNote && (
        <Alert tone="warning">
          {t.card.dryFailed} {p.dryRunNote}
        </Alert>
      )}
      <div className="text-sm">
        {t.card.status[p.status]}
        {p.errorText ? ` ${p.errorText}` : ''}
        {p.chainStatus && p.chainStatus !== 'committed'
          ? ` · ${t.card.chain[p.chainStatus] ?? p.chainStatus}`
          : ''}
      </div>
      {err && <Alert tone="danger">{err}</Alert>}
      {checked && <div className="text-xs">{checked}</div>}
      {p.status === 'pending' && (
        <div className="space-y-2">
          {p.confirmPhrase && (
            <label className="block text-xs">
              {t.card.phraseHint} <b>{p.confirmPhrase}</b>
              <input
                className={inputClass}
                value={phrase}
                autoComplete="off"
                onChange={(e) => setPhrase(e.target.value)}
              />
            </label>
          )}
          <div className="flex gap-2">
            <Button
              loading={busy}
              onClick={() =>
                void run(() =>
                  adminActions.confirm(
                    siteId,
                    p.id,
                    {
                      paramsHash: p.paramsHash,
                      ...(p.confirmPhrase ? { phrase } : {}),
                    },
                    locale
                  )
                )
              }
            >
              {t.card.yes}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() => adminActions.reject(siteId, p.id, locale))
              }
            >
              {t.card.no}
            </Button>
          </div>
        </div>
      )}
      {p.status === 'unknown' && (
        <div className="space-y-2">
          {p.confirmPhrase && (
            <label className="block text-xs">
              {t.card.phraseHint} <b>{p.confirmPhrase}</b>
              <input
                className={inputClass}
                value={phrase}
                autoComplete="off"
                onChange={(e) => setPhrase(e.target.value)}
              />
            </label>
          )}
          {!p.idempotent && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              {t.card.retryAck}
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {p.checkAvailable && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await adminActions.check(siteId, p.id);
                    setChecked(
                      r.available
                        ? r.fields
                            .map((f) => `${f.name}: ${shown(f.now)}`)
                            .join('; ')
                        : t.card.checkNone
                    );
                  })
                }
              >
                {t.card.check}
              </Button>
            )}
            <Button
              variant="outline"
              loading={busy}
              onClick={() =>
                void run(() =>
                  adminActions.confirm(
                    siteId,
                    p.id,
                    {
                      paramsHash: p.paramsHash,
                      ...(p.confirmPhrase ? { phrase } : {}),
                      ...(p.idempotent ? {} : { acknowledgeRisk: ack }),
                    },
                    locale
                  )
                )
              }
            >
              {t.card.retry}
            </Button>
          </div>
        </div>
      )}
      {p.status === 'done' && p.undoAvailable && (
        <Button
          variant="outline"
          loading={busy}
          onClick={() => void run(() => adminActions.compensate(siteId, p.id))}
        >
          {t.card.undo}
        </Button>
      )}
    </Card>
  );
}
