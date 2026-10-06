import { useEffect, useState } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { formatDate } from '../format';
import { ApiError } from '../envelope';
import { errorText } from '../errors';
import { canManage } from '../account-select';
import { AccountContextNote } from '../ui/AccountContextNote';
import { useAsync } from '../use-async';
import { hostView } from '../verification';
import {
  TEST_ACCOUNT_LIFETIME_DAYS,
  TEST_ACCOUNT_ROLE_HINTS,
  emptyTestAccountForm,
  isTestAccountErrorCode,
  testAccountForm,
  testAccountRequest,
  toggleItem,
  type TestAccount,
  type TestAccountForm,
  type TestAccountProduct,
} from '../test-accounts';
import type { Site } from '../types';
import {
  Alert,
  Badge,
  Button,
  Card,
  ScreenTitle,
  Spinner,
  inputClass,
} from '../ui';

/**
 * «Тестовые учётные записи» сайта (Э-С Ш2) — один экран на TMA помощника и
 * QA-TMA (и тот же реестр видит мастер обучалки в TMA генератора): список,
 * завести, изменить, заморозить, «Забыть». Пароль — только на запись.
 *
 * Права — владелец и менеджер кабинета (сервер: `RequireAccountRoles`);
 * оператор видит пояснение, а не пустой список. Необратимое «Забыть» —
 * двойным нажатием (не `window.confirm`: в части WebView Telegram он
 * заблокирован).
 */
export function TestAccountsScreen({ siteId }: { siteId: string }) {
  const { api, dict, account, locale } = useKit();
  const t = dict.testAccounts;
  const manage = canManage(account.me.role);
  const site = useAsync<Site | null>(
    async () => (await api.listSites()).find((s) => s.id === siteId) ?? null,
    [api, siteId]
  );
  const list = useAsync<TestAccount[]>(
    () =>
      manage
        ? api.testAccounts.list(siteId)
        : Promise.resolve([] as TestAccount[]),
    [api, siteId, manage]
  );
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<TestAccountForm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  const failText = (e: unknown) =>
    e instanceof ApiError && isTestAccountErrorCode(e.code)
      ? t.errors[e.code]
      : errorText(e, dict);

  async function run(key: string, job: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setNotice(null);
    try {
      await job();
      setNotice({ tone: 'success', text: ok });
      setEditing(null);
      setForm(null);
      list.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: failText(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!manage) {
    return (
      <div className="space-y-4">
        <ScreenTitle>{t.title}</ScreenTitle>
        <Alert tone="neutral">{t.onlyManagers}</Alert>
      </div>
    );
  }
  if ((list.loading && !list.data) || (site.loading && !site.data)) {
    return <Spinner label={dict.common.loading} />;
  }
  if (list.error || site.error) {
    return (
      <Alert tone="danger" title={dict.common.error}>
        {failText(list.error ?? site.error)}
        <div className="mt-2">
          <Button variant="outline" onClick={list.reload}>
            {dict.common.retry}
          </Button>
        </div>
      </Alert>
    );
  }

  const hosts = site.data?.hosts ?? [];
  const now = new Date();
  const accounts = list.data ?? [];

  function save() {
    if (!form || !editing) return;
    const r = testAccountRequest(form, editing === 'new');
    if ('error' in r) {
      setNotice({ tone: 'danger', text: t.formErrors[r.error] });
      return;
    }
    void run(
      editing,
      () =>
        editing === 'new'
          ? api.testAccounts.create(siteId, r.payload)
          : api.testAccounts.update(siteId, editing, r.payload),
      t.saved
    );
  }

  function forget(a: TestAccount) {
    if (armed !== a.id) {
      setArmed(a.id);
      return;
    }
    setArmed(null);
    void run(a.id, () => api.testAccounts.remove(siteId, a.id), t.forgotten);
  }

  const formView = (isNew: boolean) =>
    form && (
      <AccountForm
        form={form}
        setForm={setForm}
        hosts={hosts.map((h) => ({
          id: h.id,
          host: h.host,
          verified: hostView(h, now) === 'verified',
        }))}
        isNew={isNew}
        busy={busy !== null}
        onSave={save}
        onCancel={() => {
          setEditing(null);
          setForm(null);
        }}
      />
    );

  return (
    <div className="space-y-4">
      <ScreenTitle
        action={
          editing === null ? (
            <Button
              icon={<Plus size={16} />}
              onClick={() => {
                setNotice(null);
                setEditing('new');
                setForm(
                  emptyTestAccountForm(hosts.map((h) => h.id).slice(0, 1))
                );
              }}
            >
              {t.add}
            </Button>
          ) : undefined
        }
      >
        {t.title}
      </ScreenTitle>
      <p className="text-sm text-silver-500">{t.intro}</p>
      {/* Аудит Н-1: пароли учёток видит и этот кабинет. */}
      <AccountContextNote />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {editing === 'new' && <Card>{formView(true)}</Card>}
      {accounts.length === 0 && editing !== 'new' && (
        <Alert tone="neutral">{t.empty}</Alert>
      )}
      {accounts.map((a) => (
        <Card key={a.id}>
          {editing === a.id ? (
            formView(false)
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <KeyRound size={16} className="text-silver-400" />
                <span className="font-medium">{a.label}</span>
                <Badge
                  tone={
                    a.status === 'active'
                      ? 'success'
                      : a.status === 'frozen'
                        ? 'warning'
                        : 'danger'
                  }
                >
                  {t.status[a.status as keyof typeof t.status] ?? a.status}
                </Badge>
                {a.createdBy === 'generator' && (
                  <Badge tone="accent">{t.fromGenerator}</Badge>
                )}
              </div>
              <div className="text-sm text-silver-500 space-y-1">
                {(a.role || a.plan) && (
                  <div>
                    {[
                      a.role &&
                      (TEST_ACCOUNT_ROLE_HINTS as readonly string[]).includes(
                        a.role
                      )
                        ? t.roles[a.role as keyof typeof t.roles]
                        : a.role,
                      a.plan,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
                {a.username && <div>{a.username}</div>}
                <div>
                  {a.hostIds
                    .map((id) => hosts.find((h) => h.id === id)?.host)
                    .filter(Boolean)
                    .join(', ')}
                </div>
                <div>
                  {a.products
                    .map((p) =>
                      p === 'tutorial'
                        ? t.productTutorial
                        : p === 'qa'
                          ? t.productQa
                          : p === 'assist-admin'
                            ? t.productAssistAdmin
                            : p
                    )
                    .join(', ')}
                </div>
                <div className="flex flex-wrap gap-1">
                  {a.secrets.password && (
                    <Badge tone="success">{t.hasPassword}</Badge>
                  )}
                  {a.secrets.loginFields && (
                    <Badge tone="success">{t.hasLoginFields}</Badge>
                  )}
                  {a.secrets.session && (
                    <Badge tone="accent">{t.hasSession}</Badge>
                  )}
                  {!a.secrets.password &&
                    !a.secrets.loginFields &&
                    !a.secrets.session && <Badge>{t.noSecrets}</Badge>}
                </div>
                <div>
                  {a.lastUsedAt &&
                    `${fmt(t.lastUsed, { date: formatDate(a.lastUsedAt, locale) })} · `}
                  {fmt(t.expires, { date: formatDate(a.expiresAt, locale) })}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => {
                    setNotice(null);
                    setEditing(a.id);
                    setForm(testAccountForm(a));
                  }}
                >
                  {t.edit}
                </Button>
                {a.status !== 'expired' && (
                  <Button
                    variant="outline"
                    loading={busy === `${a.id}:freeze`}
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        `${a.id}:freeze`,
                        () =>
                          api.testAccounts.update(siteId, a.id, {
                            status: a.status === 'frozen' ? 'active' : 'frozen',
                          }),
                        t.saved
                      )
                    }
                  >
                    {a.status === 'frozen' ? t.unfreeze : t.freeze}
                  </Button>
                )}
                <Button
                  variant="danger"
                  loading={busy === a.id}
                  disabled={busy !== null && busy !== a.id}
                  onClick={() => forget(a)}
                >
                  {armed === a.id ? t.forgetConfirm : t.forget}
                </Button>
              </div>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function AccountForm(props: {
  form: TestAccountForm;
  setForm: (f: TestAccountForm) => void;
  hosts: Array<{ id: string; host: string; verified: boolean }>;
  isNew: boolean;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { dict } = useKit();
  const t = dict.testAccounts;
  const { form, setForm } = props;
  const set = (patch: Partial<TestAccountForm>) =>
    setForm({ ...form, ...patch });
  const products: TestAccountProduct[] = ['tutorial', 'qa', 'assist-admin'];
  const label = (text: string, input: JSX.Element) => (
    <label className="block space-y-1 text-sm">
      <span className="text-silver-500">{text}</span>
      {input}
    </label>
  );
  return (
    <div className="space-y-3">
      {label(
        t.label,
        <input
          className={inputClass}
          value={form.label}
          maxLength={80}
          placeholder={t.labelPlaceholder}
          onChange={(e) => set({ label: e.target.value })}
        />
      )}
      {label(
        t.role,
        <>
          <input
            className={inputClass}
            value={form.role}
            maxLength={40}
            list="kit-test-account-roles"
            onChange={(e) => set({ role: e.target.value })}
          />
          <datalist id="kit-test-account-roles">
            {TEST_ACCOUNT_ROLE_HINTS.map((r) => (
              <option key={r} value={r}>
                {t.roles[r]}
              </option>
            ))}
          </datalist>
        </>
      )}
      {label(
        t.plan,
        <input
          className={inputClass}
          value={form.plan}
          maxLength={60}
          onChange={(e) => set({ plan: e.target.value })}
        />
      )}
      {label(
        t.username,
        <input
          className={inputClass}
          value={form.username}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => set({ username: e.target.value })}
        />
      )}
      {label(
        t.password,
        <input
          className={inputClass}
          type="password"
          value={form.password}
          maxLength={1024}
          autoComplete="new-password"
          onChange={(e) => set({ password: e.target.value })}
        />
      )}
      {!props.isNew && (
        <p className="text-xs text-silver-500">{t.passwordKeep}</p>
      )}
      <fieldset className="space-y-1 text-sm">
        <legend className="text-silver-500">{t.hosts}</legend>
        {props.hosts.map((h) => (
          <label key={h.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.hostIds.includes(h.id)}
              onChange={() => set({ hostIds: toggleItem(form.hostIds, h.id) })}
            />
            <span>{h.host}</span>
            {!h.verified && <Badge tone="warning">{t.hostNotVerified}</Badge>}
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-1 text-sm">
        <legend className="text-silver-500">{t.products}</legend>
        <div className="flex flex-wrap gap-3">
          {products.map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.products.includes(p)}
                onChange={() => set({ products: toggleItem(form.products, p) })}
              />
              {p === 'tutorial'
                ? t.productTutorial
                : p === 'qa'
                  ? t.productQa
                  : t.productAssistAdmin}
            </label>
          ))}
        </div>
      </fieldset>
      {label(
        t.lifetime,
        <select
          className={inputClass}
          value={form.lifetimeDays === null ? '' : String(form.lifetimeDays)}
          onChange={(e) =>
            set({
              lifetimeDays: e.target.value ? Number(e.target.value) : null,
            })
          }
        >
          {!props.isNew && <option value="">{t.lifetimeKeep}</option>}
          {TEST_ACCOUNT_LIFETIME_DAYS.map((d) => (
            <option key={d} value={d}>
              {fmt(t.days, { n: d })}
            </option>
          ))}
        </select>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.confirmedTestAccount}
          onChange={(e) => set({ confirmedTestAccount: e.target.checked })}
        />
        {t.confirmTest}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button loading={props.busy} onClick={props.onSave}>
          {t.save}
        </Button>
        <Button
          variant="outline"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          {dict.common.cancel}
        </Button>
      </div>
    </div>
  );
}
