import { useState } from 'react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Alert, Badge, Card, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import type { ModeKnowledgeClient } from '../../lib/knowledge-api';
import type { VersionView } from '../../lib/knowledge-types';
import {
  failedGateChecks,
  versionActions,
  versionLabelKey,
  versionStats,
  versionTone,
} from '../../lib/knowledge-view';
import { ConfirmButton, LoadError, NoticeBar, type Notice } from './parts';
import { useErrorText } from '../../lib/use-error-text';

/** Доли ворот (0..1) — процентами, остальное (п.п., число провалов) как есть. */
function gateValue(check: string, v: number): string {
  return check.endsWith('_share') ? `${Math.round(v * 100)}%` : String(v);
}

/**
 * Версии базы (§4-тер.2, §4-тер.13): история, статус, что изменилось;
 * удержанная — с причиной (проверки ворот) и кнопками «опубликовать как
 * есть» / «отбросить»; откат — в окне 7 дней / 5 публикаций.
 */
export function VersionsTab({ client }: { client: ModeKnowledgeClient }) {
  const { dict, locale } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.versions;
  const errText = useErrorText();
  const versions = useAsync(() => client.versions(), [client]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function act(
    v: VersionView,
    action: 'publish' | 'discard' | 'rollback'
  ) {
    setBusy(`${v.number}:${action}`);
    setNotice(null);
    try {
      const r = await client.versionAction(v.number, action);
      setNotice({ tone: 'success', text: fmt(t.done, { n: r.number }) });
      versions.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
      versions.reload();
    } finally {
      setBusy(null);
    }
  }

  if (versions.loading && !versions.data) {
    return <Spinner label={dict.common.loading} />;
  }
  if (!versions.data) {
    return <LoadError error={versions.error} onRetry={versions.reload} />;
  }
  const list = [...versions.data].sort((a, b) => b.number - a.number);

  return (
    <div className="space-y-3">
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      {list.length === 0 && (
        <Card className="text-sm text-silver-500">{t.empty}</Card>
      )}
      {list.map((v) => {
        const a = versionActions(v);
        const st = versionStats(v);
        const failed = failedGateChecks(v.gateReport);
        return (
          <Card key={v.number} className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold flex-1">
                {fmt(t.number, { n: v.number })}
              </span>
              <Badge tone={versionTone(v)}>
                {t.status[versionLabelKey(v)]}
              </Badge>
            </div>
            <div className="text-silver-500">
              {t.trigger[v.trigger]} · {fmt(t.stats, st)}
            </div>
            <div className="text-xs text-silver-500">
              {fmt(t.created, { date: formatDate(v.createdAt, locale) })}
              {v.publishedAt &&
                ` · ${fmt(t.publishedAt, { date: formatDate(v.publishedAt, locale) })}`}
            </div>
            {v.gateReport?.coldStart && (
              <div className="text-xs text-silver-500">{t.coldStart}</div>
            )}
            {v.status === 'held' && (
              <Alert tone="warning" title={t.heldBecause}>
                {v.heldReason && <div>{v.heldReason}</div>}
                {failed.length > 0 && (
                  <ul className="list-disc pl-5">
                    {failed.map((c) => (
                      <li key={c.check}>
                        {fmt(t.gate[c.check], {
                          value: gateValue(c.check, c.value),
                          threshold: gateValue(c.check, c.threshold),
                        })}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-1">{t.heldHint}</div>
              </Alert>
            )}
            {(a.publish || a.discard || a.rollback) && (
              <div className="flex flex-wrap gap-2">
                {a.publish && (
                  <ConfirmButton
                    variant="solid"
                    loading={busy === `${v.number}:publish`}
                    onConfirm={() => act(v, 'publish')}
                  >
                    {t.publish}
                  </ConfirmButton>
                )}
                {a.discard && (
                  <ConfirmButton
                    variant="outline"
                    loading={busy === `${v.number}:discard`}
                    onConfirm={() => act(v, 'discard')}
                  >
                    {t.discard}
                  </ConfirmButton>
                )}
                {a.rollback && (
                  <ConfirmButton
                    variant="outline"
                    hint={t.rollbackHint}
                    loading={busy === `${v.number}:rollback`}
                    onConfirm={() => act(v, 'rollback')}
                  >
                    {t.rollback}
                  </ConfirmButton>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
