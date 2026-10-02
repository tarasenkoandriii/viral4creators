import { useState } from 'react';
import { fmt, useAsync, useKit } from '../../kit';
import {
  Alert,
  Button,
  Card,
  ScreenTitle,
  Spinner,
  inputClass,
} from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { navigate } from '../../lib/router';
import { useSetupErrorText } from '../../lib/use-error-text';
import {
  PLAN_IDS,
  applyLandingDraft,
  canManageWidget,
} from '../../lib/widget-view';
import { LoadError, NoticeBar, type Notice } from '../knowledge/parts';

/** `pl_<тариф>` с лендинга (лендинг-ТЗ §7.3): сначала сайт, оплата — экран «Тариф и оплата» (Э4). */
export function PlanScreen({ plan }: { plan: string }) {
  const { appDict } = useAssist();
  const t = appDict.setup.plan;
  const id = (PLAN_IDS as readonly string[]).includes(plan)
    ? (plan as (typeof PLAN_IDS)[number])
    : 'start';
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <Card className="space-y-3 text-sm">
        <div className="font-semibold">
          {fmt(t.chosen, { plan: t.names[id] })}
        </div>
        <p className="text-silver-500">{t.text}</p>
        <Button onClick={() => navigate({ name: 'onboarding-url' })}>
          {t.connect}
        </Button>
        {id !== 'trial' && (
          <Button
            variant="outline"
            onClick={() => navigate({ name: 'billing', plan: id })}
          >
            {appDict.billing.title}
          </Button>
        )}
      </Card>
    </div>
  );
}

/**
 * `wd_<id>` («к Л3»): вид из конфигуратора лендинга → «применить к
 * черновику?». Хосты и картинки сайта не трогаются (applyLandingDraft).
 */
export function LandingDraftScreen({ draftId }: { draftId: string }) {
  const { api, account, dict } = useKit();
  const { appDict, widget } = useAssist();
  const t = appDict.setup.landingDraft;
  const errText = useSetupErrorText();
  const ok = canManageWidget(account.me);
  const sites = useAsync(
    () => (ok ? api.listSites() : Promise.resolve([])),
    [api, ok]
  );
  const [siteId, setSiteId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  if (!ok) return <Alert tone="warning">{appDict.setup.common.noAccess}</Alert>;
  if (sites.loading && !sites.data)
    return <Spinner label={dict.common.loading} />;
  if (!sites.data)
    return <LoadError error={sites.error} onRetry={sites.reload} />;
  const chosen = siteId || sites.data[0]?.id || '';
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      {sites.data.length === 0 ? (
        <Card className="space-y-2 text-sm">
          <div>{t.noSites}</div>
          <Button onClick={() => navigate({ name: 'onboarding-url' })}>
            {appDict.welcome.connect}
          </Button>
        </Card>
      ) : (
        <Card className="space-y-3 text-sm">
          <label className="block">
            <span className="block text-xs text-silver-500 mb-1">
              {t.chooseSite}
            </span>
            <select
              className={inputClass}
              value={chosen}
              onChange={(e) => setSiteId(e.target.value)}
            >
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setNotice(null);
                try {
                  const [landing, current] = await Promise.all([
                    widget.landingDraft(draftId),
                    widget.get(chosen),
                  ]);
                  await widget.saveDraft(
                    chosen,
                    applyLandingDraft(current.draft, landing)
                  );
                  setNotice({ tone: 'success', text: t.applied });
                  navigate(
                    { name: 'widget', siteId: chosen, tab: 'look' },
                    true
                  );
                } catch (e) {
                  setNotice({ tone: 'danger', text: errText(e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t.apply}
            </Button>
            <Button
              variant="ghost"
              onClick={() => navigate({ name: 'home' }, true)}
            >
              {t.later}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
