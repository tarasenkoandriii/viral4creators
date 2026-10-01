import { useMemo, useState } from 'react';
import { MessageSquare, Power } from 'lucide-react';
import { useAsync, useKit, type Site } from '../../kit';
import { Alert, Button, Card, Spinner, Tabs } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import type { KnowledgeMode } from '../../lib/knowledge-types';
import {
  KNOWLEDGE_TABS,
  canAdminKnowledge,
  canSiteKnowledge,
  type KnowledgeTab,
} from '../../lib/knowledge-view';
import { navigate } from '../../lib/router';
import { ExclusionsTab } from './ExclusionsTab';
import { FaqTab } from './FaqTab';
import { OverviewTab } from './OverviewTab';
import { LoadError, NoticeBar, type Notice } from './parts';
import { useErrorText } from '../../lib/use-error-text';
import type { AssistSettingsView } from '../../lib/knowledge-types';
import { QuarantineTab } from './QuarantineTab';
import { SourcesTab } from './SourcesTab';
import { VersionsTab } from './VersionsTab';

/**
 * «Знания» сайта — ДВА экрана с одной вёрсткой (ТЗ §3.4, К-9): режим
 * `site` (посетители) и `admin` (сотрудники). Режим — часть адреса и
 * клиента API; переключатель ведёт на другой экран, а не меняет флажок,
 * и источник, созданный в одном экране, в другом не появляется.
 *
 * Права: «Сайт» — `assist: manager`; «Админка» — только `assistAdmin:
 * owner`. Без права экран не делает НИ ОДНОГО запроса своего режима —
 * сервер ответил бы 403, но лишний запрос к «Админке» от менеджера
 * «Сайта» — уже повод для тревоги в журнале.
 */
export function KnowledgeScreen({
  siteId,
  mode,
  tab,
}: {
  siteId: string;
  mode: KnowledgeMode;
  tab: KnowledgeTab;
}) {
  const { account } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge;
  const me = account.me;

  if (mode === 'site' && !canSiteKnowledge(me)) {
    return <Alert tone="warning">{t.noAccess}</Alert>;
  }
  if (mode === 'admin' && !canAdminKnowledge(me)) {
    return <Alert tone="warning">{t.noAdminAccess}</Alert>;
  }
  return <KnowledgeBody key={mode} siteId={siteId} mode={mode} tab={tab} />;
}

function KnowledgeBody({
  siteId,
  mode,
  tab,
}: {
  siteId: string;
  mode: KnowledgeMode;
  tab: KnowledgeTab;
}) {
  const { api, account, dict } = useKit();
  const { knowledge, appDict } = useAssist();
  const t = appDict.knowledge;

  const site = useAsync<Site | null>(
    async () => (await api.listSites()).find((s) => s.id === siteId) ?? null,
    [api, siteId]
  );
  const siteClient = useMemo(() => knowledge.site(siteId), [knowledge, siteId]);
  const adminClient = useMemo(
    () => knowledge.admin(siteId),
    [knowledge, siteId]
  );
  // Настройки «Сайта» — GET без побочных эффектов (null — маршрута ещё
  // нет). НЕ enable: тот на каждом вызове просит initial-обход.
  const settings = useAsync(
    () => (mode === 'site' ? siteClient.settings() : Promise.resolve(null)),
    [siteClient, mode]
  );
  // Сводка ответила ASSIST_NOT_ENABLED (когда GET настроек ещё нет).
  const [needEnable, setNeedEnable] = useState(false);

  const adminVisible = canAdminKnowledge(account.me, settings.data);
  const siteVisible = canSiteKnowledge(account.me);
  const hasVerifiedHost =
    settings.data?.hasVerifiedHost ??
    !!site.data?.hosts.some((h) => h.status === 'verified');

  if ((mode === 'site' && settings.loading && !settings.data) || site.loading) {
    return <Spinner label={dict.common.loading} />;
  }
  if (mode === 'site' && settings.error) {
    return <LoadError error={settings.error} onRetry={settings.reload} />;
  }
  if (!site.data) {
    return site.error ? (
      <LoadError error={site.error} onRetry={site.reload} />
    ) : (
      <Alert tone="warning">{dict.errors.api.SITE_NOT_FOUND}</Alert>
    );
  }

  if (mode === 'site' && (needEnable || settings.data?.enabled === false)) {
    return (
      <EnableCard
        siteName={site.data.name}
        siteId={siteId}
        onEnabled={(s) => {
          settings.setData(s);
          setNeedEnable(false);
        }}
      />
    );
  }

  const go = (next: KnowledgeTab) =>
    navigate({ name: 'knowledge', siteId, mode, tab: next }, true);
  const client = mode === 'site' ? siteClient : adminClient;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-silver-500 truncate">{site.data.name}</div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight flex-1 min-w-0">
            {mode === 'site' ? t.siteTitle : t.adminTitle}
          </h1>
          {mode === 'site' && (
            <Button
              variant="outline"
              icon={<MessageSquare size={16} />}
              onClick={() => navigate({ name: 'sandbox', siteId })}
            >
              {t.sandbox}
            </Button>
          )}
        </div>
        <p className="text-sm text-silver-500 mt-1">
          {mode === 'site' ? t.siteIntro : t.adminIntro}
        </p>
      </div>

      {siteVisible && adminVisible && (
        <div className="flex gap-2" role="navigation">
          {(['site', 'admin'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-current={m === mode ? 'page' : undefined}
              onClick={() =>
                navigate({
                  name: 'knowledge',
                  siteId,
                  mode: m,
                  tab: 'overview',
                })
              }
              className={`rounded-xl px-3 py-2 text-sm min-h-[40px] border ${
                m === mode
                  ? 'border-accent text-accent font-medium'
                  : 'border-silver-300 dark:border-silver-700 text-silver-600 dark:text-silver-300'
              }`}
            >
              {m === 'site' ? t.siteMode : t.adminMode}
            </button>
          ))}
        </div>
      )}

      <Tabs
        label={mode === 'site' ? t.siteTitle : t.adminTitle}
        active={tab}
        onChange={go}
        tabs={KNOWLEDGE_TABS.map((k) => ({ key: k, label: t.tabs[k] }))}
      />

      {tab === 'overview' && (
        <OverviewTab
          mode={mode}
          siteId={siteId}
          site={siteClient}
          admin={adminClient}
          settings={settings.data}
          onSettings={settings.setData}
          hasVerifiedHost={hasVerifiedHost}
          onOpenTab={go}
          onNeedEnable={() => setNeedEnable(true)}
        />
      )}
      {tab === 'sources' && (
        <SourcesTab
          client={client}
          site={mode === 'site' ? siteClient : null}
          settings={settings.data}
          onSettings={settings.setData}
        />
      )}
      {tab === 'faq' && <FaqTab client={client} />}
      {tab === 'versions' && <VersionsTab client={client} />}
      {tab === 'exclusions' && <ExclusionsTab client={client} />}
      {tab === 'quarantine' && <QuarantineTab client={client} />}
    </div>
  );
}

/**
 * «Подключить Помощника» к сайту (ТЗ §3.1): создаёт настройки и источник
 * «обход»; есть подтверждённый хост — сервер сразу начинает первый обход.
 * Только по нажатию: вызов платный (обход и эмбеддинги).
 */
function EnableCard({
  siteName,
  siteId,
  onEnabled,
}: {
  siteName: string;
  siteId: string;
  onEnabled: (s: AssistSettingsView) => void;
}) {
  const { knowledge, appDict } = useAssist();
  const t = appDict.knowledge;
  const errText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  return (
    <div className="space-y-4">
      <div className="text-xs text-silver-500 truncate">{siteName}</div>
      <h1 className="text-xl font-bold tracking-tight">{t.siteTitle}</h1>
      <Card className="space-y-3 text-sm">
        <p>{t.enableIntro}</p>
        <NoticeBar notice={notice} />
        <Button
          icon={<Power size={16} />}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setNotice(null);
            try {
              onEnabled(await knowledge.enable(siteId));
            } catch (e) {
              setNotice({ tone: 'danger', text: errText(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          {t.enable}
        </Button>
      </Card>
    </div>
  );
}
