/**
 * «Голос → Мемо → Из обучалки» (Э6-тер (к), ТЗ §5-бис.17 п.6): список
 * одобренных обучалок ЭТОГО сайта (режим A) с мемо, уже сделанным из
 * каждой, и «Создать черновик» — шаги у генератора, вход и значения
 * отброшены там же; черновик открывается в карточке раздела (ворота,
 * сборка, прогон, публикация — как у любого мемо).
 */
import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { fmt, useAsync, useKit } from '../../kit';
import { Badge, Button } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { memoTutorialErrorCode } from '../../lib/memo-tutorial-api';
import { useSetupErrorText } from '../../lib/use-error-text';
import { NoticeBar, type Notice } from '../knowledge/parts';
import { MEMO_TUTORIAL_TEXTS } from './memo-tutorial-texts';

export function MemoFromTutorial({
  siteId,
  full,
  onCreated,
  onOpen,
}: {
  siteId: string;
  /** Лимит тарифа исчерпан — создавать нельзя (сервер всё равно 402). */
  full: boolean;
  onCreated: (n: number) => void;
  onOpen: (n: number) => void;
}) {
  const { voiceControl, appDict } = useAssist();
  const { locale } = useKit();
  const t = MEMO_TUTORIAL_TEXTS[locale] ?? MEMO_TUTORIAL_TEXTS.uk;
  const errText = useSetupErrorText();
  const api = voiceControl.memoTutorial;
  const [shown, setShown] = useState(false);
  const list = useAsync(
    () => (shown ? api.list(siteId) : Promise.resolve(null)),
    [api, siteId, shown]
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const create = async (draftId: string) => {
    setBusy(draftId);
    setNotice(null);
    try {
      const r = await api.create(siteId, draftId);
      const parts = [fmt(t.created, { n: r.memo.number })];
      if (r.unresolved.length)
        parts.push(fmt(t.unresolved, { list: r.unresolved.join(', ') }));
      if (r.droppedLogin)
        parts.push(fmt(t.droppedLogin, { n: r.droppedLogin }));
      if (r.slotsOverflow) parts.push(fmt(t.overflow, { n: r.slotsOverflow }));
      setNotice({
        tone: r.unresolved.length || r.slotsOverflow ? 'warning' : 'success',
        text: parts.join(' '),
      });
      list.reload();
      onCreated(r.memo.number);
    } catch (e) {
      const code = memoTutorialErrorCode(e);
      setNotice({ tone: 'danger', text: code ? t.errors[code] : errText(e) });
      if (code === 'MEMO_TUTORIAL_EXISTS') list.reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        icon={<GraduationCap size={16} />}
        onClick={() => setShown(!shown)}
      >
        {shown ? t.close : t.open}
      </Button>
      {shown && (
        <div className="space-y-2 text-xs">
          <p className="text-silver-500">{t.intro}</p>
          <NoticeBar notice={notice} />
          {list.data && !list.data.configured && (
            <p className="text-amber-700">{t.notConfigured}</p>
          )}
          {list.data && list.data.items.length === 0 && <p>{t.empty}</p>}
          {list.data?.items.map((it) => (
            <div
              key={it.draftId}
              className="rounded-lg border border-silver-200 dark:border-silver-800 p-2 space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{it.title}</span>
                {it.memo && (
                  <Badge tone="neutral">
                    {appDict.voiceControl.memo.status[it.memo.status]}
                  </Badge>
                )}
              </div>
              {it.requiresLogin && (
                <div className="text-silver-500">{t.login}</div>
              )}
              {it.memo ? (
                <Button
                  variant="ghost"
                  onClick={() => it.memo && onOpen(it.memo.number)}
                >
                  {fmt(t.openMemo, { n: it.memo.number })}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  loading={busy === it.draftId}
                  disabled={!!busy || full || !list.data?.configured}
                  onClick={() => void create(it.draftId)}
                >
                  {t.create}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
