/**
 * F17/§15.4 — копии и восстановление (P-G2, §14.1 `backups`): список
 * копий, ручная копия, проверка без записи (dry-run) и восстановление в
 * НОВЫЙ продукт на тестовом сайте того же кабинета — только владелец
 * кабинета (`restore.apply`; решает сервер). Выключенные копии — 501, не
 * «успех».
 */
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, ScreenTitle } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  BACKUP_STATUSES,
  type BackupView,
  type RestoreView,
} from '../../../lib/publisher/reports-api';
import { fmtText } from '../../../lib/publisher/view';
import { useListFilters, useMutation } from '../hooks';
import {
  ConfirmButton,
  DateText,
  Field,
  JsonView,
  ListToolbar,
  Loadable,
  NoPermission,
  PubErrorAlert,
  Row,
  Section,
  StatusBadge,
  TextInput,
} from '../parts';
import type { PublisherSectionProps } from '../registry';
import { ActionBlock, ListRow } from './ops-parts';
import { useOps } from './ops-hooks';
import { pubError } from '../../../lib/publisher/common-api';

export function BackupsSection({ query }: PublisherSectionProps) {
  const { o, reports, pid, can } = useOps();
  const state = useAsync(
    () =>
      can('backup.manage')
        ? reports.backups(pid)
        : Promise.resolve([] as BackupView[]),
    [pid]
  );
  const m = useMutation();
  const [restore, setRestore] = useState<RestoreView | null>(null);
  const disabled =
    pubError(m.error ?? state.error)?.code === 'PUB_NOT_IMPLEMENTED';
  const f = useListFilters('backups', query, ['status']);
  const status = f.values.status;
  return (
    <div className="space-y-4">
      <ScreenTitle>{o.backups.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{o.backups.intro}</p>
      {!can('backup.manage') && !can('restore.apply') ? (
        <NoPermission />
      ) : (
        <>
          {disabled && <Alert tone="warning">{o.backups.disabled}</Alert>}
          <ListToolbar
            statuses={BACKUP_STATUSES}
            status={status}
            onStatus={(v) => f.set('status', v)}
            statusLabels={o.backups.statuses}
            csvPath={`products/${pid}/backups`}
            extra={
              <span className="text-xs text-silver-500">
                {o.common.noOwnerField}
              </span>
            }
          />
          <Section
            title={o.nav.backups}
            action={
              can('backup.manage') ? (
                <Button
                  loading={m.busy}
                  onClick={async () => {
                    const x = await m.run((k) => reports.createBackup(pid, k));
                    if (x) state.reload();
                  }}
                >
                  {o.backups.create}
                </Button>
              ) : undefined
            }
          >
            <PubErrorAlert error={m.error} />
            <Loadable state={state}>
              {(list) =>
                list.filter((b) => !status || b.status === status).length ===
                0 ? (
                  <div className="text-sm text-silver-500">
                    {o.backups.empty}
                  </div>
                ) : (
                  <ul>
                    {list
                      .filter((b) => !status || b.status === status)
                      .map((b) => (
                        <BackupRow key={b.id} b={b} onRestore={setRestore} />
                      ))}
                  </ul>
                )
              }
            </Loadable>
          </Section>
          {restore && <RestorePanel initial={restore} />}
        </>
      )}
    </div>
  );
}

function BackupRow({
  b,
  onRestore,
}: {
  b: BackupView;
  onRestore: (r: RestoreView) => void;
}) {
  const { o, reports, pid, can } = useOps();
  const m = useMutation();
  const [target, setTarget] = useState('');
  const rows = Object.values(b.tableCounts).reduce((a, n) => a + n, 0);
  return (
    <ListRow
      title={
        <>
          <DateText iso={b.createdAt} time /> · {o.backups.kinds[b.kind]}
        </>
      }
      badges={<StatusBadge status={b.status} labels={o.backups.statuses} />}
    >
      <div>
        {fmtText(o.backups.size, { v: b.sizeBytes })} ·{' '}
        {fmtText(o.backups.tables, {
          n: Object.keys(b.tableCounts).length,
          rows,
        })}{' '}
        · {fmtText(o.backups.keyVersion, { v: b.keyVersion })}
      </div>
      <div>
        {fmtText(o.backups.rotationUntil, { at: b.rotationUntil.slice(0, 10) })}{' '}
        · <code className="break-all">{b.sha256.slice(0, 16)}…</code>
      </div>
      {b.status === 'ok' && (
        <div className="flex flex-wrap gap-2 pt-1">
          {can('restore.dry_run') && (
            <Button
              variant="outline"
              loading={m.busy}
              onClick={async () => {
                const x = await m.run(
                  (k) => reports.restore(pid, b.id, k, { mode: 'dry_run' }),
                  'dry_run'
                );
                if (x) onRestore(x);
              }}
            >
              {o.backups.dryRun}
            </Button>
          )}
          {can('restore.apply') && (
            <ActionBlock title={o.backups.apply}>
              <p>{o.backups.applyHint}</p>
              <Field label={o.backups.targetSiteId}>
                <TextInput
                  value={target}
                  onChange={(v) => setTarget(v.trim())}
                />
              </Field>
              <ConfirmButton
                loading={m.busy}
                disabled={!target}
                onConfirm={async () => {
                  const x = await m.run(
                    (k) =>
                      reports.restore(pid, b.id, k, {
                        mode: 'apply_new_product',
                        targetSiteId: target,
                      }),
                    `apply:${target}`
                  );
                  if (x) onRestore(x);
                }}
              >
                {o.backups.apply}
              </ConfirmButton>
            </ActionBlock>
          )}
        </div>
      )}
      <PubErrorAlert error={m.error} />
    </ListRow>
  );
}

/** Статус восстановления: опрос, пока `running`. */
function RestorePanel({ initial }: { initial: RestoreView }) {
  const { o, reports, pid } = useOps();
  const [r, setR] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setR(initial), [initial]);
  useEffect(() => {
    if (r.status !== 'running') return;
    const t = setTimeout(() => {
      reports.restoreStatus(pid, r.id).then(setR, setError);
    }, 3000);
    return () => clearTimeout(t);
  }, [r, pid, reports]);
  return (
    <Section title={o.backups.restore}>
      <div className="flex flex-wrap gap-1">
        <Badge>{o.backups.modes[r.mode]}</Badge>
        <StatusBadge status={r.status} labels={o.backups.restoreStatuses} />
      </div>
      <Row label={o.common.when}>
        <DateText iso={r.updatedAt} time />
      </Row>
      {r.targetProductId && <Row label="productId">{r.targetProductId}</Row>}
      <PubErrorAlert error={error} />
      <div className="text-xs text-silver-500">{o.backups.report}</div>
      <JsonView value={r.report} />
      <Button
        variant="outline"
        onClick={() => reports.restoreStatus(pid, r.id).then(setR, setError)}
      >
        {o.backups.refresh}
      </Button>
    </Section>
  );
}
