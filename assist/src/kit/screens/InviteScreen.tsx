/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/screens/InviteScreen.tsx */
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { formatDate } from '../format';
import { errorText } from '../errors';
import {
  inviteProductRoles,
  telegramInviteLink,
  webInviteLink,
  type AdminRole,
  type InviteRole,
} from '../invite';
import { Alert, Button, Card, CopyField, ScreenTitle } from '../ui';
import type { Invite } from '../types';

/** «Пригласить участника» — только владелец кабинета. */
export function InviteScreen() {
  const { api, dict, app, links, locale } = useKit();
  const t = dict.invite;
  const [role, setRole] = useState<InviteRole>('operator');
  const [admin, setAdmin] = useState<AdminRole>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setInvite(
        await api.createInvite(role, inviteProductRoles(app, role, admin))
      );
    } catch (e) {
      setError(errorText(e, dict));
    } finally {
      setBusy(false);
    }
  }

  const copy = { copyLabel: dict.common.copy, copiedLabel: dict.common.copied };

  if (invite) {
    return (
      <div className="space-y-4">
        <ScreenTitle>{t.title}</ScreenTitle>
        <Alert tone="warning">{t.once}</Alert>
        <Card className="space-y-3">
          {links.botUsername ? (
            <CopyField
              label={t.tgLink}
              value={telegramInviteLink(links.botUsername, invite.startParam)}
              {...copy}
            />
          ) : (
            <p className="text-xs text-silver-500">{t.noBot}</p>
          )}
          <CopyField
            label={t.webLink}
            value={webInviteLink(links.webUrl, invite.startParam)}
            {...copy}
          />
          {invite.expiresAt && (
            <p className="text-xs text-silver-500">
              {fmt(t.expires, { date: formatDate(invite.expiresAt, locale) })}
            </p>
          )}
        </Card>
        <Button variant="outline" onClick={() => setInvite(null)}>
          {t.another}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <Card className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">{t.roleLabel}</legend>
          {(['manager', 'operator'] as const).map((r) => (
            <label key={r} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="invite-role"
                className="mt-1"
                checked={role === r}
                onChange={() => setRole(r)}
              />
              <span>
                <span className="font-medium">{dict.members.roles[r]}</span>
                <span className="block text-xs text-silver-500">
                  {t.roleHints[r]}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {app === 'assist' && (
          <label className="block">
            <span className="text-sm font-medium">{t.adminLabel}</span>
            <select
              value={admin}
              onChange={(e) => setAdmin(e.target.value as AdminRole)}
              className="mt-1 w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px]"
            >
              {(['none', 'employee', 'owner'] as const).map((a) => (
                <option key={a} value={a}>
                  {t.adminRoles[a]}
                </option>
              ))}
            </select>
          </label>
        )}
      </Card>
      <Alert tone="accent">{t.agencyWarning}</Alert>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button
        block
        icon={<UserPlus size={16} />}
        loading={busy}
        onClick={create}
      >
        {t.create}
      </Button>
    </div>
  );
}
