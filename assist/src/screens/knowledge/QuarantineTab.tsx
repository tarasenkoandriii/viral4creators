import { useState } from 'react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Card, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import type { ModeKnowledgeClient } from '../../lib/knowledge-api';
import type { QuarantineView } from '../../lib/knowledge-types';
import { ConfirmButton, LoadError, NoticeBar, type Notice } from './parts';
import { useErrorText } from '../../lib/use-error-text';

/**
 * Карантин (§4-тер.7): фрагменты с признаками инъекции. Отрывок — ДАННЫЕ:
 * выводится текстом (React экранирует), не HTML и не Markdown, — чтобы
 * отравленная страница не исполнилась хотя бы в нашем кабинете.
 */
export function QuarantineTab({ client }: { client: ModeKnowledgeClient }) {
  const { dict, locale } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.quarantine;
  const errText = useErrorText();
  const list = useAsync(() => client.quarantine(), [client]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setNotice(null);
    try {
      setNotice({ tone: 'success', text: await fn() });
      list.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  const allow = (q: QuarantineView) =>
    run(`allow:${q.chunkId}`, async () => {
      const v = await client.allowQuarantined(q.chunkId);
      return fmt(t.allowed, { n: v.number });
    });
  const exclude = (q: QuarantineView) =>
    run(`ex:${q.chunkId}`, async () => {
      await client.addExclusion(
        q.url
          ? { kind: 'url', value: q.url }
          : { kind: 'document', value: q.documentId }
      );
      return appDict.knowledge.documents.excluded;
    });

  return (
    <div className="space-y-3">
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      {list.loading && !list.data ? (
        <Spinner label={dict.common.loading} />
      ) : !list.data ? (
        <LoadError error={list.error} onRetry={list.reload} />
      ) : list.data.length === 0 ? (
        <Card className="text-sm text-silver-500">{t.empty}</Card>
      ) : (
        list.data.map((q) => (
          <Card key={q.chunkId} className="space-y-2 text-sm">
            <div className="font-semibold break-all">
              {q.title || q.url || q.documentId}
            </div>
            {q.url && (
              <div className="font-mono text-xs break-all text-silver-500">
                {q.url}
              </div>
            )}
            <blockquote className="whitespace-pre-wrap break-words rounded-lg bg-silver-100 dark:bg-silver-950 px-3 py-2 text-xs">
              {q.excerpt}
            </blockquote>
            <div className="text-xs text-silver-500">
              {q.reason && `${fmt(t.reason, { reason: q.reason })} · `}
              {formatDate(q.createdAt, locale)}
            </div>
            <div className="flex flex-wrap gap-2">
              <ConfirmButton
                variant="outline"
                hint={t.allowHint}
                loading={busy === `allow:${q.chunkId}`}
                onConfirm={() => allow(q)}
              >
                {t.allow}
              </ConfirmButton>
              <ConfirmButton
                variant="danger"
                hint={appDict.knowledge.documents.excludeHint}
                loading={busy === `ex:${q.chunkId}`}
                onConfirm={() => exclude(q)}
              >
                {t.exclude}
              </ConfirmButton>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
