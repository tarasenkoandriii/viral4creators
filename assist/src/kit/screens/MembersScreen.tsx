/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/screens/MembersScreen.tsx */
import { useEffect, useState } from 'react';
import { User, UserPlus } from 'lucide-react';
import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { ApiError } from '../envelope';
import { errorText } from '../errors';
import {
  isMemberErrorCode,
  memberActions,
  memberRolePatch,
  type InviteRole,
} from '../invite';
import type { AccountMember } from '../types';
import { Alert, Badge, Button, Card, ScreenTitle, inputClass } from '../ui';

/**
 * «Участники и роли». Список целиком сервер отдаёт только владельцу и
 * менеджеру; оператор видит себя. Пригласить может только владелец
 * (`POST /sites/account/invites` — гвард `owner`).
 *
 * Э3: владелец меняет роль (менеджер/оператор — вместе с правами продукта,
 * как в приглашении) и удаляет участника; любой не-владелец может выйти
 * сам. Необратимое — двойным нажатием (не `window.confirm`: в части
 * WebView Telegram он заблокирован). Сервер отвечает кабинетом целиком —
 * список обновляется перезагрузкой кабинета.
 */
export function MembersScreen({ onInvite }: { onInvite?: () => void }) {
  const { dict, account, api, app, reloadAccount } = useKit();
  const t = dict.members;
  const list = account.members ?? [account.me];
  const isOwner = account.me.role === 'owner';
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
    e instanceof ApiError && isMemberErrorCode(e.code)
      ? t.errors[e.code]
      : errorText(e, dict);

  async function run(
    memberId: string,
    job: () => Promise<unknown>,
    ok: string
  ) {
    setBusy(memberId);
    setNotice(null);
    try {
      await job();
      setNotice({ tone: 'success', text: ok });
      reloadAccount();
    } catch (e) {
      setNotice({ tone: 'danger', text: failText(e) });
    } finally {
      setBusy(null);
    }
  }

  function changeRole(m: AccountMember, role: InviteRole) {
    if (!m.memberId || role === m.role) return;
    const id = m.memberId;
    void run(
      id,
      () =>
        api.patchMember(
          id,
          memberRolePatch(app, role, m.productRoles.assistAdmin)
        ),
      t.roleSaved
    );
  }

  function remove(m: AccountMember, self: boolean) {
    if (!m.memberId) return;
    const id = m.memberId;
    if (armed !== id) {
      setArmed(id);
      return;
    }
    setArmed(null);
    void run(id, () => api.removeMember(id), self ? t.left : t.removed);
  }

  return (
    <div className="space-y-4">
      <ScreenTitle
        action={
          isOwner && onInvite ? (
            <Button icon={<UserPlus size={16} />} onClick={onInvite}>
              {t.invite}
            </Button>
          ) : undefined
        }
      >
        {t.title}
      </ScreenTitle>
      {account.members === null && (
        <Alert tone="neutral">{t.onlyManagers}</Alert>
      )}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <ul className="divide-y divide-silver-200 dark:divide-silver-800">
          {list.map((m) => {
            const self = m.telegramId === account.me.telegramId;
            const can = memberActions(account.me, m);
            return (
              <li key={m.telegramId} className="py-2 space-y-2">
                <div className="flex items-center gap-2">
                  <User size={18} className="text-silver-400" />
                  <span className="flex-1 min-w-0 truncate">
                    {fmt(t.telegramId, { id: m.telegramId })}
                    {self && (
                      <span className="text-silver-500"> · {t.you}</span>
                    )}
                  </span>
                  <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'}>
                    {t.roles[m.role]}
                  </Badge>
                </div>
                {(can.changeRole || can.remove || can.leave) && (
                  <div className="flex flex-wrap items-center gap-2 pl-7">
                    {can.changeRole && m.role !== 'owner' && (
                      <label className="flex items-center gap-2 text-sm">
                        <span className="text-silver-500">{t.changeRole}</span>
                        <select
                          className={`${inputClass} w-auto`}
                          value={m.role}
                          disabled={busy === m.memberId}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === 'manager' || v === 'operator') {
                              changeRole(m, v);
                            }
                          }}
                        >
                          <option value="manager">{t.roles.manager}</option>
                          <option value="operator">{t.roles.operator}</option>
                        </select>
                      </label>
                    )}
                    {(can.remove || can.leave) && (
                      <Button
                        variant={armed === m.memberId ? 'danger' : 'outline'}
                        loading={busy === m.memberId}
                        onClick={() => remove(m, self)}
                      >
                        {armed === m.memberId
                          ? t.confirm
                          : can.leave
                            ? t.leave
                            : t.remove}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
