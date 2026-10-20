import { QaCatalogTools } from '../components/QaCatalogTools';
import { useEffect, useRef, useState } from 'react';
import { useKit } from '../kit';
import { Button, Card, inputClass } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import { navigate } from '../lib/router';
import { emptyQaCase, qaAccess, qaLabels, qaListInput } from '../lib/qa-editor';
import {
  isQaCaseConflict,
  type QaCaseHead,
  type QaCasePayload,
  type QaCaseRevision,
} from '../lib/qa-catalog-api';

export function QaCatalogButton({ siteId }: { siteId: string }) {
  const { account, locale } = useKit();
  if (!qaAccess(account.me).read) return null;
  return (
    <Button
      variant="outline"
      onClick={() => navigate({ name: 'qa-cases', siteId })}
    >
      {qaLabels(locale).title}
    </Button>
  );
}
export function QaCatalogScreen({ siteId }: { siteId: string }) {
  const { account } = useKit();
  return <Catalog key={`${account.account.id}:${siteId}`} siteId={siteId} />;
}
function Catalog({ siteId }: { siteId: string }) {
  const { account, locale, dict } = useKit();
  const { qaCatalog: api } = useAssist();
  const t = qaLabels(locale),
    access = qaAccess(account.me);
  const [items, setItems] = useState<QaCaseHead[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [selected, setSelected] = useState<QaCaseHead | null>(null);
  const [draft, setDraft] = useState<QaCasePayload | null>(null);
  const [caseKey, setCaseKey] = useState('');
  const [tags, setTags] = useState(''),
    [requirements, setRequirements] = useState('');
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [history, setHistory] = useState<QaCaseRevision[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Only unload protection; internal case switching asks before discarding as well.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (!access.read) return;
    let active = true;
    setBusy(true);
    api
      .list(siteId)
      .then((page) => {
        if (active) {
          setItems(page.items);
          setAfter(page.nextAfterKey);
        }
      })
      .catch(() => {
        if (active) setError(t.error);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, siteId, access.read, t.error]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      if (mounted.current) {
        setError(isQaCaseConflict(e) ? t.conflict : t.error);
        setConflict(isQaCaseConflict(e));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function accept(value: QaCasePayload) {
    setDraft(value);
    setTags(value.tags.join(', '));
    setRequirements(value.requirementIds.join(', '));
  }
  function discard() {
    return !dirty || window.confirm(t.discard);
  }
  async function open(id: string) {
    if (!discard()) return;
    await run(async () => {
      const item = await api.get(siteId, id);
      if (!mounted.current) return;
      setSelected(item);
      setCaseKey(item.caseKey);
      accept(item.revision.payload);
      setDirty(false);
      setConflict(false);
      setHistory([]);
      setBefore(null);
    });
  }
  function change(patch: Partial<QaCasePayload>) {
    if (draft) {
      setDraft({ ...draft, ...patch });
      setDirty(true);
    }
  }
  async function save() {
    if (!draft || !access.write) return;
    const tagList = qaListInput(tags),
      requirementList = qaListInput(requirements);
    if (!tagList || !requirementList) {
      setError(t.limits);
      return;
    }
    const value = { ...draft, tags: tagList, requirementIds: requirementList };
    await run(async () => {
      const head = selected
        ? {
            ...selected,
            ...(await api.replace(
              siteId,
              selected.id,
              selected.currentVersion,
              value
            )),
            title: value.title,
            archived: value.archived,
          }
        : await api.create(siteId, caseKey, value);
      if (!mounted.current) return;
      setSelected(head);
      setCaseKey(head.caseKey);
      accept(value);
      setDirty(false);
      setConflict(false);
      setHistory([]);
      setBefore(null);
      setNotice(t.saved);
      // Avoid a second request after save: a list refresh failure must not suggest the save failed.
      setItems((prev) =>
        [...prev.filter((x) => x.id !== head.id), head].sort((a, b) =>
          a.caseKey.localeCompare(b.caseKey)
        )
      );
    });
  }
  async function loadHistory(next?: number) {
    if (!selected) return;
    await run(async () => {
      const page = await api.history(siteId, selected.id, next);
      if (mounted.current) {
        setHistory((prev) => (next ? [...prev, ...page.items] : page.items));
        setBefore(page.nextBeforeVersion);
      }
    });
  }
  if (!access.read) return <p role="alert">{t.denied}</p>;
  return (
    <div className="space-y-4">
      <QaCatalogTools
        siteId={siteId}
        write={access.write}
        onImported={() => {
          void api
            .list(siteId)
            .then((p) => {
              setItems(p.items);
              setAfter(p.nextAfterKey);
            })
            .catch(() =>
              setNotice(
                'Импорт сохранён, но список не обновился. Обновите каталог отдельно.'
              )
            );
        }}
      />
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <p className="text-sm text-slate-500">
        {t.scope} {!access.write && t.readOnly}
      </p>
      <details className="rounded border p-3">
        <summary>Быстрый аудит страницы — без оплаты</summary>
        <p>
          Шесть локальных проверок: заголовок, язык, мобильный viewport, подписи
          полей, alt изображений и повторяющиеся ID. На выходе — отчёт .md с
          рекомендациями.
        </p>
        <ol className="list-decimal pl-5">
          <li>
            <a
              className="underline"
              href="/downloads/qa-form-capture.zip"
              download
            >
              Скачайте расширение Q
            </a>
            , распакуйте ZIP и загрузите папку через «Загрузить распакованное
            расширение» в chrome://extensions с включённым режимом разработчика.
          </li>
          <li>
            Откройте нужную HTTPS-страницу, нажмите Q в меню расширений Chrome и
            закройте popup.
          </li>
          <li>
            В оставшейся панели нажмите «Проверить открытую страницу», затем
            «Скачать отчёт страницы».
          </li>
        </ol>
        <p>
          Только текущая страница: без отправки форм, значений полей, сетевых
          запросов и платных сервисов. Это предварительная проверка, а не полный
          аудит сайта или безопасности. Замечания в кабинете автоматически не
          создаются.
        </p>
      </details>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-green-700">
          {notice}
        </p>
      )}
      {busy && <p role="status">{dict.common.loading}</p>}
      <div className="flex flex-wrap gap-2">
        {access.write && (
          <Button
            disabled={busy}
            onClick={() => {
              if (discard()) {
                setSelected(null);
                setCaseKey('');
                accept(emptyQaCase());
                setDirty(false);
                setHistory([]);
                setBefore(null);
                setError('');
                setConflict(false);
                setNotice('');
              }
            }}
          >
            {t.newCase}
          </Button>
        )}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const page = await api.list(siteId);
              if (mounted.current) {
                setItems(page.items);
                setAfter(page.nextAfterKey);
              }
            })
          }
        >
          {t.retry}
        </Button>
      </div>
      <ul className="space-y-2" aria-label={t.title}>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              disabled={busy}
              aria-current={selected?.id === item.id ? 'true' : undefined}
              className="w-full rounded border p-3 text-left break-words focus:ring-2"
              onClick={() => void open(item.id)}
            >
              {item.caseKey} · {item.title} · v{item.currentVersion}{' '}
              {item.archived && `· ${t.archived}`}
            </button>
          </li>
        ))}
      </ul>
      {!busy && !error && !items.length && <p>{t.empty}</p>}
      {after && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const page = await api.list(siteId, after);
              if (mounted.current) {
                setItems((prev) => [
                  ...prev,
                  ...page.items.filter((x) => !prev.some((y) => y.id === x.id)),
                ]);
                setAfter(page.nextAfterKey);
              }
            })
          }
        >
          {t.more}
        </Button>
      )}
      {draft && (
        <Card>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy || !access.write} className="space-y-3">
              <label className="block">
                {t.key}
                <input
                  className={inputClass}
                  required
                  pattern="[A-Z][A-Z0-9-]{1,63}"
                  maxLength={64}
                  value={caseKey}
                  readOnly={!!selected}
                  onChange={(e) => {
                    setCaseKey(e.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <label className="block">
                {t.name}
                <input
                  className={inputClass}
                  required
                  maxLength={200}
                  value={draft.title}
                  onChange={(e) => change({ title: e.target.value })}
                />
              </label>
              <label className="block">
                {t.purpose}
                <textarea
                  className={inputClass}
                  maxLength={2000}
                  value={draft.purpose}
                  onChange={(e) => change({ purpose: e.target.value })}
                />
              </label>
              <label className="block">
                {t.preconditions}
                <textarea
                  className={inputClass}
                  maxLength={4000}
                  value={draft.preconditions}
                  onChange={(e) => change({ preconditions: e.target.value })}
                />
              </label>
              {draft.steps.map((step, i) => (
                <div key={i} className="rounded border p-3 space-y-2">
                  <label className="block">
                    {i + 1}. {t.action}
                    <textarea
                      className={inputClass}
                      required
                      maxLength={2000}
                      value={step.action}
                      onChange={(e) =>
                        change({
                          steps: draft.steps.map((s, j) =>
                            j === i ? { ...s, action: e.target.value } : s
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="block">
                    {t.expected}
                    <textarea
                      className={inputClass}
                      required
                      maxLength={2000}
                      value={step.expected}
                      onChange={(e) =>
                        change({
                          steps: draft.steps.map((s, j) =>
                            j === i ? { ...s, expected: e.target.value } : s
                          ),
                        })
                      }
                    />
                  </label>
                  <Button
                    variant="outline"
                    disabled={draft.steps.length === 1}
                    onClick={() =>
                      change({ steps: draft.steps.filter((_, j) => j !== i) })
                    }
                  >
                    {t.remove}
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                disabled={draft.steps.length >= 100}
                onClick={() =>
                  change({
                    steps: [...draft.steps, { action: '', expected: '' }],
                  })
                }
              >
                {t.addStep}
              </Button>
              <label className="block">
                {t.type}
                <select
                  className={inputClass}
                  value={draft.type}
                  onChange={(e) =>
                    change({ type: e.target.value as QaCasePayload['type'] })
                  }
                >
                  {(['manual', 'automated'] as const).map((v) => (
                    <option key={v} value={v}>
                      {t[v]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                {t.priority}
                <select
                  className={inputClass}
                  value={draft.priority}
                  onChange={(e) =>
                    change({
                      priority: e.target.value as QaCasePayload['priority'],
                    })
                  }
                >
                  {(['low', 'normal', 'high', 'critical'] as const).map((v) => (
                    <option key={v} value={v}>
                      {t[v]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                {t.tags}
                <input
                  className={inputClass}
                  value={tags}
                  onChange={(e) => {
                    setTags(e.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <label className="block">
                {t.requirements}
                <input
                  className={inputClass}
                  value={requirements}
                  onChange={(e) => {
                    setRequirements(e.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={draft.archived}
                  onChange={(e) => change({ archived: e.target.checked })}
                />
                {t.archived}
              </label>
            </fieldset>
            {access.write && (
              <Button
                type="submit"
                disabled={busy || (!!selected && !dirty) || conflict}
              >
                {t.save}
              </Button>
            )}
            {conflict && selected && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void open(selected.id)}
              >
                {t.reload}
              </Button>
            )}
            {conflict && !selected && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setConflict(false);
                  setError('');
                }}
              >
                {t.retry}
              </Button>
            )}
          </form>
        </Card>
      )}
      {selected && (
        <Card>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void loadHistory()}
          >
            {t.history}
          </Button>
          <ol className="space-y-3 mt-3">
            {history.map((revision) => (
              <li key={revision.id} className="border rounded p-3 break-words">
                <p>
                  v{revision.version} ·{' '}
                  {new Date(revision.createdAt).toLocaleString(locale)} ·{' '}
                  {revision.payload.title}
                </p>
                <p>{revision.payload.purpose}</p>
                <ol>
                  {revision.payload.steps.map((step, i) => (
                    <li key={i}>
                      {i + 1}. {step.action} → {step.expected}
                    </li>
                  ))}
                </ol>
                {access.write && (
                  <Button
                    variant="outline"
                    disabled={busy || conflict}
                    onClick={() => {
                      if (discard()) {
                        accept(revision.payload);
                        setDirty(true);
                        setNotice('');
                      }
                    }}
                  >
                    {t.restore}
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {before && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void loadHistory(before)}
            >
              {t.more}
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}
