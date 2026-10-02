import { useState } from 'react';
import { Bot, Clapperboard, GraduationCap, LayoutTemplate } from 'lucide-react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Alert, Button, Card, ScreenTitle, Spinner, Tabs } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { navigate } from '../../lib/router';
import {
  WIDGET_TABS,
  canManageWidget,
  type WidgetTab,
} from '../../lib/widget-view';
import type { WidgetSettingsView, WidgetWarning } from '../../lib/widget-types';
import { LoadError } from '../knowledge/parts';
import { HostsTab } from './HostsTab';
import { InstallTab } from './InstallTab';
import { LeadsTab } from './LeadsTab';
import { LookTab } from './LookTab';
import { EngagementTab } from './EngagementTab';

/** Раздел «Виджет» из навигации: выбор сайта → виджет, характер, мастер. */
export function WidgetHome() {
  const { api, account, dict } = useKit();
  const { appDict } = useAssist();
  const t = appDict.setup.home;
  const ok = canManageWidget(account.me);
  const sites = useAsync(
    () => (ok ? api.listSites() : Promise.resolve([])),
    [api, ok]
  );
  if (!ok) {
    return (
      <div className="space-y-4">
        <ScreenTitle>{t.title}</ScreenTitle>
        <Alert tone="warning">{appDict.setup.common.noAccess}</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{t.intro}</p>
      {sites.loading && !sites.data ? (
        <Spinner label={dict.common.loading} />
      ) : !sites.data ? (
        <LoadError error={sites.error} onRetry={sites.reload} />
      ) : sites.data.length === 0 ? (
        <Card className="space-y-2 text-sm">
          <div>{t.noSites}</div>
          <Button onClick={() => navigate({ name: 'onboarding-url' })}>
            {appDict.welcome.connect}
          </Button>
        </Card>
      ) : (
        sites.data.map((s) => (
          <Card key={s.id} className="space-y-2">
            <div className="font-semibold truncate">{s.name}</div>
            <SiteSetupButtons siteId={s.id} />
          </Card>
        ))
      )}
    </div>
  );
}

/** Кнопки «Виджет / Характер / Научите помощника» (и в карточке сайта). */
export function SiteSetupButtons({ siteId }: { siteId: string }) {
  const { account } = useKit();
  const { appDict } = useAssist();
  const t = appDict.setup.home;
  if (!canManageWidget(account.me)) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        icon={<LayoutTemplate size={16} />}
        onClick={() => navigate({ name: 'widget', siteId, tab: 'look' })}
      >
        {t.widget}
      </Button>
      <Button
        variant="outline"
        icon={<Bot size={16} />}
        onClick={() => navigate({ name: 'persona', siteId })}
      >
        {t.persona}
      </Button>
      <Button
        variant="outline"
        icon={<GraduationCap size={16} />}
        onClick={() => navigate({ name: 'wizard', siteId })}
      >
        {t.wizard}
      </Button>
      <Button
        variant="outline"
        icon={<Clapperboard size={16} />}
        onClick={() => navigate({ name: 'videos', siteId })}
      >
        {t.videos}
      </Button>
    </div>
  );
}

/** Предупреждения конфигуратора (§3-бис.4) — текстом, origin хоста — из списка хостов. */
function warningText(
  w: WidgetWarning,
  view: WidgetSettingsView,
  t: ReturnType<typeof useAssist>['appDict']['setup']['widget']['warnings'],
  locale: Parameters<typeof formatDate>[1]
): string {
  const origin = view.hosts.find((h) => h.hostId === w.hostId)?.origin ?? '';
  return fmt(t[w.code], {
    origin,
    date: w.details ? formatDate(w.details, locale) : '',
  });
}

export function WidgetScreen({
  siteId,
  tab,
}: {
  siteId: string;
  tab: WidgetTab;
}) {
  const { account, dict, locale } = useKit();
  const { appDict, widget } = useAssist();
  const t = appDict.setup.widget;
  const ok = canManageWidget(account.me);
  const loaded = useAsync(
    () => (ok ? widget.get(siteId) : Promise.resolve(null)),
    [widget, siteId, ok]
  );
  const [view, setView] = useState<WidgetSettingsView | null>(null);
  const v = view ?? loaded.data;

  if (!ok) return <Alert tone="warning">{appDict.setup.common.noAccess}</Alert>;
  if (loaded.loading && !v) return <Spinner label={dict.common.loading} />;
  if (!v) return <LoadError error={loaded.error} onRetry={loaded.reload} />;

  /** Что сервер поправил при сохранении — по-человечески (§3-бис.1). */
  const adjustNotices = (x: WidgetSettingsView): string[] => {
    const out = new Set<string>();
    for (const a of x.adjustments) {
      if (a.reason.startsWith('contrast_')) {
        out.add(
          fmt(t.adjust.contrast, { from: String(a.from), to: String(a.to) })
        );
      } else if (a.reason === 'powered_by_locked') out.add(t.adjust.powered);
      else if (a.reason === 'text_truncated') out.add(t.adjust.truncated);
      else if (a.reason === 'host_not_verified') out.add(t.adjust.host);
      else out.add(fmt(t.adjust.other, { path: a.path }));
    }
    return [...out];
  };

  const go = (next: WidgetTab) =>
    navigate({ name: 'widget', siteId, tab: next }, true);
  // Предупреждения, которые уже объяснены поправками, не дублируем.
  const warnings = v.warnings.filter(
    (w) => w.code !== 'low_contrast' && w.code !== 'powered_by_locked'
  );

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      {v.operatorBlocked && <Alert tone="danger">{t.operatorBlocked}</Alert>}
      {v.chatPaused && <Alert tone="warning">{t.paused}</Alert>}
      {warnings.length > 0 && (
        <Alert tone="warning">
          <ul className="list-disc pl-5 space-y-0.5">
            {warnings.map((w, i) => (
              <li key={`${w.code}-${w.hostId ?? i}`}>
                {warningText(w, v, t.warnings, locale)}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <Tabs
        label={t.title}
        active={tab}
        onChange={go}
        tabs={WIDGET_TABS.map((k) => ({ key: k, label: t.tabs[k] }))}
      />
      {tab === 'look' && (
        <LookTab
          siteId={siteId}
          view={v}
          onView={setView}
          adjustNotices={adjustNotices}
        />
      )}
      {tab === 'install' && (
        <InstallTab siteId={siteId} view={v} onView={setView} />
      )}
      {tab === 'hosts' && (
        <HostsTab siteId={siteId} view={v} onView={setView} />
      )}
      {tab === 'leads' && <LeadsTab siteId={siteId} />}
      {tab === 'engagement' && (
        <EngagementTab siteId={siteId} view={v} onView={setView} />
      )}
    </div>
  );
}
