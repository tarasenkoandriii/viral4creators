import { KeyRound } from 'lucide-react';
import { canManage, useKit } from '../kit';
import { Button } from '../kit/ui';
import { navigate } from '../lib/router';

/**
 * Э-С Ш2: вход на экран «Тестовые учётные записи» сайта из карточки сайта.
 * Только владельцу и менеджеру — оператору сервер всё равно ответил бы 403.
 */
export function TestAccountsButton({ siteId }: { siteId: string }) {
  const { account, dict } = useKit();
  if (!canManage(account.me.role)) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        icon={<KeyRound size={16} />}
        onClick={() => navigate({ name: 'test-accounts', siteId })}
      >
        {dict.testAccounts.open}
      </Button>
    </div>
  );
}
