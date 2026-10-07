import { useEffect, useState } from 'react';
import { Globe, Plus } from 'lucide-react';
import { canManage, errorText, fmt, useAsync, useKit } from '../kit';
import { Alert, Button, Card, ScreenTitle, Spinner } from '../kit/ui';
import { AccountContextNote } from '../kit/ui/AccountContextNote';
import { AddSiteScreen } from '../kit/screens/AddSiteScreen';
import { useAssist } from '../lib/assist-context';
import { navigate } from '../lib/router';
import { verifyHostPlan } from '../lib/verify-host-view';

/**
 * Ш1-хвост: запуск из обучалки «подтвердить ЭТОТ хост»
 * (`startapp=vh-<base64url(хост)>`, хост уже строго проверен разбором).
 * Хост есть у сайта кабинета — сразу экран подтверждения этого хоста
 * (проверку DNS/файла/мета запускает человек кнопкой); нет — добавить к
 * своему сайту или мастер нового сайта с этим хостом. Ничего не
 * подтверждается и не создаётся без нажатия.
 */
export function VerifyHostScreen({ host }: { host: string }) {
  const { api, account, dict } = useKit();
  const { appDict } = useAssist();
  const t = appDict.verifyHost;
  const sites = useAsync(() => api.listSites(), [api]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = sites.data ? verifyHostPlan(sites.data, host) : null;

  // Хост уже у сайта — экран его подтверждения (замена: «Назад» не вернёт
  // сюда же, иначе снова переадресация).
  const open = plan?.kind === 'open' ? `${plan.siteId}/${plan.hostId}` : null;
  useEffect(() => {
    if (!open) return;
    const [siteId, hostId] = open.split('/');
    navigate({ name: 'host', siteId, hostId }, true);
  }, [open]);

  if (sites.loading || plan?.kind === 'open') {
    return <Spinner label={dict.common.loading} />;
  }
  if (sites.error || !plan) {
    return (
      <Alert tone="danger" title={dict.common.error}>
        {sites.error ? errorText(sites.error, dict) : dict.common.error}
        <div className="mt-2">
          <Button variant="outline" onClick={sites.reload}>
            {dict.common.retry}
          </Button>
        </div>
      </Alert>
    );
  }
  if (!canManage(account.me.role)) {
    return (
      <Alert tone="warning">{dict.errors.api.ACCOUNT_ROLE_REQUIRED}</Alert>
    );
  }
  if (plan.kind === 'create' || creating) {
    return (
      <div className="space-y-3">
        <Alert tone="accent">{fmt(t.createHint, { host })}</Alert>
        <AddSiteScreen
          initialHost={host}
          onCreated={(siteId) => navigate({ name: 'site', siteId }, true)}
          onCancel={() =>
            plan.kind === 'create' ? window.history.back() : setCreating(false)
          }
        />
      </div>
    );
  }

  async function addTo(siteId: string) {
    setBusy(siteId);
    setError(null);
    try {
      const h = await api.addHost(siteId, `https://${host}`);
      navigate({ name: 'host', siteId, hostId: h.id }, true);
    } catch (e) {
      setError(errorText(e, dict));
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <AccountContextNote />
      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-accent shrink-0" />
          <span className="font-mono break-all">https://{host}</span>
        </div>
        <p className="text-sm">{t.notFound}</p>
        <p className="text-xs text-silver-500">{t.otherAccount}</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="space-y-2">
          {plan.sites.map((s) => (
            <Button
              key={s.id}
              variant="outline"
              block
              icon={<Plus size={16} />}
              loading={busy === s.id}
              disabled={busy !== null}
              onClick={() => void addTo(s.id)}
            >
              {fmt(t.addTo, { name: s.name || s.id })}
            </Button>
          ))}
          <Button
            block
            icon={<Plus size={16} />}
            disabled={busy !== null}
            onClick={() => setCreating(true)}
          >
            {t.newSite}
          </Button>
        </div>
      </Card>
    </div>
  );
}
