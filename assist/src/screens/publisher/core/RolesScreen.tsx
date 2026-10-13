import { useState } from 'react';
import { useAsync, useKit } from '../../../kit';
import { Badge, Button } from '../../../kit/ui';
import { PUB_ROLES, type PubRole } from '../../../lib/publisher/permissions';
import { fmtText } from '../../../lib/publisher/view';
import { useMutation, usePubApis } from '../hooks';
import {
  ConfirmButton,
  DateText,
  EmptyState,
  Field,
  Loadable,
  NoPermission,
  Notice,
  PubErrorAlert,
  Section,
  Select,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';

/**
 * Роли продукта (§14.1 RolesScreen, §4.1): гранты `pub_role_grants`,
 * выдача и отзыв — только администратор Publisher. Отзыв действует со
 * следующего запроса (AT-CORE-11, решает сервер).
 */
export function RolesScreen() {
  const { product, t, can, roles } = usePublisher();
  const { account } = useKit();
  const apis = usePubApis();
  const list = useAsync(
    async () => (can('role.manage') ? apis.core.roles(product.id) : null),
    [apis, product.id]
  );
  const [showRevoked, setShowRevoked] = useState(false);
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState<PubRole | ''>('editor');
  const [displayName, setDisplayName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const grant = useMutation();
  const members = (account.members ?? []).filter((m) => m.memberId);

  const mine = roles.accountOwner
    ? t.roles.accountOwner
    : [
        ...roles.roles.map((r) => t.roles.names[r]),
        ...(roles.admin ? [t.roles.names.admin] : []),
      ].join(', ') || t.roles.noRoles;

  return (
    <div className="space-y-4">
      <Section title={t.roles.title}>
        <p className="text-xs text-silver-500">{t.roles.hint}</p>
        <div className="text-sm">{fmtText(t.roles.mine, { list: mine })}</div>
      </Section>
      {!can('role.manage') ? (
        <NoPermission>{t.roles.onlyAdmin}</NoPermission>
      ) : (
        <>
          <Section title={t.roles.grant}>
            <Notice text={notice} />
            {members.length > 0 ? (
              <Field label={t.roles.member}>
                <select
                  className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
                  value={memberId}
                  onChange={(e) => setMemberId(e.target.value)}
                >
                  <option value="">—</option>
                  {members.map((m) => (
                    <option key={m.memberId} value={m.memberId}>
                      {fmtText(t.roles.memberLabel, {
                        id: m.telegramId,
                        role: m.productRoles.publisher ?? 'none',
                      })}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label={t.roles.memberId} hint={t.roles.noMembers}>
                <TextInput value={memberId} onChange={setMemberId} />
              </Field>
            )}
            <Field label={t.roles.role}>
              <Select
                value={role}
                options={PUB_ROLES}
                labels={t.roles.names}
                onChange={setRole}
              />
            </Field>
            <Field label={t.roles.displayName}>
              <TextInput
                value={displayName}
                onChange={setDisplayName}
                maxLength={80}
              />
            </Field>
            <PubErrorAlert error={grant.error} onReload={list.reload} />
            <Button
              loading={grant.busy}
              disabled={!memberId.trim() || !role}
              onClick={async () => {
                if (!role) return;
                const r = await grant.run((k) =>
                  apis.core.grant(
                    product.id,
                    {
                      memberId: memberId.trim(),
                      role,
                      ...(displayName.trim()
                        ? { displayName: displayName.trim() }
                        : {}),
                    },
                    k
                  )
                );
                if (r) {
                  setNotice(t.roles.granted);
                  list.reload();
                }
              }}
            >
              {t.roles.grant}
            </Button>
          </Section>
          <Section
            title={t.roles.title}
            action={
              <label className="text-xs flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={showRevoked}
                  onChange={(e) => setShowRevoked(e.target.checked)}
                />
                {t.roles.showRevoked}
              </label>
            }
          >
            <Loadable state={list}>
              {(items) => {
                const rows = (items ?? []).filter(
                  (g) => showRevoked || g.active
                );
                return rows.length ? (
                  <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                    {rows.map((g) => (
                      <GrantRow key={g.id} grant={g} onChanged={list.reload} />
                    ))}
                  </ul>
                ) : (
                  <EmptyState />
                );
              }}
            </Loadable>
          </Section>
        </>
      )}
    </div>
  );
}

function GrantRow({
  grant,
  onChanged,
}: {
  grant: Awaited<
    ReturnType<ReturnType<typeof usePubApis>['core']['roles']>
  >[number];
  onChanged: () => void;
}) {
  const { product, t } = usePublisher();
  const apis = usePubApis();
  const [reason, setReason] = useState('');
  const m = useMutation();
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{grant.memberDisplayName}</span>
        <Badge tone="accent">{t.roles.names[grant.role]}</Badge>
        <Badge tone={grant.active ? 'neutral' : 'danger'}>
          {grant.active ? t.roles.active : t.roles.inactive}
        </Badge>
      </div>
      <div className="text-xs text-silver-500">
        {grant.grantedBy} · <DateText iso={grant.grantedAt} time />
        {grant.revokedAt && (
          <>
            {' '}
            · {t.roles.inactive}: <DateText iso={grant.revokedAt} time />{' '}
            {grant.reason ? `(${grant.reason})` : ''}
          </>
        )}
      </div>
      {grant.active && (
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            value={reason}
            onChange={setReason}
            placeholder={t.roles.revokeReason}
            maxLength={500}
          />
          <ConfirmButton
            loading={m.busy}
            disabled={!reason.trim()}
            onConfirm={async () => {
              const r = await m.run((k) =>
                apis.core.revoke(product.id, grant.id, reason.trim(), k)
              );
              if (r) onChanged();
            }}
          >
            {t.roles.revoke}
          </ConfirmButton>
        </div>
      )}
      <PubErrorAlert error={m.error} onReload={onChanged} />
    </li>
  );
}
