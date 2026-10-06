import { useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import type { Dictionary } from '../dictionaries/ru';
import type { Locale } from '../i18n';
import { errorText } from '../errors';
import { formatDate } from '../format';
import { useAsync } from '../use-async';
import type { InvitePreview } from '../types';
import { Alert, Button, Card, ScreenTitle, Spinner } from '../ui';

/**
 * Экран подтверждения приглашения (аудит Н-1). Раньше ссылка
 * `startapp=inv_…`/`?invite=` принималась сама при открытии и молча
 * переключала человека в чужой кабинет — жертва, думая, что она у себя,
 * подтверждала там свой домен и заводила тестовые учётки с паролями.
 *
 * Теперь: превью сервера (кто зовёт, в какой кабинет, с какой ролью, до
 * какого срока), явное «это НЕ ваш кабинет» и две кнопки. «Принять» —
 * только когда превью получено. Экран живёт ДО загрузки кабинета (новичку
 * его ещё не создали), поэтому берёт словарь и API пропсами, не из
 * KitContext.
 */
export function InviteAcceptScreen({
  dict,
  locale,
  loadPreview,
  onAccept,
  onDecline,
}: {
  dict: Dictionary;
  locale: Locale;
  /** `api.invitePreview(token)` — ничего не принимает. */
  loadPreview: () => Promise<InvitePreview>;
  /** `POST …/invites/accept`; ошибки показывает вызывающий. */
  onAccept: () => Promise<void>;
  onDecline: () => void;
}) {
  const t = dict.inviteAccept;
  const preview = useAsync(loadPreview, [loadPreview]);
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    try {
      await onAccept();
    } finally {
      setBusy(false);
    }
  }

  if (preview.loading && !preview.data) {
    return <Spinner label={t.loading} />;
  }
  if (preview.error || !preview.data) {
    return (
      <div className="space-y-4">
        <ScreenTitle>{t.title}</ScreenTitle>
        <Alert tone="danger" title={dict.common.error}>
          {preview.error ? errorText(preview.error, dict) : dict.common.error}
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={preview.reload}>
            {dict.common.retry}
          </Button>
          <Button variant="ghost" onClick={onDecline}>
            {t.close}
          </Button>
        </div>
      </div>
    );
  }

  const p = preview.data;
  const inviter = p.inviter
    ? [
        p.inviter.username ? `@${p.inviter.username}` : null,
        p.inviter.firstName,
      ]
        .filter(Boolean)
        .join(' · ')
    : t.inviterUnknown;
  const rows: Array<[string, string]> = [
    [t.account, `…${p.account.tail} · ${t.types[p.account.type]}`],
    [t.inviter, inviter],
    [t.role, dict.members.roles[p.role]],
  ];
  if (p.productRoles.assistAdmin !== 'none') {
    rows.push([
      dict.invite.adminLabel,
      dict.invite.adminRoles[p.productRoles.assistAdmin],
    ]);
  }
  if (p.expiresAt) rows.push([t.expires, formatDate(p.expiresAt, locale)]);

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>

      <Card className="space-y-2">
        <dl className="space-y-2 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex flex-wrap gap-x-2">
              <dt className="text-silver-500">{k}:</dt>
              <dd className="font-medium break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {p.alreadyMember ? (
        <Alert tone="neutral">{t.alreadyMember}</Alert>
      ) : (
        <Alert tone="warning" title={t.warningTitle}>
          <span className="inline-flex items-start gap-2">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>{t.warning}</span>
          </span>
        </Alert>
      )}
      <p className="text-xs text-silver-500">
        {t.stays} {t.unsure}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          icon={<X size={16} />}
          disabled={busy}
          onClick={onDecline}
        >
          {t.decline}
        </Button>
        <Button icon={<Check size={16} />} loading={busy} onClick={accept}>
          {t.accept}
        </Button>
      </div>
    </div>
  );
}
