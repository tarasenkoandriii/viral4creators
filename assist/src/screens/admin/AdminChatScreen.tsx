import { useState } from 'react';
import { useAsync, useKit } from '../../kit';
import { Alert, Button, Card, ScreenTitle, Spinner } from '../../kit/ui';
import type { AdminChatMessage } from '../../lib/admin-mode-api';
import { useAssist } from '../../lib/assist-context';
import { useErrorText } from '../../lib/use-error-text';
import { LoadError, textareaClass } from '../knowledge/parts';
import { useAdminTexts } from '../../lib/admin-mode-view';

/**
 * Помощник сотрудника в TMA — 7a (ТЗ §5.1 «Из TMA»): участник кабинета с
 * `assistAdmin: owner|employee`. Ответы — по знаниям «Админки» и (по роли)
 * read-операциям API. Текст ответа — только текстом (без HTML/ссылок).
 */
export function AdminChatScreen({ siteId }: { siteId: string }) {
  const { account } = useKit();
  const { adminMode } = useAssist();
  const t = useAdminTexts();
  const errText = useErrorText();
  const st = useAsync(() => adminMode.chatState(siteId), [siteId]);
  const [extra, setExtra] = useState<AdminChatMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fix, setFix] = useState<Record<string, string>>({});
  const [thanks, setThanks] = useState<string | null>(null);
  if (
    account.me.role !== 'owner' &&
    account.me.productRoles.assistAdmin === 'none'
  ) {
    return <Alert tone="warning">{t.noAccess}</Alert>;
  }
  if (st.loading && !st.data) return <Spinner />;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  const messages = [...st.data.messages, ...extra];
  const ask = async () => {
    const q = text.trim();
    if (!q) return;
    setBusy(true);
    setErr(null);
    try {
      const rid = `tma${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const pair = await adminMode.chatAsk(siteId, q, rid);
      setExtra((x) => [...x, ...pair]);
      setText('');
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <ScreenTitle>{t.chat.title}</ScreenTitle>
      {!st.data.tools && <Alert>{t.chat.knowledgeOnly}</Alert>}
      {err && <Alert tone="danger">{err}</Alert>}
      {thanks && <Alert tone="success">{thanks}</Alert>}
      {messages.map((m) => (
        <Card key={m.id} className={m.role === 'employee' ? 'ml-8' : 'mr-8'}>
          <div className="whitespace-pre-wrap text-sm">{m.text}</div>
          {m.role === 'assistant' && (
            <div className="mt-2 space-y-1">
              <textarea
                className={textareaClass}
                placeholder={t.chat.fix}
                value={fix[m.id] ?? ''}
                onChange={(e) => setFix({ ...fix, [m.id]: e.target.value })}
              />
              <Button
                variant="outline"
                onClick={() =>
                  void adminMode
                    .chatFeedback(
                      siteId,
                      m.id,
                      -1,
                      (fix[m.id] ?? '').trim() || undefined
                    )
                    .then(() => setThanks(t.chat.thanks))
                    .catch((e) => setErr(errText(e)))
                }
              >
                👎 {t.chat.fixSend}
              </Button>
            </div>
          )}
        </Card>
      ))}
      <textarea
        className={textareaClass}
        maxLength={2000}
        placeholder={t.chat.placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button loading={busy} onClick={() => void ask()}>
        {busy ? t.chat.thinking : t.chat.send}
      </Button>
    </div>
  );
}
