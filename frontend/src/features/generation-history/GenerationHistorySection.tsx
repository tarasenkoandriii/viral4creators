import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Spinner } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { getDictionary } from '../../lib/get-dictionary';
import { GUIDE_IDENTITY_EVENT } from '../../lib/guide-assist';
import {
  createPrivateHistoryPager,
  type HistoryView,
} from '../../lib/private-history-pager';
import {
  listGenerationHistory,
  type GenerationHistoryItem,
} from '../../services/generation-history-api';

function HistoryList() {
  const { dict, locale } = useI18n();
  const t = dict.generationHistory ?? getDictionary('en').generationHistory;
  const [view, setView] = useState<HistoryView<GenerationHistoryItem>>({
    items: [],
    nextCursor: null,
    loading: true,
    error: null,
  });
  const pagerRef = useRef<ReturnType<
    typeof createPrivateHistoryPager<GenerationHistoryItem>
  > | null>(null);
  useEffect(() => {
    const pager = createPrivateHistoryPager(listGenerationHistory);
    pagerRef.current = pager;
    const off = pager.subscribe(setView);
    if (document.visibilityState !== 'hidden') void pager.reload();
    const clear = () => pager.reset();
    const reload = () => {
      if (document.visibilityState !== 'hidden') void pager.reload();
    };
    const identity = () => {
      clear();
      reload();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') clear();
      else reload();
    };
    window.addEventListener(GUIDE_IDENTITY_EVENT, identity);
    window.addEventListener('blur', clear);
    window.addEventListener('focus', reload);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      off();
      pager.dispose();
      pagerRef.current = null;
      window.removeEventListener(GUIDE_IDENTITY_EVENT, identity);
      window.removeEventListener('blur', clear);
      window.removeEventListener('focus', reload);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  return (
    <div className="mt-3 space-y-3" aria-busy={view.loading}>
      <p className="text-sm text-[var(--muted)]">{t.hint}</p>
      <Button
        size="sm"
        variant="outline"
        disabled={view.loading}
        onClick={() => void pagerRef.current?.reload()}
      >
        {t.refresh}
      </Button>
      {view.loading && (
        <div role="status">
          <Spinner size={20} />
        </div>
      )}
      {view.error && (
        <Alert tone={view.error === 'auth' ? 'info' : 'error'}>
          {view.error === 'auth' ? t.auth : t.error}
        </Alert>
      )}
      {!view.loading && !view.error && view.items.length === 0 && (
        <p className="text-sm">{t.empty}</p>
      )}
      <ol className="space-y-2" aria-label={t.title}>
        {view.items.map((item) => (
          <li
            key={item.id}
            className="rounded-xl border border-[var(--border)] p-3"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <strong className="text-sm">
                {t.attempt} {item.id.slice(0, 8)} · {t[item.status]}
              </strong>
              {item.resolution && (
                <span className="text-xs">{item.resolution}</span>
              )}
            </div>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {t.recorded}:{' '}
              <time dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString(locale)}
              </time>
            </p>
            {item.status === 'unknown' && (
              <p className="mt-2 text-sm">{t.unknownHint}</p>
            )}
          </li>
        ))}
      </ol>
      {view.nextCursor && (
        <Button
          size="sm"
          variant="outline"
          disabled={view.loading}
          onClick={() => void pagerRef.current?.more()}
        >
          {t.more}
        </Button>
      )}
    </div>
  );
}

export function GenerationHistorySection() {
  const { dict } = useI18n();
  const t = dict.generationHistory ?? getDictionary('en').generationHistory;
  const [open, setOpen] = useState(false);
  return (
    <section className="mb-4 rounded-xl border border-[var(--border)] p-3">
      <details
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm font-semibold">
          {t.title}
        </summary>
        {open && <HistoryList />}
      </details>
    </section>
  );
}
