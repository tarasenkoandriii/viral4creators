import { useState } from 'react';
import { ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { formatDate } from '../format';
import { checkText, errorText } from '../errors';
import { canManage } from '../account-select';
import { hostKey, parseHostInput } from '../hosts';
import { useAsync } from '../use-async';
import { buildDnsBatch, hostView, pendingForBatch } from '../verification';
import { hapticResult } from '../telegram';
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyField,
  ScreenTitle,
  Spinner,
} from '../ui';
import { StatusBadge } from '../ui/StatusBadge';
import type { Site } from '../types';

/**
 * Экран сайта: хосты и статусы, «Проверить все», список TXT-записей
 * одним блоком («добавьте N записей»), подсказка найденных поддоменов.
 */
export function SiteScreen({
  siteId,
  onOpenHost,
}: {
  siteId: string;
  onOpenHost: (hostId: string) => void;
}) {
  const { api, dict, account, locale } = useKit();
  const t = dict.site;
  // Оператор только смотрит: сервер всё равно ответил бы 403, но кнопка,
  // которая всегда падает, хуже отсутствующей.
  const manage = canManage(account.me.role);
  // Отдельного GET /sites/:id в ядре нет (§4.16) — берём из списка.
  const site = useAsync<Site | null>(
    async () => (await api.listSites()).find((s) => s.id === siteId) ?? null,
    [api, siteId]
  );
  const suggest = useAsync(
    () =>
      manage
        ? api.suggestHosts(siteId).catch(() => [] as string[])
        : Promise.resolve([] as string[]),
    [api, siteId, manage]
  );
  const [newHost, setNewHost] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'success' | 'warning' | 'danger';
    text: string;
  } | null>(null);

  if (site.loading && !site.data)
    return <Spinner label={dict.common.loading} />;
  if (site.error || !site.data) {
    return (
      <Alert tone="danger" title={dict.common.error}>
        {site.error ? errorText(site.error, dict) : null}
        <div className="mt-2">
          <Button variant="outline" onClick={site.reload}>
            {dict.common.retry}
          </Button>
        </div>
      </Alert>
    );
  }

  const s = site.data;
  const now = new Date();
  const pending = pendingForBatch(s.hosts, now);
  let batch: ReturnType<typeof buildDnsBatch> = [];
  const token = account.account.verifyToken;
  if (manage && token) {
    try {
      batch = buildDnsBatch(pending, token);
    } catch {
      batch = []; // токен не того формата — экран хоста скажет об этом сам
    }
  }
  const existing = new Set(s.hosts.map((h) => h.host));
  const suggestions = (suggest.data ?? []).filter((h) => !existing.has(h));
  const parsedNew = newHost.trim() ? parseHostInput(newHost) : null;

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ tone: 'danger', text: errorText(e, dict) });
    } finally {
      setBusy(null);
    }
  }

  const addHost = (host: string) =>
    run(`add:${host}`, async () => {
      await api.addHost(s.id, `https://${host}`);
      setNewHost('');
      site.reload();
    });

  return (
    <div className="space-y-4">
      <ScreenTitle
        action={
          manage && (
            <Button
              icon={<RefreshCw size={16} />}
              loading={busy === 'all'}
              disabled={pending.length === 0}
              onClick={() =>
                run('all', async () => {
                  const results = await api.verifyAll(s.id);
                  const ok = results.filter((r) => r.ok).length;
                  hapticResult(ok > 0);
                  // По каждому непрошедшему — причина на языке интерфейса.
                  const failed = results
                    .filter((r) => !r.ok)
                    .map((r) => `${r.host.host}: ${checkText(r, dict)}`);
                  setNotice({
                    tone: ok === results.length ? 'success' : 'warning',
                    text: [
                      fmt(t.verifyAllDone, { ok, n: results.length }),
                      ...failed,
                    ].join('\n'),
                  });
                  site.reload();
                })
              }
            >
              {t.verifyAll}
            </Button>
          )
        }
      >
        {s.name}
      </ScreenTitle>

      {notice && (
        <Alert tone={notice.tone}>
          <span className="whitespace-pre-line">{notice.text}</span>
        </Alert>
      )}
      {!manage && <Alert tone="neutral">{t.readOnly}</Alert>}
      {pending.length === 0 && s.hosts.length > 0 && (
        <Alert tone="success">{t.nothingToVerify}</Alert>
      )}

      <Card className="space-y-2">
        <h2 className="font-semibold">{t.hosts}</h2>
        <ul className="divide-y divide-silver-200 dark:divide-silver-800">
          {s.hosts.map((h) => {
            const view = hostView(h, now);
            return (
              <li key={h.id} className="py-2 flex items-center gap-2">
                <button
                  type="button"
                  className="flex-1 min-w-0 text-left"
                  onClick={() => onOpenHost(h.id)}
                >
                  <div className="font-mono text-sm truncate">{h.host}</div>
                  <div className="flex flex-wrap items-center gap-2 mt-0.5">
                    <StatusBadge host={h} />
                    {h.reverifyBlocked && (
                      <Badge tone="danger">{t.blocked}</Badge>
                    )}
                    {view === 'verified' && h.expiresAt && (
                      <span className="text-xs text-silver-500">
                        {fmt(dict.status.verifiedUntil, {
                          date: formatDate(h.expiresAt, locale),
                        })}
                      </span>
                    )}
                  </div>
                </button>
                {manage && (
                  <Button
                    variant="ghost"
                    aria-label={dict.common.delete}
                    disabled={h.reverifyBlocked}
                    title={
                      h.reverifyBlocked
                        ? dict.errors.api.HOST_BLOCKED
                        : undefined
                    }
                    icon={<Trash2 size={16} />}
                    loading={busy === `del:${h.id}`}
                    onClick={() => {
                      if (
                        !window.confirm(
                          fmt(t.deleteHostConfirm, { host: h.host })
                        )
                      )
                        return;
                      void run(`del:${h.id}`, async () => {
                        await api.deleteHost(s.id, h.id);
                        site.reload();
                      });
                    }}
                  />
                )}
                <ChevronRight size={18} className="text-silver-400" />
              </li>
            );
          })}
        </ul>
        {manage && (
          <div className="flex gap-2 pt-2">
            <input
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              placeholder={dict.addSite.hostPlaceholder}
              inputMode="url"
              autoCapitalize="off"
              spellCheck={false}
              className="flex-1 min-w-0 rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 font-mono text-sm min-h-[44px]"
            />
            <Button
              variant="outline"
              icon={<Plus size={16} />}
              disabled={!parsedNew?.ok}
              loading={!!busy?.startsWith('add:')}
              onClick={() => parsedNew?.ok && addHost(parsedNew.host)}
            >
              {t.addHost}
            </Button>
          </div>
        )}
        {parsedNew && !parsedNew.ok && (
          <p className="text-xs text-rose-500">
            {dict.addSite.errors[parsedNew.error]}
          </p>
        )}
        {parsedNew?.ok && existing.has(parsedNew.host) && (
          <p className="text-xs text-rose-500">{dict.addSite.duplicate}</p>
        )}
        <p className="text-xs text-silver-500">{dict.addSite.ruleSubdomains}</p>
      </Card>

      {batch.length > 0 && (
        <Card className="space-y-3">
          <h2 className="font-semibold">
            {fmt(t.batchTitle, { n: batch.length })}
          </h2>
          <p className="text-xs text-silver-500">{t.batchHint}</p>
          {batch.map((b) => (
            <div
              key={b.name}
              className="space-y-2 rounded-xl border border-silver-200 dark:border-silver-800 p-3"
            >
              <div className="text-xs text-silver-500">
                {dict.verify.recordType}: TXT
              </div>
              <CopyField
                label={dict.verify.recordName}
                value={b.name}
                copyLabel={dict.common.copy}
                copiedLabel={dict.common.copied}
              />
              <CopyField
                label={dict.verify.recordValue}
                value={b.value}
                copyLabel={dict.common.copy}
                copiedLabel={dict.common.copied}
              />
            </div>
          ))}
        </Card>
      )}

      {manage && (
        <Card className="space-y-2">
          <h2 className="font-semibold">{t.suggestTitle}</h2>
          {suggestions.length === 0 ? (
            <p className="text-xs text-silver-500">{t.suggestEmpty}</p>
          ) : (
            <>
              <p className="text-xs text-silver-500">{t.suggestHint}</p>
              <ul className="space-y-1">
                {suggestions.map((h) => (
                  <li
                    key={hostKey({ scheme: 'https', host: h, port: 443 })}
                    className="flex items-center gap-2"
                  >
                    <span className="flex-1 min-w-0 font-mono text-sm truncate">
                      {h}
                    </span>
                    <Button
                      variant="outline"
                      icon={<Plus size={16} />}
                      loading={busy === `add:${h}`}
                      onClick={() => addHost(h)}
                    >
                      {t.suggestAdd}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
