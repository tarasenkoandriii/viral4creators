import { Briefcase, MessageSquare } from 'lucide-react';
import { useKit } from '../../kit';
import { Button } from '../../kit/ui';
import { navigate } from '../../lib/router';
import { isAdminOwner, useAdminTexts } from '../../lib/admin-mode-view';

/**
 * Э7: вход в «Админку» из карточки сайта. Владелец «Админки» — кабинет
 * режима и чат; сотрудник (`assistAdmin: employee`) — только чат (7a);
 * остальным кнопок нет (сервер всё равно 403).
 */
export function AdminModeButton({ siteId }: { siteId: string }) {
  const { account } = useKit();
  const t = useAdminTexts();
  const owner = isAdminOwner(account.me);
  const employee = account.me.productRoles.assistAdmin === 'employee';
  if (!owner && !employee) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {owner && (
        <Button
          variant="outline"
          icon={<Briefcase size={16} />}
          onClick={() =>
            navigate({ name: 'admin-mode', siteId, tab: 'settings' })
          }
        >
          {t.open}
        </Button>
      )}
      <Button
        variant="outline"
        icon={<MessageSquare size={16} />}
        onClick={() => navigate({ name: 'admin-chat', siteId })}
      >
        {t.openChat}
      </Button>
    </div>
  );
}
