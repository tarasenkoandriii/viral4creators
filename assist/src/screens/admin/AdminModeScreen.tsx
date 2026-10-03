import { useState } from 'react';
import { formatDate, useAsync, useKit } from '../../kit';
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyField,
  ScreenTitle,
  Spinner,
  Tabs,
  inputClass,
} from '../../kit/ui';
import { isAdminOwner, useAdminTexts } from '../../lib/admin-mode-view';
import {
  type AdminModeTab,
  type AdminModeView,
  type ConnectorView,
  type OperationView,
  ADMIN_MODE_TABS,
} from '../../lib/admin-mode-api';
import { useAssist } from '../../lib/assist-context';
import { navigate } from '../../lib/router';
import { useErrorText } from '../../lib/use-error-text';
import {
  ConfirmButton,
  LoadError,
  NoticeBar,
  textareaClass,
  type Notice,
} from '../knowledge/parts';
import {
  ActionsLog,
  ActionsSettingsCard,
  MemosTab,
  OperationActionSettings,
  SigningSecret,
} from './AdminActionsParts';

/**
 * «Админка» (Э7, ТЗ §3.8): режим и секрет подписи, коннекторы API, журнал
 * вызовов, «Обучение (сотрудники)», «Статистика (сотрудники)»; Э8 —
 * действия write/danger, журнал действий с откатом, мемо АМ-N. Только
 * `assistAdmin: owner` — остальные видят отказ (сервер всё равно 403).
 */
export function AdminModeScreen({
  siteId,
  tab,
}: {
  siteId: string;
  tab: AdminModeTab;
}) {
  const { account } = useKit();
  const t = useAdminTexts();
  if (!isAdminOwner(account.me)) {
    return <Alert tone="warning">{t.noAccess}</Alert>;
  }
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <Tabs
        label={t.title}
        active={tab}
        onChange={(k) => navigate({ name: 'admin-mode', siteId, tab: k }, true)}
        tabs={ADMIN_MODE_TABS.map((k) => ({ key: k, label: t.tabs[k] }))}
      />
      {tab === 'settings' && (
        <div className="space-y-4">
          <Settings siteId={siteId} />
          <ActionsSettingsCard siteId={siteId} />
        </div>
      )}
      {tab === 'connectors' && <Connectors siteId={siteId} />}
      {tab === 'log' && (
        <div className="space-y-4">
          <ActionsLog siteId={siteId} />
          <Log siteId={siteId} />
        </div>
      )}
      {tab === 'memos' && <MemosTab siteId={siteId} />}
      {tab === 'learning' && <StaffLearning siteId={siteId} />}
      {tab === 'stats' && <Stats siteId={siteId} />}
    </div>
  );
}

function roleMapText(m: Record<string, string>): string {
  return Object.entries(m)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function parseRoleMapText(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const [k, v] = line.split('=').map((x) => x.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

function Settings({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const { dict, locale } = useKit();
  const t = useAdminTexts();
  const errText = useErrorText();
  const st = useAsync(() => adminMode.get(siteId), [siteId]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<
    Partial<AdminModeView> & { roleText?: string }
  >({});
  if (st.loading && !st.data) return <Spinner />;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  const v: AdminModeView = { ...st.data, ...draft } as AdminModeView;
  const roleText = draft.roleText ?? roleMapText(st.data.roleMap);

  const save = async (patch: Parameters<typeof adminMode.patch>[1]) => {
    setBusy(true);
    try {
      await adminMode.patch(siteId, patch);
      setDraft({});
      setNotice({ tone: 'success', text: t.settings.saved });
      st.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <NoticeBar notice={notice} />
      {!v.siteVerified && (
        <Alert tone="warning">{t.settings.needVerified}</Alert>
      )}
      {!v.planAllows && <Alert tone="warning">{t.settings.planNeeded}</Alert>}
      <Card className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          {t.settings.enabled}
        </label>
        <div className="text-sm">
          <div className="text-xs text-silver-500 mb-1">
            {t.settings.access}
          </div>
          <select
            className={inputClass}
            value={v.access}
            onChange={(e) =>
              setDraft({
                ...draft,
                access: e.target.value as AdminModeView['access'],
              })
            }
          >
            <option value="tma">{t.settings.accessTma}</option>
            <option value="script">{t.settings.accessScript}</option>
            <option value="both">{t.settings.accessBoth}</option>
          </select>
        </div>
        <div className="text-sm space-y-1">
          <div className="text-xs text-silver-500">{t.settings.adminHosts}</div>
          {v.hosts.map((h) => (
            <label key={h.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!h.verified}
                checked={v.adminHostIds.includes(h.id)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    adminHostIds: e.target.checked
                      ? [...v.adminHostIds, h.id]
                      : v.adminHostIds.filter((x) => x !== h.id),
                  })
                }
              />
              {h.host} {!h.verified && <Badge tone="warning">{h.status}</Badge>}
            </label>
          ))}
          <div className="text-xs text-silver-500">
            {t.settings.adminHostsHint}
          </div>
        </div>
        <div>
          <div className="text-xs text-silver-500 mb-1">
            {t.settings.instructions}
          </div>
          <textarea
            className={textareaClass}
            maxLength={2000}
            value={v.instructions ?? ''}
            onChange={(e) =>
              setDraft({ ...draft, instructions: e.target.value })
            }
          />
        </div>
        <div>
          <div className="text-xs text-silver-500 mb-1">
            {t.settings.roleMap}
          </div>
          <textarea
            className={textareaClass}
            value={roleText}
            onChange={(e) => setDraft({ ...draft, roleText: e.target.value })}
          />
          <div className="text-xs text-silver-500">
            {t.settings.roleMapHint}
          </div>
        </div>
        <div>
          <div className="text-xs text-silver-500 mb-1">
            {t.settings.tmaEmployeeRole}
          </div>
          <input
            className={inputClass}
            value={v.tmaEmployeeRole ?? ''}
            onChange={(e) =>
              setDraft({ ...draft, tmaEmployeeRole: e.target.value || null })
            }
          />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.statsPerEmployee}
            onChange={(e) =>
              setDraft({ ...draft, statsPerEmployee: e.target.checked })
            }
          />
          <span>
            {t.settings.statsPerEmployee}
            <span className="block text-xs text-silver-500">
              {t.settings.statsPerEmployeeHint}
            </span>
          </span>
        </label>
        <Button
          loading={busy}
          onClick={() =>
            void save({
              enabled: v.enabled,
              access: v.access,
              adminHostIds: v.adminHostIds,
              instructions: v.instructions,
              roleMap: parseRoleMapText(roleText),
              tmaEmployeeRole: v.tmaEmployeeRole,
              statsPerEmployee: v.statsPerEmployee,
            })
          }
        >
          {t.settings.save}
        </Button>
      </Card>

      <Card className="space-y-2">
        <div className="font-semibold text-sm">{t.settings.secretTitle}</div>
        <div className="text-sm">
          {st.data.identitySecret.set
            ? `${t.settings.secretSet} · ${st.data.identitySecret.setAt ? formatDate(st.data.identitySecret.setAt, locale) : ''}`
            : t.settings.secretNotSet}
        </div>
        {secret && (
          <>
            <Alert tone="warning">{t.settings.secretOnce}</Alert>
            <CopyField
              label="ASSIST_JWT_SECRET"
              value={secret}
              copyLabel={dict.common.copy}
              copiedLabel={dict.common.copied}
            />
          </>
        )}
        <ConfirmButton
          hint={
            st.data.identitySecret.set
              ? t.settings.secretReissueHint
              : undefined
          }
          onConfirm={() =>
            void adminMode
              .issueIdentitySecret(siteId)
              .then((r) => {
                setSecret(r.secret);
                st.reload();
              })
              .catch((e) => setNotice({ tone: 'danger', text: errText(e) }))
          }
        >
          {t.settings.secretIssue}
        </ConfirmButton>
        <div className="text-xs text-silver-500 mt-2">{t.settings.snippet}</div>
        {st.data.snippet ? (
          <>
            <CopyField
              label={t.settings.snippet}
              value={st.data.snippet.tag}
              copyLabel={dict.common.copy}
              copiedLabel={dict.common.copied}
            />
            <CopyField
              label={t.settings.snippetCsp}
              value={st.data.snippet.csp}
              copyLabel={dict.common.copy}
              copiedLabel={dict.common.copied}
            />
          </>
        ) : (
          <div className="text-xs text-silver-500">
            {t.settings.snippetNoKey}
          </div>
        )}
      </Card>
      <PrivateCrawl siteId={siteId} />
    </div>
  );
}

function PrivateCrawl({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const { locale } = useKit();
  const t = useAdminTexts();
  const errText = useErrorText();
  const st = useAsync(() => adminMode.privateCrawl(siteId), [siteId]);
  const [host, setHost] = useState('');
  const [acc, setAcc] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  if (st.loading && !st.data) return <Spinner />;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  const v = st.data;
  const hostId = host || v.hostId || v.hosts[0]?.id || '';
  const accounts = v.testAccounts.filter((a) => a.hostIds.includes(hostId));
  const accId = acc || v.testAccountId || accounts[0]?.id || '';
  const run = (p: Promise<unknown>) =>
    p
      .then(() => st.reload())
      .catch((e) => setNotice({ tone: 'danger', text: errText(e) }));
  return (
    <Card className="space-y-2">
      <div className="font-semibold text-sm">{t.settings.crawlTitle}</div>
      <div className="text-xs text-silver-500">{t.settings.crawlHint}</div>
      <NoticeBar notice={notice} />
      <select
        className={inputClass}
        value={hostId}
        onChange={(e) => setHost(e.target.value)}
      >
        {v.hosts.map((h) => (
          <option key={h.id} value={h.id}>
            {h.host}
          </option>
        ))}
      </select>
      {accounts.length === 0 ? (
        <div className="text-xs text-silver-500">
          {t.settings.crawlNoAccounts}
        </div>
      ) : (
        <select
          className={inputClass}
          value={accId}
          onChange={(e) => setAcc(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      )}
      <div className="flex flex-wrap gap-2">
        {v.enabled ? (
          <Button
            variant="outline"
            onClick={() =>
              void run(adminMode.putPrivateCrawl(siteId, { enabled: false }))
            }
          >
            {t.settings.crawlDisable}
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={!hostId || !accId}
            onClick={() =>
              void run(
                adminMode.putPrivateCrawl(siteId, {
                  enabled: true,
                  hostId,
                  testAccountId: accId,
                })
              )
            }
          >
            {t.settings.crawlEnable}
          </Button>
        )}
        {v.enabled && (
          <Button onClick={() => void run(adminMode.runPrivateCrawl(siteId))}>
            {t.settings.crawlRun}
          </Button>
        )}
      </div>
      {v.jobs.map((j) => (
        <div key={j.id} className="text-xs text-silver-500">
          {formatDate(j.createdAt, locale)} ·{' '}
          {j.status === 'waiting_worker' ? t.settings.crawlWaiting : j.status}
        </div>
      ))}
    </Card>
  );
}

function Connectors({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const t = useAdminTexts();
  const errText = useErrorText();
  const st = useAsync(() => adminMode.connectors(siteId), [siteId]);
  const [name, setName] = useState('');
  const [specUrl, setSpecUrl] = useState('');
  const [specText, setSpecText] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [saas, setSaas] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const create = async () => {
    setBusy(true);
    try {
      await adminMode.createConnector(siteId, {
        name: name.trim() || 'API',
        ...(specText ? { specText } : { specUrl: specUrl.trim() }),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(saas ? { saasAcknowledged: true } : {}),
      });
      setName('');
      setSpecUrl('');
      setSpecText(null);
      setNotice(null);
      st.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <NoticeBar notice={notice} />
      <Card className="space-y-2">
        <div className="font-semibold text-sm">{t.connectors.add}</div>
        <input
          className={inputClass}
          placeholder={t.connectors.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={inputClass}
          placeholder={t.connectors.specUrl}
          value={specUrl}
          onChange={(e) => setSpecUrl(e.target.value)}
        />
        <label className="text-xs text-silver-500 block">
          {t.connectors.specFile}{' '}
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then(setSpecText);
            }}
          />
        </label>
        <input
          className={inputClass}
          placeholder={t.connectors.baseUrl}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={saas}
            onChange={(e) => setSaas(e.target.checked)}
          />
          {t.connectors.saas}
        </label>
        <Button
          loading={busy}
          disabled={!specUrl.trim() && !specText}
          onClick={() => void create()}
        >
          {t.connectors.import}
        </Button>
      </Card>
      {st.loading && !st.data && <Spinner />}
      {st.error && <LoadError error={st.error} onRetry={st.reload} />}
      {st.data && st.data.length === 0 && <Alert>{t.connectors.empty}</Alert>}
      {st.data?.map((c) => (
        <ConnectorCard
          key={c.id}
          siteId={siteId}
          c={c}
          onChange={st.reload}
          onError={(e) => setNotice({ tone: 'danger', text: errText(e) })}
        />
      ))}
    </div>
  );
}

function ConnectorCard({
  siteId,
  c,
  onChange,
  onError,
}: {
  siteId: string;
  c: ConnectorView;
  onChange: () => void;
  onError: (e: unknown) => void;
}) {
  const { adminMode } = useAssist();
  const t = useAdminTexts();
  const [authKind, setAuthKind] = useState<'bearer' | 'basic' | 'header'>(
    'bearer'
  );
  const [header, setHeader] = useState('');
  const [secret, setSecret] = useState('');
  const act = (p: Promise<unknown>) => p.then(onChange).catch(onError);
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{c.name}</span>
        <code className="text-xs">{c.baseUrl}</code>
        <Badge tone={c.hostVerified ? 'success' : 'warning'}>
          {c.hostVerified ? t.connectors.hostVerified : t.connectors.hostSaas}
        </Badge>
        {c.status === 'auth_failed' && (
          <Badge tone="danger">{t.connectors.statusAuthFailed}</Badge>
        )}
        {c.status === 'paused' && (
          <Badge tone="warning">{t.connectors.statusPaused}</Badge>
        )}
      </div>
      <div className="text-sm">
        {t.connectors.secret}:{' '}
        {c.secret.set
          ? `${t.connectors.secretSet} ••••${c.secret.tail ?? ''}`
          : t.connectors.secretNone}
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <select
          className={inputClass}
          value={authKind}
          onChange={(e) => setAuthKind(e.target.value as typeof authKind)}
        >
          <option value="bearer">Bearer</option>
          <option value="basic">Basic</option>
          <option value="header">Header</option>
        </select>
        {authKind === 'header' && (
          <input
            className={inputClass}
            placeholder={t.connectors.headerName}
            value={header}
            onChange={(e) => setHeader(e.target.value)}
          />
        )}
        <input
          className={inputClass}
          type="password"
          autoComplete="off"
          placeholder={t.connectors.secretValue}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <Button
          variant="outline"
          disabled={secret.length < 4}
          onClick={() => {
            const s = secret;
            setSecret('');
            void act(
              adminMode.putSecret(siteId, c.id, {
                authKind,
                ...(authKind === 'header' ? { headerName: header } : {}),
                secret: s,
              })
            );
          }}
        >
          {t.connectors.saveSecret}
        </Button>
      </div>
      <SigningSecret siteId={siteId} c={c} onChange={onChange} />
      <div className="space-y-2">
        {c.operations.map((o) => (
          <OperationRow
            key={o.id}
            siteId={siteId}
            cn={c.id}
            o={o}
            all={c.operations}
            act={act}
          />
        ))}
      </div>
      <ConfirmButton
        variant="danger"
        onConfirm={() => void act(adminMode.deleteConnector(siteId, c.id))}
      >
        {t.connectors.remove}
      </ConfirmButton>
    </Card>
  );
}

function OperationRow({
  siteId,
  cn,
  o,
  all,
  act,
}: {
  siteId: string;
  cn: string;
  o: OperationView;
  all: OperationView[];
  act: (p: Promise<unknown>) => void;
}) {
  const { adminMode } = useAssist();
  const t = useAdminTexts();
  const [roles, setRoles] = useState(o.roles.join(', '));
  const tone =
    o.kind === 'read' ? 'success' : o.kind === 'write' ? 'warning' : 'danger';
  return (
    <div className="rounded-xl border border-silver-200/70 dark:border-silver-800 p-2 text-sm space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-xs">
          {o.method} {o.path}
        </code>
        <Badge tone={tone}>{t.connectors.kind[o.kind]}</Badge>
        <span className="text-xs text-silver-500">
          {o.summary ?? o.operationId}
        </span>
      </div>
      {o.unsupported && (
        <div className="text-xs text-amber-600">{t.connectors.unsupported}</div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={o.enabled}
            disabled={o.unsupported}
            onChange={(e) =>
              act(
                adminMode.patchOperation(siteId, cn, o.id, {
                  enabled: e.target.checked,
                })
              )
            }
          />
          {t.connectors.enable}
        </label>
        <input
          className={`${inputClass} max-w-[12rem]`}
          placeholder={`${t.connectors.roles} (${t.connectors.rolesHint})`}
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
          onBlur={() =>
            act(
              adminMode.patchOperation(siteId, cn, o.id, {
                roles: roles
                  .split(',')
                  .map((r) => r.trim())
                  .filter(Boolean),
              })
            )
          }
        />
        {o.kind !== 'danger' && (
          <Button
            variant="ghost"
            onClick={() =>
              act(
                adminMode.patchOperation(siteId, cn, o.id, {
                  kind: o.kind === 'read' ? 'write' : 'danger',
                })
              )
            }
          >
            {t.connectors.raise}
          </Button>
        )}
      </div>
      {o.kind !== 'read' && (
        <OperationActionSettings
          siteId={siteId}
          cn={cn}
          o={o}
          all={all}
          act={act}
        />
      )}
    </div>
  );
}

function Log({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const { locale } = useKit();
  const t = useAdminTexts();
  const st = useAsync(() => adminMode.actionLog(siteId), [siteId]);
  if (st.loading && !st.data) return <Spinner />;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  if (st.data.length === 0) return <Alert>{t.log.empty}</Alert>;
  return (
    <div className="space-y-2">
      {st.data.map((r) => (
        <Card key={r.id} className="text-xs space-y-1">
          <div className="flex flex-wrap gap-2">
            <span>{formatDate(r.at, locale)}</span>
            <span>{r.actor}</span>
            <code>{r.operation}</code>
            <Badge tone={r.outcome === 'ok' ? 'success' : 'warning'}>
              {r.outcome}
              {r.httpStatus ? ` ${r.httpStatus}` : ''}
            </Badge>
          </div>
          <code className="block break-all text-silver-500">
            {r.request.method} {r.request.path}
            {r.request.query && Object.keys(r.request.query).length
              ? `?${new URLSearchParams(r.request.query).toString()}`
              : ''}
          </code>
        </Card>
      ))}
    </div>
  );
}

function StaffLearning({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const t = useAdminTexts();
  const errText = useErrorText();
  const st = useAsync(() => adminMode.learning(siteId), [siteId]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  if (st.loading && !st.data) return <Spinner />;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  if (st.data.length === 0) return <Alert>{t.learning.empty}</Alert>;
  const done = (p: Promise<unknown>, ok?: string) =>
    p
      .then(() => {
        if (ok) setNotice({ tone: 'success', text: ok });
        st.reload();
      })
      .catch((e) => setNotice({ tone: 'danger', text: errText(e) }));
  return (
    <div className="space-y-3">
      <NoticeBar notice={notice} />
      {st.data.map((it) => {
        const answer = answers[it.id] ?? it.proposedAnswer ?? '';
        return (
          <Card key={it.id} className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{t.learning.kinds[it.kind] ?? it.kind}</Badge>
              {it.clusterSize > 1 && (
                <span className="text-xs text-silver-500">
                  +{it.clusterSize - 1} {t.learning.cluster}
                </span>
              )}
            </div>
            <div className="font-medium">{it.question}</div>
            {it.answer && (
              <div className="text-silver-500 whitespace-pre-wrap">
                {it.answer}
              </div>
            )}
            {it.proposedAnswer && (
              <div className="text-xs">
                {t.learning.proposed}: {it.proposedAnswer}
              </div>
            )}
            <textarea
              className={textareaClass}
              placeholder={t.learning.answer}
              value={answer}
              onChange={(e) =>
                setAnswers({ ...answers, [it.id]: e.target.value })
              }
            />
            <div className="flex gap-2">
              <Button
                disabled={!answer.trim()}
                onClick={() =>
                  void done(
                    adminMode.acceptLearning(siteId, it.id, answer.trim()),
                    t.learning.accepted
                  )
                }
              >
                {t.learning.accept}
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void done(adminMode.rejectLearning(siteId, it.id))
                }
              >
                {t.learning.reject}
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Stats({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const t = useAdminTexts();
  const [days, setDays] = useState<7 | 30>(7);
  const st = useAsync(() => adminMode.stats(siteId, days), [siteId, days]);
  if (st.loading && !st.data) return <Spinner />;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  const s = st.data;
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button
          variant={days === 7 ? 'solid' : 'outline'}
          onClick={() => setDays(7)}
        >
          {t.stats.days7}
        </Button>
        <Button
          variant={days === 30 ? 'solid' : 'outline'}
          onClick={() => setDays(30)}
        >
          {t.stats.days30}
        </Button>
      </div>
      <Card className="grid grid-cols-2 gap-2 text-sm">
        <div>
          {t.stats.conversations}: {s.conversations}
        </div>
        <div>
          {t.stats.questions}: {s.questions}
        </div>
        <div>
          {t.stats.refused}: {Math.round(s.refusedShare * 100)}%
        </div>
        <div>
          {t.stats.thumbsDown}: {s.thumbsDown}
        </div>
        <div>
          {t.stats.learningNew}: {s.learningNew}
        </div>
      </Card>
      <Card className="text-sm space-y-1">
        <div className="font-semibold">{t.stats.topQuestions}</div>
        {s.topQuestions.map((q, i) => (
          <div key={i}>
            {q.sample} · {q.count}
          </div>
        ))}
      </Card>
      <Card className="text-sm space-y-1">
        <div className="font-semibold">{t.stats.tools}</div>
        {s.tools.map((x) => (
          <div key={x.operation}>
            <code>{x.operation}</code>: ✓ {x.ok} · ✕ {x.failed}
          </div>
        ))}
      </Card>
      <Card className="text-sm space-y-1">
        <div className="font-semibold">{t.stats.byRole}</div>
        {s.byRole.map((x) => (
          <div key={x.role}>
            {x.role}: {x.conversations} / {x.questions}
          </div>
        ))}
      </Card>
      {s.byEmployee && (
        <Card className="text-sm space-y-1">
          <div className="font-semibold">{t.stats.byEmployee}</div>
          {s.byEmployee.map((x) => (
            <div key={x.employee}>
              {x.employee}: {x.questions}
            </div>
          ))}
        </Card>
      )}
      <div className="text-xs text-silver-500">{t.stats.noRating}</div>
    </div>
  );
}
