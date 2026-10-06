import { useState } from 'react';
import { formatDate, useAsync, useKit } from '../../kit';
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyField,
  Spinner,
  inputClass,
} from '../../kit/ui';
import type {
  ConnectorView,
  OperationView,
  LinkedOperationView,
} from '../../lib/admin-mode-api';
import type { MemoView } from '../../lib/admin-actions-api';
import { useActionsTexts } from '../../lib/admin-mode-view';
import { useAssist } from '../../lib/assist-context';
import { useErrorText } from '../../lib/use-error-text';
import {
  ConfirmButton,
  LoadError,
  NoticeBar,
  textareaClass,
  type Notice,
} from '../knowledge/parts';
import { ProposalCard } from './ProposalCard';
import { MemoCheckPanel, MemoListMeta } from './AdminMemoCheck';

/**
 * Э8 «Админка: действия» — части экранов TMA (ТЗ §3.8 п.3–4, п.6;
 * §5-бис.17 п.14): потолок действий и уведомления, настройки write/danger
 * операции (предпросмотр, компенсация, денежный потолок, слово danger),
 * секрет подписи, журнал действий с откатом, мемо АМ-N. Только
 * `assistAdmin: owner` (экран проверяет, сервер — 403).
 */

export function ActionsSettingsCard({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const t = useActionsTexts();
  const errText = useErrorText();
  const st = useAsync(() => adminMode.get(siteId), [siteId]);
  const [cap, setCap] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  if (!st.data) return null;
  const save = (body: { actionsDailyCap?: number; notifyDanger?: boolean }) =>
    adminMode
      .patch(siteId, body)
      .then(() => {
        setNotice(null);
        st.reload();
      })
      .catch((e) => setNotice({ tone: 'danger', text: errText(e) }));
  return (
    <Card className="space-y-2">
      <div className="font-semibold text-sm">{t.settings.title}</div>
      <NoticeBar notice={notice} />
      {!st.data.planAllowsActions && (
        <Alert tone="warning">{t.settings.planPro}</Alert>
      )}
      <label className="block text-xs text-silver-500">
        {t.settings.dailyCap}
        <input
          className={inputClass}
          inputMode="numeric"
          value={cap ?? String(st.data.actionsDailyCap)}
          onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))}
          onBlur={() => {
            if (cap !== null && cap !== '')
              void save({ actionsDailyCap: Number(cap) });
          }}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={st.data.notifyDanger}
          onChange={(e) => void save({ notifyDanger: e.target.checked })}
        />
        {t.settings.notifyDanger}
      </label>
    </Card>
  );
}

function linkText(l: LinkedOperationView | null): string {
  return l
    ? Object.entries(l.params)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    : '';
}

function parseLinkText(op: string, text: string): LinkedOperationView | null {
  if (!op) return null;
  const params: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) params[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { operationId: op, params };
}

/** Настройки write/danger операции (сервер проверяет всё, как при импорте). */
export function OperationActionSettings({
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
  const t = useActionsTexts();
  const [previewOp, setPreviewOp] = useState(o.preview?.operationId ?? '');
  const [previewMap, setPreviewMap] = useState(linkText(o.preview));
  const [compOp, setCompOp] = useState(o.compensation?.operationId ?? '');
  const [compMap, setCompMap] = useState(linkText(o.compensation));
  const [dry, setDry] = useState(o.dryRunParam ?? '');
  const [amountParam, setAmountParam] = useState(o.amountParam ?? '');
  const [max, setMax] = useState(o.maxAmount?.toString() ?? '');
  const [cap, setCap] = useState(o.dailyAmountCap?.toString() ?? '');
  const [word, setWord] = useState(o.confirmWord ?? '');
  const [idem, setIdem] = useState(o.idempotent);
  const reads = all.filter((x) => x.kind === 'read');
  const writes = all.filter((x) => x.kind !== 'read');
  const bools = o.params.filter((p) => p.type === 'boolean');
  const nums = o.params.filter(
    (p) => p.in !== 'path' && (p.type === 'number' || p.type === 'integer')
  );
  const num = (s: string) => (s.trim() ? Number(s) : null);
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-silver-100/60 dark:bg-silver-900/40 p-2 text-xs">
      <div className="font-semibold">{t.op.actionsTitle}</div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={idem}
          onChange={(e) => setIdem(e.target.checked)}
        />
        {t.op.idempotent}
      </label>
      <label className="block">
        {t.op.preview}
        <select
          className={inputClass}
          value={previewOp}
          onChange={(e) => setPreviewOp(e.target.value)}
        >
          <option value="">{t.op.none}</option>
          {reads.map((x) => (
            <option key={x.id} value={x.operationId}>
              {x.operationId}
            </option>
          ))}
        </select>
      </label>
      {previewOp && (
        <textarea
          className={textareaClass}
          placeholder={t.op.linkHint}
          value={previewMap}
          onChange={(e) => setPreviewMap(e.target.value)}
        />
      )}
      <label className="block">
        {t.op.compensation}
        <select
          className={inputClass}
          value={compOp}
          onChange={(e) => setCompOp(e.target.value)}
        >
          <option value="">{t.op.none}</option>
          {writes.map((x) => (
            <option key={x.id} value={x.operationId}>
              {x.operationId} ({x.kind})
            </option>
          ))}
        </select>
      </label>
      {compOp && (
        <textarea
          className={textareaClass}
          placeholder={t.op.linkHint}
          value={compMap}
          onChange={(e) => setCompMap(e.target.value)}
        />
      )}
      {bools.length > 0 && (
        <label className="block">
          {t.op.dryRunParam}
          <select
            className={inputClass}
            value={dry}
            onChange={(e) => setDry(e.target.value)}
          >
            <option value="">{t.op.none}</option>
            {bools.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {(nums.length > 0 || o.amountParam) && (
        <div className="space-y-1">
          <label className="block">
            {t.op.amountParam}
            <select
              className={inputClass}
              value={amountParam}
              onChange={(e) => setAmountParam(e.target.value)}
            >
              {!o.autoAmountParam && <option value="">{t.op.none}</option>}
              {nums.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {amountParam && (
            <>
              <input
                className={inputClass}
                inputMode="decimal"
                placeholder={t.op.maxAmount}
                value={max}
                onChange={(e) => setMax(e.target.value)}
              />
              <input
                className={inputClass}
                inputMode="decimal"
                placeholder={t.op.dailyAmountCap}
                value={cap}
                onChange={(e) => setCap(e.target.value)}
              />
              <div className="text-silver-500">{t.op.amountRequired}</div>
            </>
          )}
        </div>
      )}
      {o.kind === 'danger' && (
        <input
          className={inputClass}
          placeholder={t.op.confirmWord}
          value={word}
          onChange={(e) => setWord(e.target.value)}
        />
      )}
      <Button
        variant="outline"
        onClick={() =>
          act(
            adminMode.patchOperation(siteId, cn, o.id, {
              idempotent: idem,
              preview: parseLinkText(previewOp, previewMap),
              compensation: parseLinkText(compOp, compMap),
              ...(bools.length ? { dryRunParam: dry || null } : {}),
              ...(amountParam
                ? {
                    amountParam,
                    maxAmount: num(max),
                    dailyAmountCap: num(cap),
                  }
                : o.autoAmountParam
                  ? {}
                  : { amountParam: null }),
              ...(o.kind === 'danger'
                ? { confirmWord: word.trim() || null }
                : {}),
            })
          )
        }
      >
        {t.op.save}
      </Button>
    </div>
  );
}

/** Секрет подписи изменяющих запросов (показ один раз). */
export function SigningSecret({
  siteId,
  c,
  onChange,
}: {
  siteId: string;
  c: ConnectorView;
  onChange: () => void;
}) {
  const { adminActions } = useAssist();
  const { dict } = useKit();
  const t = useActionsTexts();
  const errText = useErrorText();
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-1 text-sm">
      <div>
        {t.op.signing}: {c.signing.set ? t.op.signingSet : '—'}
      </div>
      {secret && (
        <>
          <Alert tone="warning">{t.op.signingOnce}</Alert>
          <CopyField
            label="X-V4C-Signature secret"
            value={secret}
            copyLabel={dict.common.copy}
            copiedLabel={dict.common.copied}
          />
        </>
      )}
      {err && <Alert tone="danger">{err}</Alert>}
      <Button
        variant="outline"
        onClick={() =>
          void adminActions
            .signingSecret(siteId, c.id)
            .then((r) => {
              setSecret(r.secret);
              onChange();
            })
            .catch((e) => setErr(errText(e)))
        }
      >
        {t.op.signingIssue}
      </Button>
    </div>
  );
}

/** Журнал действий сотрудников с откатом (§3.8 п.6; §5-бис.15 п.11). */
export function ActionsLog({ siteId }: { siteId: string }) {
  const { adminActions } = useAssist();
  const { locale } = useKit();
  const t = useActionsTexts();
  const errText = useErrorText();
  const [review, setReview] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [own, setOwn] = useState<string[]>([]);
  const st = useAsync(
    () => adminActions.list(siteId, review),
    [siteId, review]
  );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-sm">{t.log.actionsTitle}</span>
        <Button
          variant={review ? 'outline' : 'solid'}
          onClick={() => setReview(false)}
        >
          {t.log.all}
        </Button>
        <Button
          variant={review ? 'solid' : 'outline'}
          onClick={() => setReview(true)}
        >
          {t.log.review}
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void adminActions
              .verify(siteId)
              .then((r) =>
                setNotice(
                  r.ok
                    ? { tone: 'success', text: t.log.verifyOk }
                    : {
                        tone: 'danger',
                        text: `${t.log.verifyBroken} ${r.brokenAt}`,
                      }
                )
              )
              .catch((e) => setNotice({ tone: 'danger', text: errText(e) }))
          }
        >
          {t.log.verify}
        </Button>
      </div>
      <NoticeBar notice={notice} />
      {st.loading && !st.data && <Spinner />}
      {st.error && <LoadError error={st.error} onRetry={st.reload} />}
      {st.data && st.data.length === 0 && <Alert>{t.log.empty}</Alert>}
      {st.data?.map((p) => (
        <div key={p.id} className="space-y-1">
          <div className="text-xs text-silver-500">
            {formatDate(p.createdAt, locale)} · {t.log.by}: {p.actor ?? '—'} ·{' '}
            <code>{p.operation}</code>
          </div>
          {own.includes(p.id) || p.status === 'pending' ? (
            <ProposalCard siteId={siteId} p={p} onChange={st.reload} />
          ) : (
            <Card className="text-xs space-y-1">
              <div className="flex flex-wrap gap-2 items-center">
                <Badge tone={p.status === 'done' ? 'success' : 'warning'}>
                  {p.status}
                </Badge>
                {p.chainStatus && <span>{p.chainStatus}</span>}
                {p.unrequested && <Badge tone="danger">!</Badge>}
              </div>
              {p.status === 'done' &&
                p.chainStatus !== 'compensated' &&
                (p.undoAvailable ? (
                  <ConfirmButton
                    variant="outline"
                    onConfirm={() =>
                      void adminActions
                        .rollback(siteId, p.id)
                        .then((r) => {
                          if (r.proposal) setOwn((x) => [...x, r.proposal!.id]);
                          st.reload();
                        })
                        .catch((e) =>
                          setNotice({ tone: 'danger', text: errText(e) })
                        )
                    }
                  >
                    {t.log.rollback}
                  </ConfirmButton>
                ) : (
                  <div className="text-silver-500">{t.log.noRollback}</div>
                ))}
            </Card>
          )}
        </div>
      ))}
    </div>
  );
}

/** Мемо «Админки» АМ-N: список, черновик (JSON слотов и шагов), ворота, публикация. */
export function MemosTab({ siteId }: { siteId: string }) {
  const { adminActions } = useAssist();
  const t = useActionsTexts();
  const errText = useErrorText();
  const st = useAsync(() => adminActions.memos(siteId), [siteId]);
  const [open, setOpen] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  if (st.loading && !st.data) return <Spinner />;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  const d = st.data;
  return (
    <div className="space-y-3">
      <Card className="space-y-2">
        <div className="font-semibold text-sm">{t.memo.title}</div>
        <div className="text-xs text-silver-500">{t.memo.hint}</div>
        {d.limit === 0 ? (
          <Alert tone="warning">{t.memo.planPro}</Alert>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs">{t.memo.used(d.used, d.limit)}</span>
            <Button
              disabled={d.used >= d.limit}
              onClick={() =>
                void adminActions
                  .createMemo(siteId, { names: { uk: `АМ ${d.used + 1}` } })
                  .then((m) => {
                    setOpen(m.number);
                    st.reload();
                  })
                  .catch((e) => setNotice({ tone: 'danger', text: errText(e) }))
              }
            >
              {t.memo.create}
            </Button>
          </div>
        )}
      </Card>
      <NoticeBar notice={notice} />
      {d.memos.length === 0 && <Alert>{t.memo.empty}</Alert>}
      {d.memos.map((m) => (
        <Card key={m.number} className="space-y-2">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left text-sm"
            onClick={() => setOpen(open === m.number ? null : m.number)}
          >
            <b>АМ-{m.number}</b> {m.name}
            <Badge
              tone={
                m.status === 'published'
                  ? 'success'
                  : m.status === 'needs_review'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {t.memo.statuses[m.status] ?? m.status}
            </Badge>
          </button>
          <MemoListMeta m={m} />
          {open === m.number && (
            <MemoEditor siteId={siteId} n={m.number} onChange={st.reload} />
          )}
        </Card>
      ))}
    </div>
  );
}

function MemoEditor({
  siteId,
  n,
  onChange,
}: {
  siteId: string;
  n: number;
  onChange: () => void;
}) {
  const { adminActions } = useAssist();
  const t = useActionsTexts();
  const errText = useErrorText();
  const st = useAsync(() => adminActions.memo(siteId, n), [siteId, n]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [form, setForm] = useState<{
    name: string;
    triggers: string;
    goal: string;
    slots: string;
    steps: string;
  } | null>(null);
  if (st.loading && !st.data) return <Spinner />;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  const m: MemoView = st.data;
  const dr = m.draft as {
    names?: Record<string, string>;
    triggers?: Record<string, string[]>;
    goal?: { text?: Record<string, string> };
    slots?: unknown[];
    steps?: unknown[];
  };
  const f = form ?? {
    name: dr.names?.uk ?? '',
    triggers: (dr.triggers?.uk ?? []).join('\n'),
    goal: dr.goal?.text?.uk ?? '',
    slots: JSON.stringify(dr.slots ?? [], null, 1),
    steps: JSON.stringify(dr.steps ?? [], null, 1),
  };
  const run = (p: Promise<unknown>, ok?: string) =>
    p
      .then(() => {
        setForm(null);
        st.reload();
        onChange();
        if (ok) setNotice({ tone: 'success', text: ok });
      })
      .catch((e) => setNotice({ tone: 'danger', text: errText(e) }));
  const save = () => {
    let slots: unknown;
    let steps: unknown;
    try {
      slots = JSON.parse(f.slots || '[]');
      steps = JSON.parse(f.steps || '[]');
    } catch {
      setNotice({ tone: 'danger', text: t.memo.invalidJson });
      return;
    }
    void run(
      adminActions.saveDraft(siteId, n, m.draftRevision, {
        names: { uk: f.name },
        triggers: {
          uk: f.triggers
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
        },
        goal: { text: { uk: f.goal } },
        slots,
        steps,
      })
    );
  };
  const last = m.versions[0];
  return (
    <div className="space-y-2 text-xs">
      <NoticeBar notice={notice} />
      <label className="block">
        {t.memo.names}
        <input
          className={inputClass}
          value={f.name}
          onChange={(e) => setForm({ ...f, name: e.target.value })}
        />
      </label>
      <label className="block">
        {t.memo.triggers}
        <textarea
          className={textareaClass}
          value={f.triggers}
          onChange={(e) => setForm({ ...f, triggers: e.target.value })}
        />
        <span className="text-silver-500">{t.memo.triggersHint}</span>
      </label>
      <label className="block">
        {t.memo.goal}
        <input
          className={inputClass}
          value={f.goal}
          onChange={(e) => setForm({ ...f, goal: e.target.value })}
        />
      </label>
      <label className="block">
        {t.memo.slots}
        <textarea
          className={`${textareaClass} font-mono`}
          value={f.slots}
          onChange={(e) => setForm({ ...f, slots: e.target.value })}
        />
        <span className="text-silver-500">{t.memo.slotsHint}</span>
      </label>
      <label className="block">
        {t.memo.steps}
        <textarea
          className={`${textareaClass} font-mono`}
          rows={6}
          value={f.steps}
          onChange={(e) => setForm({ ...f, steps: e.target.value })}
        />
        <span className="text-silver-500">{t.memo.stepsHint}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={save}>
          {t.memo.saveDraft}
        </Button>
        <Button
          variant="outline"
          onClick={() => void run(adminActions.buildVersion(siteId, n))}
        >
          {t.memo.build}
        </Button>
        {last &&
          last.status === 'checking' &&
          last.check &&
          last.check.result !== 'fail' && (
            <Button
              onClick={() =>
                void run(adminActions.publish(siteId, n, last.number))
              }
            >
              {t.memo.publish} {last.number}
            </Button>
          )}
        {(m.status === 'published' || m.status === 'needs_review') && (
          <Button
            variant="outline"
            onClick={() => void run(adminActions.setEnabled(siteId, n, false))}
          >
            {t.memo.disable}
          </Button>
        )}
        {m.status === 'disabled' && (
          <Button
            variant="outline"
            onClick={() => void run(adminActions.setEnabled(siteId, n, true))}
          >
            {t.memo.enable}
          </Button>
        )}
        <ConfirmButton
          variant="danger"
          onConfirm={() => void run(adminActions.removeMemo(siteId, n))}
        >
          {t.memo.remove}
        </ConfirmButton>
      </div>
      <MemoCheckPanel
        siteId={siteId}
        m={m}
        onRefresh={() => {
          st.reload();
          onChange();
        }}
      />
      {m.versions.slice(0, 5).map((v) => (
        <div key={v.number}>
          {t.memo.version} {v.number}:{' '}
          {v.status === 'held' ? t.memo.held : t.memo.passed}
          {v.kinds.length ? ` · ${v.kinds.join(' → ')}` : ''}
          {v.problems.map((p) => (
            <div key={`${p.path}${p.code}`} className="text-rose-500">
              {p.path}: {p.code}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
