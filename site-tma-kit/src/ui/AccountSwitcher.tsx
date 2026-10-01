import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { shortAccountId } from '../account-select';

/**
 * Выбор кабинета — только если их больше одного (свой + агентства).
 * Смена уходит на сервер заголовком `X-Site-Account` (api-client).
 */
export function AccountSwitcher({
  onSwitch,
}: {
  onSwitch: (accountId: string) => void;
}) {
  const { account, dict } = useKit();
  if (account.accounts.length < 2) return null;
  return (
    <select
      aria-label={dict.account.label}
      value={account.account.id}
      onChange={(e) => onSwitch(e.target.value)}
      className="max-w-[12rem] rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-2 py-1 text-sm min-h-[36px]"
    >
      {account.accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {fmt(dict.account.item, {
            id: shortAccountId(a.id),
            role: dict.members.roles[a.role],
          })}
        </option>
      ))}
    </select>
  );
}
