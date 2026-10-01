import { useState } from 'react';
import { Pause, Play, Save } from 'lucide-react';
import { fmt, formatDate, useKit } from '../../kit';
import { Alert, Badge, Button, Card, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { navigate } from '../../lib/router';
import { useSetupErrorText } from '../../lib/use-error-text';
import { hostRule, parseMasks, withHostRule } from '../../lib/widget-view';
import type { WidgetConfig, WidgetSettingsView } from '../../lib/widget-types';
import { ConfirmButton, NoticeBar, type Notice } from '../knowledge/parts';
import { Field, Toggle } from './controls';

/**
 * «Где работает» (§3.6 п.3): хосты сайта, переключатель и маски путей —
 * в черновике (действуют после публикации); рубильник чата — сразу.
 */
export function HostsTab({
  siteId,
  view,
  onView,
}: {
  siteId: string;
  view: WidgetSettingsView;
  onView: (v: WidgetSettingsView) => void;
}) {
  const { locale } = useKit();
  const { appDict, widget } = useAssist();
  const t = appDict.setup.widget.hosts;
  const tc = appDict.setup.common;
  const errText = useSetupErrorText();
  const [draft, setDraft] = useState<WidgetConfig>(view.draft);
  const [masks, setMasks] = useState<
    Record<string, { show: string; hide: string }>
  >(() =>
    Object.fromEntries(
      view.hosts.map((h) => {
        const r = hostRule(view.draft, h.hostId);
        return [
          h.hostId,
          { show: r.pathMasks.join(', '), hide: r.hideOn.join(', ') },
        ];
      })
    )
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const bad: string[] = [];
  let next = draft;
  for (const h of view.hosts) {
    const m = masks[h.hostId] ?? { show: '', hide: '' };
    const show = parseMasks(m.show);
    const hide = parseMasks(m.hide);
    bad.push(...show.bad, ...hide.bad);
    next = withHostRule(next, {
      ...hostRule(next, h.hostId),
      pathMasks: show.masks,
      hideOn: hide.masks,
    });
  }

  async function run(key: string, fn: () => Promise<void>) {
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
      <p className="text-sm text-silver-500">{t.intro}</p>
      {view.hosts.map((h) => {
        const rule = hostRule(draft, h.hostId);
        const m = masks[h.hostId] ?? { show: '', hide: '' };
        const verified = h.status === 'verified';
        return (
          <Card key={h.hostId} className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all flex-1">{h.origin}</span>
              <Badge
                tone={
                  verified ? 'success' : h.graceUntil ? 'warning' : 'neutral'
                }
              >
                {t.status[h.status as keyof typeof t.status] ?? h.status}
              </Badge>
              {h.enabledPublished && <Badge tone="accent">{t.live}</Badge>}
            </div>
            {h.graceUntil && (
              <Alert tone="warning">
                {fmt(t.grace, { date: formatDate(h.graceUntil, locale) })}
              </Alert>
            )}
            {!h.widgetAllowed && (
              <Button
                variant="outline"
                onClick={() =>
                  navigate({ name: 'host', siteId, hostId: h.hostId })
                }
              >
                {t.verify}
              </Button>
            )}
            <Toggle
              checked={rule.enabled}
              onChange={(enabled) =>
                setDraft((d) =>
                  withHostRule(d, { ...hostRule(d, h.hostId), enabled })
                )
              }
              label={t.enabled}
            />
            <Field label={t.masks} hint={t.masksHint}>
              <input
                className={inputClass}
                value={m.show}
                onChange={(e) =>
                  setMasks((x) => ({
                    ...x,
                    [h.hostId]: { ...m, show: e.target.value },
                  }))
                }
                placeholder="/catalog/*"
              />
            </Field>
            <Field label={t.hideOn} hint={t.hideOnHint}>
              <input
                className={inputClass}
                value={m.hide}
                onChange={(e) =>
                  setMasks((x) => ({
                    ...x,
                    [h.hostId]: { ...m, hide: e.target.value },
                  }))
                }
                placeholder="/checkout*"
              />
            </Field>
            {!m.hide.includes('/checkout') && (
              <Button
                variant="ghost"
                onClick={() =>
                  setMasks((x) => ({
                    ...x,
                    [h.hostId]: {
                      ...m,
                      hide: [m.hide, '/checkout*'].filter(Boolean).join(', '),
                    },
                  }))
                }
              >
                {t.suggestCheckout}
              </Button>
            )}
          </Card>
        );
      })}
      {bad.length > 0 && (
        <Alert tone="danger">{fmt(t.badMasks, { list: bad.join(', ') })}</Alert>
      )}
      <Button
        icon={<Save size={16} />}
        loading={busy === 'save'}
        disabled={bad.length > 0}
        onClick={() =>
          run('save', async () => {
            const v = await widget.saveDraft(siteId, next);
            onView(v);
            setDraft(v.draft);
            setNotice({ tone: 'success', text: tc.saved });
          })
        }
      >
        {tc.save}
      </Button>

      <Card className="space-y-2 text-sm">
        <div className="text-silver-500">{t.pauseHint}</div>
        {view.chatPaused ? (
          <Button
            variant="outline"
            icon={<Play size={16} />}
            loading={busy === 'pause'}
            onClick={() =>
              run('pause', async () =>
                onView(await widget.setPaused(siteId, false))
              )
            }
          >
            {t.resume}
          </Button>
        ) : (
          <ConfirmButton
            variant="outline"
            icon={<Pause size={16} />}
            loading={busy === 'pause'}
            onConfirm={() =>
              run('pause', async () =>
                onView(await widget.setPaused(siteId, true))
              )
            }
          >
            {t.pause}
          </ConfirmButton>
        )}
      </Card>
    </div>
  );
}
