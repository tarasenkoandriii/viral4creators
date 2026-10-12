/**
 * Заход 13 (Р-З13-Б1; хвост захода 11, Р-З11-А2-11): «Роли» «Админки» —
 * «сопоставить мою роль у заказчика с ролью помощника owner». Без такой
 * пары TMA не выдаёт ссылку редактора карты «Админки» (409
 * `ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED`); подсказка в разделе карты ведёт
 * сюда (`#/sites/:id/admin-mode/roles`). Сервер меняет одну пару (прочие
 * не трогает) и пишет строку в журнал «Админки».
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, fmt, useKit } from '../../kit';
import { Alert, Button, inputClass } from '../../kit/ui';
import { OWNER_ROLE_TEXTS } from '../../i18n/owner-role';
import { useAdminErrorText } from '../../lib/admin-mode-view';
import {
  ownerRoleAction,
  ownerRoleKeys,
  type AdminModeView,
} from '../../lib/admin-mode-api';
import { useAssist } from '../../lib/assist-context';
import { navigate } from '../../lib/router';
import { ConfirmButton, NoticeBar, type Notice } from '../knowledge/parts';

export function AdminOwnerRole({
  siteId,
  roleMap,
  focus,
  onChanged,
}: {
  siteId: string;
  roleMap: Record<string, string>;
  focus?: 'roles';
  /**
   * Пара сохранена (или уже была) — экран перечитывается. `true` — у
   * владельца была несохранённая правка текста карты ролей, пара дописана
   * в неё (аудит P3-7).
   */
  onChanged: (view: AdminModeView | null, role: string | null) => boolean;
}) {
  const { adminMode } = useAssist();
  const { locale } = useKit();
  const t = OWNER_ROLE_TEXTS[locale];
  const errText = useAdminErrorText();
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focus === 'roles') ref.current?.scrollIntoView({ block: 'center' });
  }, [focus]);

  const owners = ownerRoleKeys(roleMap);
  const plan = ownerRoleAction(roleMap, role);
  const submit = async () => {
    const r = role.trim();
    if (plan.kind === 'invalid') {
      setNotice({ tone: 'danger', text: t.bad });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      // Аудит P3-6: значение пары, которое видел экран (подтверждение
      // замены строилось по нему).
      const res = await adminMode.mapOwnerRole(siteId, r, plan.current);
      const kept = onChanged(res.view, r);
      setNotice({
        tone: 'success',
        text: [fmt(res.changed ? t.done : t.already, { r }), kept && t.kept]
          .filter(Boolean)
          .join(' '),
      });
      setDone(true);
      setRole('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ADMIN_ROLEMAP_CHANGED') {
        setNotice({ tone: 'warning', text: t.changed });
        onChanged(null, null);
      } else setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      id="admin-roles"
      className={`space-y-2 rounded-lg border p-2 text-sm ${
        focus === 'roles'
          ? 'border-amber-400 ring-2 ring-amber-300'
          : 'border-silver-200 dark:border-silver-800'
      }`}
    >
      <div className="font-semibold">{t.title}</div>
      <p className="text-xs text-silver-500">{t.intro}</p>
      {owners.length ? (
        <Alert tone="success">
          {fmt(t.mapped, { r: owners.map((k) => `«${k}»`).join(', ') })}
        </Alert>
      ) : (
        <Alert tone="warning">{t.none}</Alert>
      )}
      <NoticeBar notice={notice} />
      <div className="text-xs text-silver-500">{t.role}</div>
      <div className="flex flex-wrap items-start gap-2">
        <input
          className={`${inputClass} max-w-xs`}
          value={role}
          maxLength={64}
          placeholder={t.placeholder}
          aria-invalid={role.trim() !== '' && plan.kind === 'invalid'}
          onChange={(e) => setRole(e.target.value)}
        />
        {plan.kind === 'replace' ? (
          <ConfirmButton
            variant="solid"
            loading={busy}
            hint={fmt(t.replaceHint, { r: role.trim(), v: plan.current ?? '' })}
            onConfirm={() => void submit()}
          >
            {t.map}
          </ConfirmButton>
        ) : (
          <Button
            loading={busy}
            disabled={!role.trim()}
            onClick={() => void submit()}
          >
            {t.map}
          </Button>
        )}
      </div>
      {role.trim() !== '' && plan.kind === 'invalid' && (
        <div className="text-xs text-red-600">{t.bad}</div>
      )}
      {done && (
        <Button
          variant="ghost"
          onClick={() => navigate({ name: 'admin-mode', siteId, tab: 'voice' })}
        >
          {t.toVoice}
        </Button>
      )}
    </div>
  );
}
