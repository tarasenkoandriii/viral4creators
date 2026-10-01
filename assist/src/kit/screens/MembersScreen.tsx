/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/screens/MembersScreen.tsx */
import { User, UserPlus } from 'lucide-react';
import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { Alert, Badge, Button, Card, ScreenTitle } from '../ui';

/**
 * «Участники и роли». Список целиком сервер отдаёт только владельцу и
 * менеджеру; оператор видит себя. Пригласить может только владелец
 * (`POST /sites/account/invites` — гвард `owner`).
 */
export function MembersScreen({ onInvite }: { onInvite?: () => void }) {
  const { dict, account } = useKit();
  const t = dict.members;
  const list = account.members ?? [account.me];
  const isOwner = account.me.role === 'owner';
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
      <Card>
        <ul className="divide-y divide-silver-200 dark:divide-silver-800">
          {list.map((m) => (
            <li key={m.telegramId} className="py-2 flex items-center gap-2">
              <User size={18} className="text-silver-400" />
              <span className="flex-1 min-w-0 truncate">
                {fmt(t.telegramId, { id: m.telegramId })}
                {m.telegramId === account.me.telegramId && (
                  <span className="text-silver-500"> · {t.you}</span>
                )}
              </span>
              <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'}>
                {t.roles[m.role]}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
