/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/screens/AddSiteScreen.tsx */
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { errorText } from '../errors';
import { parseHostInput, validateHostList, wwwTwin } from '../hosts';
import { Alert, Button, Card, ScreenTitle } from '../ui';

/**
 * «Добавить сайт»: имя + несколько хостов. Правила охвата показаны
 * текстом ДО отправки (ТЗ §3.3): apex и www — разные хосты, поддомены не
 * наследуют подтверждение. Человек должен узнать это здесь, а не после
 * того, как виджет не заработает на `www.`.
 */
export function AddSiteScreen({
  onCreated,
  onCancel,
}: {
  onCreated: (siteId: string) => void;
  onCancel: () => void;
}) {
  const { api, dict } = useKit();
  const t = dict.addSite;
  const [name, setName] = useState('');
  const [rows, setRows] = useState<string[]>(['']);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { hosts, errors } = validateHostList(rows);
  const hasRowErrors = errors.some((e) => e !== null);
  const formError = !name.trim()
    ? t.nameRequired
    : hosts.length === 0
      ? t.hostsRequired
      : null;

  const setRow = (i: number, v: string) =>
    setRows((r) => r.map((x, j) => (j === i ? v : x)));

  // Подсказка «добавить и www/apex» — только если пары ещё нет в списке.
  const present = new Set(hosts.map((h) => h.host));
  const twins = hosts
    .map((h) => wwwTwin(h.host))
    .filter((x): x is string => !!x && !present.has(x));

  async function submit() {
    setTouched(true);
    if (formError || hasRowErrors) return;
    setBusy(true);
    setError(null);
    try {
      const [first, ...rest] = hosts;
      const site = await api.createSite(name.trim(), `https://${first.host}`);
      // Остальные хосты — по одному: сайт уже создан, и повторная
      // отправка формы создала бы второй сайт. Неудачный хост человек
      // добавит на экране сайта — туда и ведём в любом случае.
      for (const h of rest) {
        try {
          await api.addHost(site.id, `https://${h.host}`);
        } catch {
          /* виден на экране сайта как отсутствующий */
        }
      }
      onCreated(site.id);
    } catch (e) {
      setError(errorText(e, dict));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>

      <Card className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">{t.nameLabel}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.namePlaceholder}
            maxLength={120}
            className="mt-1 w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px]"
          />
        </label>

        <div>
          <span className="text-sm font-medium">{t.hostsLabel}</span>
          <div className="mt-1 space-y-2">
            {rows.map((row, i) => {
              const err = errors[i];
              const parsed = row.trim() ? parseHostInput(row) : null;
              return (
                <div key={i}>
                  <div className="flex gap-2">
                    <input
                      value={row}
                      onChange={(e) => setRow(i, e.target.value)}
                      placeholder={t.hostPlaceholder}
                      inputMode="url"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="flex-1 min-w-0 rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 font-mono text-sm min-h-[44px]"
                    />
                    {rows.length > 1 && (
                      <Button
                        variant="ghost"
                        aria-label={t.removeHost}
                        icon={<X size={16} />}
                        onClick={() =>
                          setRows((r) => r.filter((_, j) => j !== i))
                        }
                      />
                    )}
                  </div>
                  {err && (touched || err === 'duplicate') ? (
                    <p className="text-xs text-rose-500 mt-1">
                      {err === 'duplicate' ? t.duplicate : t.errors[err]}
                    </p>
                  ) : parsed?.ok ? (
                    <p className="text-xs text-silver-500 mt-1 font-mono">
                      https://{parsed.host}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="outline"
              icon={<Plus size={16} />}
              onClick={() => setRows((r) => [...r, ''])}
            >
              {t.addHost}
            </Button>
            {twins.map((tw) => (
              <Button
                key={tw}
                variant="outline"
                icon={<Plus size={16} />}
                onClick={() =>
                  setRows((r) => [...r.filter((x) => x.trim()), tw])
                }
              >
                {fmt(t.addTwin, { host: tw })}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      <Alert tone="accent" title={t.ruleTitle}>
        <ul className="list-disc pl-4 space-y-1">
          <li>{t.ruleApexWww}</li>
          <li>{t.ruleSubdomains}</li>
          <li>{t.ruleHttps}</li>
        </ul>
      </Alert>

      {touched && formError && <Alert tone="warning">{formError}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {dict.common.cancel}
        </Button>
        <Button block loading={busy} onClick={submit}>
          {t.submit}
        </Button>
      </div>
    </div>
  );
}
