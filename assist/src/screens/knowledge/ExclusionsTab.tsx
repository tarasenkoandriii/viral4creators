import { useState } from 'react';
import { Ban } from 'lucide-react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Card, Spinner, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import type { ModeKnowledgeClient } from '../../lib/knowledge-api';
import type { ExclusionView } from '../../lib/knowledge-types';
import { normalizePageUrl } from '../../lib/knowledge-view';
import { ConfirmButton, LoadError, NoticeBar, type Notice } from './parts';
import { useErrorText } from '../../lib/use-error-text';

/** Вручную человек исключает адрес или раздел; фрагмент и документ — из других вкладок. */
const MANUAL_KINDS = ['url', 'urlPrefix'] as const;

/**
 * Исключения «этого не знать» (§4-тер.12): удаление из всех версий сразу,
 * откат не возвращает, переобход не берёт. Снятие — страница вернётся
 * со следующим обходом.
 */
export function ExclusionsTab({ client }: { client: ModeKnowledgeClient }) {
  const { dict, locale } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.exclusions;
  const errText = useErrorText();
  const list = useAsync(() => client.exclusions(), [client]);
  const [kind, setKind] = useState<(typeof MANUAL_KINDS)[number]>('url');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function add() {
    const url = normalizePageUrl(value);
    if (!url) {
      setNotice({ tone: 'warning', text: t.invalid });
      return;
    }
    setBusy('add');
    setNotice(null);
    try {
      const r = await client.addExclusion({
        kind,
        value: url,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setValue('');
      setReason('');
      setNotice({
        tone: 'success',
        text: fmt(t.added, { n: r.chunksDeleted }),
      });
      list.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function lift(x: ExclusionView) {
    setBusy(x.id);
    setNotice(null);
    try {
      await client.liftExclusion(x.id);
      setNotice({ tone: 'success', text: t.lifted });
      list.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      <Card className="space-y-2 text-sm">
        <div className="flex flex-wrap gap-2">
          {MANUAL_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-1">
              <input
                type="radio"
                name="exclusion-kind"
                checked={kind === k}
                onChange={() => setKind(k)}
              />
              {t.kind[k]}
            </label>
          ))}
        </div>
        <div className="text-xs text-silver-500">{t.kindHint}</div>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://example.com/old-prices"
          aria-label={t.value}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={`${inputClass} font-mono`}
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t.reason}
          maxLength={300}
          className={inputClass}
        />
        {/* Необратимо: фрагменты уходят из всех версий, откат не вернёт
            (§4-тер.12) — два нажатия, как «Исключить» у документа. */}
        <ConfirmButton
          variant="danger"
          icon={<Ban size={16} />}
          hint={appDict.knowledge.documents.excludeHint}
          loading={busy === 'add'}
          disabled={!value.trim()}
          onConfirm={() => void add()}
        >
          {t.add}
        </ConfirmButton>
      </Card>

      {list.loading && !list.data ? (
        <Spinner label={dict.common.loading} />
      ) : !list.data ? (
        <LoadError error={list.error} onRetry={list.reload} />
      ) : list.data.length === 0 ? (
        <Card className="text-sm text-silver-500">{t.empty}</Card>
      ) : (
        <div className="space-y-2">
          {list.data.map((x) => (
            <Card key={x.id} className="space-y-1 text-sm">
              <div className="text-xs text-silver-500">{t.kind[x.kind]}</div>
              <div className="font-mono text-xs break-all">{x.value}</div>
              {x.reason && <div>{x.reason}</div>}
              <div className="text-xs text-silver-500">
                {fmt(t.deleted, { n: x.chunksDeleted })} ·{' '}
                {formatDate(x.createdAt, locale)}
              </div>
              <ConfirmButton
                variant="ghost"
                hint={t.liftHint}
                loading={busy === x.id}
                onConfirm={() => lift(x)}
              >
                {t.lift}
              </ConfirmButton>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
