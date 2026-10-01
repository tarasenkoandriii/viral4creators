import { useState } from 'react';
import { KeyRound, SearchCheck } from 'lucide-react';
import { fmt, formatDate, useKit } from '../../kit';
import { Alert, Badge, Button, Card, CopyField } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { useSetupErrorText } from '../../lib/use-error-text';
import { installTone } from '../../lib/widget-view';
import type {
  InstallCheckView,
  WidgetSettingsView,
} from '../../lib/widget-types';
import { NoticeBar, type Notice } from '../knowledge/parts';

/** Вкладка «Установка» (§3-бис.2): ключ, код вставки, CSP, проверка установки. */
export function InstallTab({
  siteId,
  view,
  onView,
}: {
  siteId: string;
  view: WidgetSettingsView;
  onView: (v: WidgetSettingsView) => void;
}) {
  const { dict, locale } = useKit();
  const { appDict, widget } = useAssist();
  const t = appDict.setup.widget.install;
  const errText = useSetupErrorText();
  const [busy, setBusy] = useState<'keys' | 'check' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [check, setCheck] = useState<InstallCheckView | null>(null);

  async function run(key: 'keys' | 'check', fn: () => Promise<void>) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <NoticeBar notice={notice} />
      {!view.publicKey ? (
        <Card className="space-y-3 text-sm">
          <p>{t.keysIntro}</p>
          <Button
            icon={<KeyRound size={16} />}
            loading={busy === 'keys'}
            onClick={() =>
              run('keys', async () => onView(await widget.ensureKeys(siteId)))
            }
          >
            {t.getKeys}
          </Button>
        </Card>
      ) : (
        <Card className="space-y-3">
          <CopyField
            label={t.snippet}
            value={view.snippet}
            copyLabel={dict.common.copy}
            copiedLabel={dict.common.copied}
          />
          <div className="text-xs text-silver-500">{t.snippetHint}</div>
          {view.testKey && (
            <>
              <CopyField
                label={t.testKey}
                value={view.testKey}
                copyLabel={dict.common.copy}
                copiedLabel={dict.common.copied}
              />
              <div className="text-xs text-silver-500">{t.testKeyHint}</div>
            </>
          )}
        </Card>
      )}

      <Card className="space-y-2">
        <CopyField
          label={t.csp}
          value={view.cspSnippet}
          copyLabel={dict.common.copy}
          copiedLabel={dict.common.copied}
        />
        <div className="text-xs text-silver-500">{t.cspHint}</div>
      </Card>

      <Card className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-semibold flex-1">{t.check}</div>
          <Button
            variant="outline"
            icon={<SearchCheck size={16} />}
            loading={busy === 'check'}
            disabled={!view.publicKey}
            onClick={() =>
              run('check', async () =>
                setCheck(await widget.checkInstall(siteId))
              )
            }
          >
            {t.check}
          </Button>
        </div>
        <div className="text-xs text-silver-500">{t.checkHint}</div>
        {check && (
          <div className="space-y-2">
            <div className="text-xs text-silver-500">
              {fmt(t.checkedAt, { date: formatDate(check.checkedAt, locale) })}
            </div>
            {check.hosts.length === 0 && (
              <div className="text-silver-500">{t.noHosts}</div>
            )}
            {check.hosts.map((h) => (
              <div
                key={h.hostId}
                className="space-y-1 border-t border-silver-200/70 dark:border-silver-800 pt-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-all flex-1">
                    {h.origin}
                  </span>
                  <Badge tone={installTone(h.result)}>
                    {t.results[h.result]}
                  </Badge>
                </div>
                {h.missingCsp.length > 0 && (
                  <Alert tone="warning">
                    {fmt(t.cspMissing, { list: h.missingCsp.join(', ') })}
                  </Alert>
                )}
                {h.result === 'csp_blocked' && h.missingCsp.length === 0 && (
                  <div className="text-xs text-silver-500">{t.noPing}</div>
                )}
                {h.lastPingAt && (
                  <div className="text-xs text-silver-500">
                    {fmt(t.lastPing, {
                      date: formatDate(h.lastPingAt, locale),
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="space-y-2 text-sm">
        <div className="font-semibold">{t.platformsTitle}</div>
        {t.platforms.map((p) => (
          <div key={p.name}>
            <div className="font-medium">{p.name}</div>
            <div className="text-silver-500">{p.text}</div>
          </div>
        ))}
      </Card>

      <Card className="space-y-1 text-sm">
        <div className="font-semibold">{t.attrsTitle}</div>
        <div className="text-silver-500">{t.attrsText}</div>
      </Card>
    </div>
  );
}
