/**
 * «Тестовые учётные записи» в мастере обучалки по сайту заказчика (Э-С
 * Ш2). Свёрнутая карточка под записью: список грузится по раскрытию.
 *
 *  - режим A (сайт подтверждён) — реестр учёток сайта в кабинете сайтов,
 *    общий с QA: добавить, изменить (роль, пакет, хосты, продукты, срок,
 *    заморозка), «Забыть». Пароль — только на запись, не показывается;
 *  - режим B — личный сохранённый вход по этому сайту: подпись и «Забыть».
 *
 * Хранилище не подключено — честная строка «данные в черновике».
 */
import { useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Select,
  Spinner,
} from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import {
  LIFETIME_DAYS,
  ROLE_HINTS,
  emptyTestAccountForm,
  formFromAccount,
  productLabel,
  roleHintKey,
  statusTone,
  testAccountPayload,
  toggle,
  type TestAccountForm,
} from '../../lib/test-accounts';
import {
  createTestAccount,
  forgetTestAccount,
  listTestAccounts,
  updateTestAccount,
} from '../../services/test-accounts-api';
import { errorMessage } from '../../services/projects-api';
import type {
  SiteTestAccount,
  TestAccountProduct,
  TestAccountSecretFlags,
  TestAccountsView,
  UserSiteSession,
} from '../../types/test-accounts';

type Dict = ReturnType<typeof useI18n>['dict']['clientSiteTestAccounts'];

export function ClientSiteTestAccounts({ projectId }: { projectId: string }) {
  const { dict, locale } = useI18n();
  const t = dict.clientSiteTestAccounts;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TestAccountsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** `new` — форма новой учётки; id — правка; null — формы нет. */
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<TestAccountForm | null>(null);
  const [forget, setForget] = useState<string | null>(null);

  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(locale) : '';

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setView(await listTestAccounts(projectId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !view) void load();
  }

  async function run(job: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await job();
      setNotice(ok);
      setEditing(null);
      setForm(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!form || !editing) return;
    const r = testAccountPayload(form, { isNew: editing === 'new' });
    if ('error' in r) {
      setError(t.errors[r.error]);
      return;
    }
    void run(
      () =>
        editing === 'new'
          ? createTestAccount(projectId, r.payload)
          : updateTestAccount(projectId, editing, r.payload),
      t.saved
    );
  }

  const defaultHost =
    view?.hosts.find((h) =>
      view.accounts.some((a) => a.coversHost && a.hostIds.includes(h.id))
    )?.id ??
    view?.hosts[0]?.id ??
    null;

  return (
    <Card className="mb-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={toggleOpen}
        aria-expanded={open}
      >
        <KeyRound size={16} className="text-accent" />
        <span className="flex-1 font-medium">{t.title}</span>
        <span className="text-sm text-gray-500">{open ? t.hide : t.show}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {loading && !view && <Spinner />}
          {error && (
            <Alert tone="error" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}
          {notice && <Alert tone="success">{notice}</Alert>}

          {view && !view.hasDraft && <Alert tone="info">{t.noDraft}</Alert>}
          {view && view.hasDraft && view.store === 'off' && (
            <Alert tone="info">{t.storeOff}</Alert>
          )}

          {view && view.hasDraft && view.store === 'on' && (
            <>
              <p className="text-sm text-gray-500">
                {view.mode === 'A' ? t.subtitleA : t.subtitleB}
              </p>

              {view.mode === 'A' &&
                view.accounts.map((a) =>
                  editing === a.id && form ? (
                    <AccountForm
                      key={a.id}
                      t={t}
                      form={form}
                      setForm={setForm}
                      hosts={view.hosts}
                      isNew={false}
                      busy={busy}
                      onSave={save}
                      onCancel={() => {
                        setEditing(null);
                        setForm(null);
                      }}
                    />
                  ) : (
                    <AccountRow
                      key={a.id}
                      t={t}
                      account={a}
                      hosts={view.hosts}
                      isDraft={view.draftRecordId === a.id}
                      date={date}
                      busy={busy}
                      onEdit={() => {
                        setEditing(a.id);
                        setForm(formFromAccount(a));
                      }}
                      onFreeze={() =>
                        void run(
                          () =>
                            updateTestAccount(projectId, a.id, {
                              status:
                                a.status === 'frozen' ? 'active' : 'frozen',
                            }),
                          t.saved
                        )
                      }
                      onForget={() => setForget(a.id)}
                    />
                  )
                )}

              {view.mode === 'A' &&
                view.accounts.length === 0 &&
                editing !== 'new' && <p className="text-sm">{t.empty}</p>}

              {view.mode === 'A' && editing === 'new' && form && (
                <AccountForm
                  t={t}
                  form={form}
                  setForm={setForm}
                  hosts={view.hosts}
                  isNew
                  busy={busy}
                  onSave={save}
                  onCancel={() => {
                    setEditing(null);
                    setForm(null);
                  }}
                />
              )}

              {view.mode === 'A' && editing === null && (
                <Button
                  variant="outline"
                  icon={<Plus size={16} />}
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setEditing('new');
                    setForm(emptyTestAccountForm(defaultHost));
                  }}
                >
                  {t.add}
                </Button>
              )}

              {view.mode === 'B' &&
                (view.sessions.length === 0 ? (
                  <p className="text-sm">{t.emptyB}</p>
                ) : (
                  view.sessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      t={t}
                      session={s}
                      isDraft={view.draftRecordId === s.id}
                      date={date}
                      busy={busy}
                      onRename={(label) =>
                        void run(
                          () => updateTestAccount(projectId, s.id, { label }),
                          t.saved
                        )
                      }
                      onForget={() => setForget(s.id)}
                    />
                  ))
                ))}
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={forget !== null}
        title={t.forgetTitle}
        danger
        busy={busy}
        confirmLabel={t.forget}
        onConfirm={() => {
          const id = forget;
          setForget(null);
          if (id) void run(() => forgetTestAccount(projectId, id), t.forgotten);
        }}
        onCancel={() => setForget(null)}
      >
        {view?.mode === 'A' ? t.forgetBody : t.forgetBodyB}
      </ConfirmDialog>
    </Card>
  );
}

function SecretBadges({ t, s }: { t: Dict; s: TestAccountSecretFlags }) {
  const none = !s.password && !s.loginFields && !s.session;
  return (
    <span className="flex flex-wrap gap-1">
      {s.password && <Badge tone="success">{t.hasPassword}</Badge>}
      {s.loginFields && <Badge tone="success">{t.hasLoginFields}</Badge>}
      {s.session && <Badge tone="accent">{t.hasSession}</Badge>}
      {none && <Badge>{t.noSecrets}</Badge>}
    </span>
  );
}

function AccountRow(props: {
  t: Dict;
  account: SiteTestAccount;
  hosts: TestAccountsView['hosts'];
  isDraft: boolean;
  date: (iso: string | null) => string;
  busy: boolean;
  onEdit: () => void;
  onFreeze: () => void;
  onForget: () => void;
}) {
  const { t, account: a } = props;
  const role = roleHintKey(a.role);
  const status = a.status as keyof Dict['status'];
  const hostNames = a.hostIds
    .map((id) => props.hosts.find((h) => h.id === id)?.host)
    .filter(Boolean)
    .join(', ');
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{a.label}</span>
        <Badge tone={statusTone(a.status)}>
          {t.status[status] ?? a.status}
        </Badge>
        {props.isDraft && <Badge tone="accent">{t.thisDraft}</Badge>}
      </div>
      <div className="text-sm text-gray-500 space-y-1">
        {(a.role || a.plan) && (
          <div>
            {[role ? t.roles[role] : a.role, a.plan]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
        {a.username && <div>{a.username}</div>}
        {hostNames && <div>{hostNames}</div>}
        <div>{a.products.map((p) => productLabel(p, t)).join(', ')}</div>
        <SecretBadges t={t} s={a.secrets} />
        <div>
          {a.lastUsedAt &&
            `${t.lastUsed.replace('{date}', props.date(a.lastUsedAt))} · `}
          {t.expires.replace('{date}', props.date(a.expiresAt))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={props.busy}
          onClick={props.onEdit}
        >
          {t.edit}
        </Button>
        {a.status !== 'expired' && (
          <Button
            variant="outline"
            size="sm"
            disabled={props.busy}
            onClick={props.onFreeze}
          >
            {a.status === 'frozen' ? t.unfreeze : t.freeze}
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={14} />}
          disabled={props.busy}
          onClick={props.onForget}
        >
          {t.forget}
        </Button>
      </div>
    </div>
  );
}

function SessionRow(props: {
  t: Dict;
  session: UserSiteSession;
  isDraft: boolean;
  date: (iso: string | null) => string;
  busy: boolean;
  onRename: (label: string | null) => void;
  onForget: () => void;
}) {
  const { t, session: s } = props;
  const [label, setLabel] = useState(s.label ?? '');
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{s.label ?? s.origin}</span>
        {props.isDraft && <Badge tone="accent">{t.thisDraft}</Badge>}
      </div>
      <div className="text-sm text-gray-500 space-y-1">
        <div>{s.origin}</div>
        <SecretBadges t={t} s={s.secrets} />
        <div>
          {s.lastUsedAt &&
            `${t.lastUsed.replace('{date}', props.date(s.lastUsedAt))} · `}
          {t.expires.replace('{date}', props.date(s.expiresAt))}
        </div>
      </div>
      <Field label={t.label}>
        <Input
          value={label}
          maxLength={80}
          onChange={(e) => setLabel(e.target.value)}
          disabled={props.busy}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={props.busy || label === (s.label ?? '')}
          onClick={() => props.onRename(label.trim() || null)}
        >
          {t.save}
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={14} />}
          disabled={props.busy}
          onClick={props.onForget}
        >
          {t.forget}
        </Button>
      </div>
    </div>
  );
}

function AccountForm(props: {
  t: Dict;
  form: TestAccountForm;
  setForm: (f: TestAccountForm) => void;
  hosts: TestAccountsView['hosts'];
  isNew: boolean;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t, form, setForm } = props;
  const set = (patch: Partial<TestAccountForm>) =>
    setForm({ ...form, ...patch });
  const products: TestAccountProduct[] = ['tutorial', 'qa'];
  return (
    <div className="rounded-lg border border-accent/40 p-3 space-y-3">
      <Field label={t.label}>
        <Input
          value={form.label}
          maxLength={80}
          placeholder={t.labelPlaceholder}
          onChange={(e) => set({ label: e.target.value })}
        />
      </Field>
      <Field label={t.role}>
        <Input
          value={form.role}
          maxLength={40}
          list="test-account-roles"
          placeholder={t.rolePlaceholder}
          onChange={(e) => set({ role: e.target.value })}
        />
        <datalist id="test-account-roles">
          {ROLE_HINTS.map((r) => (
            <option key={r} value={r}>
              {t.roles[r]}
            </option>
          ))}
        </datalist>
      </Field>
      <Field label={t.plan}>
        <Input
          value={form.plan}
          maxLength={60}
          onChange={(e) => set({ plan: e.target.value })}
        />
      </Field>
      <Field label={t.username}>
        <Input
          value={form.username}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => set({ username: e.target.value })}
        />
      </Field>
      <Field label={t.password} hint={props.isNew ? undefined : t.passwordKeep}>
        <Input
          type="password"
          value={form.password}
          maxLength={1024}
          autoComplete="new-password"
          onChange={(e) => set({ password: e.target.value })}
        />
      </Field>
      <Field label={t.hosts}>
        <div className="space-y-1">
          {props.hosts.map((h) => (
            <label key={h.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.hostIds.includes(h.id)}
                onChange={() => set({ hostIds: toggle(form.hostIds, h.id) })}
              />
              <span>{h.host}</span>
              {!h.verified && <Badge tone="warning">{t.hostNotVerified}</Badge>}
            </label>
          ))}
        </div>
      </Field>
      <Field label={t.products}>
        <div className="flex flex-wrap gap-3">
          {products.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.products.includes(p)}
                onChange={() => set({ products: toggle(form.products, p) })}
              />
              {productLabel(p, t)}
            </label>
          ))}
        </div>
        {form.otherProducts.length > 0 && (
          <div className="mt-1 text-xs text-silver-400">
            {form.otherProducts.map((p) => productLabel(p, t)).join(', ')}
          </div>
        )}
      </Field>
      <Field label={t.lifetime}>
        <Select
          value={form.lifetimeDays === null ? '' : String(form.lifetimeDays)}
          onChange={(e) =>
            set({
              lifetimeDays: e.target.value ? Number(e.target.value) : null,
            })
          }
        >
          {!props.isNew && <option value="">{t.lifetimeKeep}</option>}
          {LIFETIME_DAYS.map((d) => (
            <option key={d} value={d}>
              {t.days.replace('{n}', String(d))}
            </option>
          ))}
        </Select>
      </Field>
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
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}
