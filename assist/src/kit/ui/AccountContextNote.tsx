/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/ui/AccountContextNote.tsx */
import { AlertTriangle, Building2 } from 'lucide-react';
import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { accountContext } from '../account-select';
import { Alert } from './index';

/**
 * В каком кабинете действие (аудит Н-1): на экранах добавления сайта и
 * подтверждения хоста — рядом с токеном кабинета. Чужой кабинет (человек
 * менеджер/оператор) — предупреждение: подтверждение домена, сайты и
 * тестовые учётки с паролями достаются владельцу ЭТОГО кабинета.
 */
export function AccountContextNote() {
  const { account, dict } = useKit();
  const ctx = accountContext(account);
  if (ctx.own) {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-silver-500">
        <Building2 size={14} className="shrink-0" />
        {fmt(dict.account.ownContext, { id: ctx.label })}
      </p>
    );
  }
  return (
    <Alert
      tone="warning"
      title={fmt(dict.account.foreignContext, {
        id: ctx.label,
        role: dict.members.roles[ctx.role],
      })}
    >
      <span className="inline-flex items-start gap-2">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <span>{dict.account.foreignWarning}</span>
      </span>
    </Alert>
  );
}
